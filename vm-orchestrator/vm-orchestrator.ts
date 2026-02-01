import { spawn, ChildProcess } from "child_process"
import { writeFile, unlink, access, open, FileHandle, mkdir } from "fs/promises"
import { VMConfig, VMSession } from "./types"
import {
    generateFirecrackerConfig,
    getSocketPath,
    getVsockPath,
    getLogPath,
    getConsoleLogPath,
    getLogDir,
    getSocketDir
} from "./firecracker-config"
import { SessionManager } from "./session-manager"
import type { MetricsType } from "./metrics"
import {
    FIRECRACKER_BIN,
    FIRECRACKER_KERNEL,
    FIRECRACKER_ROOTFS,
    DEFAULT_VM_MEMORY_MB,
    DEFAULT_VM_VCPU_COUNT,
    ENABLE_VERBOSE_BOOT_LOGS,
    ENABLE_VERBOSE_STARTUP_LOGS
} from "./config"
import { getOrCreateOverlayDisk } from "./overlay-disk"
import { stopAllPortForwards } from "./port-forward"
import { setupBridge, networkManager } from "./network-manager"

// Hoisted helper functions - Security validation
function validateProjectId(projectId: string): void {
    if (!projectId || typeof projectId !== "string") {
        throw new Error("Invalid projectId: must be non-empty string")
    }
    // Only allow alphanumeric, hyphens, underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
        throw new Error("Invalid projectId: contains illegal characters")
    }
    if (projectId.length > 100) {
        throw new Error("Invalid projectId: too long")
    }
}

function generateVMId(): string {
    return `vm-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

async function killProcess(pid: number): Promise<void> {
    try {
        process.kill(pid, "SIGTERM")
        await new Promise((resolve) => setTimeout(resolve, 1000))
        try {
            process.kill(pid, 0) // Check if still alive
            process.kill(pid, "SIGKILL") // Force kill
        } catch {
            // Process already dead
        }
    } catch {
        // Process doesn't exist or already killed
    }
}

// Hoisted helper - optional startup timing logs
function logStartupStep(step: string, timing: { last: number }): void {
    if (ENABLE_VERBOSE_STARTUP_LOGS) {
        const elapsed = Date.now() - timing.last
        console.log(`⏱️ [VMOrchestrator] ${step} (${elapsed}ms)`)
    }
    timing.last = Date.now()
}

// Hoisted helper - Initialize bridge once (shared across all orchestrators)
let bridgeInitialized = false
async function ensureBridgeInitialized() {
    if (!bridgeInitialized) {
        await setupBridge()
        bridgeInitialized = true
    }
}

// Hoisted helper - Centralized cleanup for VM resources
async function cleanupVMResources(
    vmId: string,
    options: {
        process?: ChildProcess
        tapDevice?: boolean
        configFile?: boolean
        socketAndLogs?: boolean
        vmProcesses?: Map<string, ChildProcess>
        portForwards?: boolean
        consoleLogFd?: FileHandle | null
    }
): Promise<void> {
    // Stop all port forwards for this VM (prevents orphaned listeners)
    if (options.portForwards) {
        try {
            stopAllPortForwards(vmId)
        } catch (error) {
            console.error(`[VMOrchestrator] Failed to stop port forwards:`, error)
        }
    }

    // Close console log file descriptor (prevents file descriptor leak)
    if (options.consoleLogFd) {
        try {
            await options.consoleLogFd.close()
        } catch (error) {
            console.error(`[VMOrchestrator] Failed to close console log fd:`, error)
        }
    }

    // Kill process
    if (options.process) {
        try {
            options.process.kill("SIGKILL")
            if (options.vmProcesses) {
                options.vmProcesses.delete(vmId)
            }
        } catch (error) {
            console.error(`[VMOrchestrator] Failed to kill process:`, error)
        }
    }

    // Remove TAP device
    if (options.tapDevice) {
        try {
            await networkManager.removeTapDevice(vmId)
            console.log(`[VMOrchestrator] Cleaned up TAP device`)
        } catch (error) {
            console.error(`[VMOrchestrator] Failed to remove TAP device:`, error)
        }
    }

    // Delete socket and log files
    if (options.socketAndLogs) {
        const socketPath = getSocketPath(vmId)
        const vsockPath = getVsockPath(vmId)
        const logPath = getLogPath(vmId)
        const consoleLogPath = getConsoleLogPath(vmId)

        try {
            await unlink(socketPath)
        } catch {}

        try {
            await unlink(vsockPath)
        } catch {}

        try {
            await unlink(logPath)
        } catch {}

        try {
            await unlink(consoleLogPath)
        } catch {}
    }

    // Delete config file
    if (options.configFile) {
        const configPath = `/tmp/firecracker-${vmId}.json`
        try {
            await unlink(configPath)
            console.log(`[VMOrchestrator] Cleaned up config file`)
        } catch {}
    }
}

export function createVMOrchestrator(
    sessionManager: SessionManager,
    metrics?: MetricsType
) {
    const vmProcesses = new Map<string, ChildProcess>()
    const startingPromises = new Map<string, Promise<VMSession>>()
    const startingAborts = new Map<string, AbortController>()
    const stoppingVMs = new Map<string, Promise<void>>() // Prevent concurrent stopVM calls

    async function startVM(
        projectId: string,
        workspacePath: string
    ): Promise<VMSession> {
        // Ensure bridge is set up (hoisted function)
        await ensureBridgeInitialized()

        // 0. Validate inputs (prevent path traversal and injection attacks)
        validateProjectId(projectId)

        // 0.1 Enforce session limits (prevent resource exhaustion)
        if (!sessionManager.canCreateSession()) {
            throw new Error(
                `Maximum session limit reached. Please close unused VMs.`
            )
        }

        const projectKey = projectId

        // 1. Check for existing session
        const existing = sessionManager.getSessionByProject(projectId)
        if (existing) {
            if (
                existing.status === "running" ||
                existing.status === "starting"
            ) {
                sessionManager.touchSession(existing.vmId)
                return existing
            }
            
            // Clean up orphaned session in stopped/stopping state
            // This can happen if stopVM completed but session wasn't removed due to error
            if (existing.status === "stopped") {
                console.log(`[VMOrchestrator] Cleaning up orphaned stopped session for ${projectKey}`)
                // Clean up any potentially orphaned resources (except persistent overlay disk)
                try {
                    await cleanupVMResources(existing.vmId, {
                        tapDevice: true,
                        configFile: true,
                        socketAndLogs: true
                    })
                } catch (err) {
                    console.error(`[VMOrchestrator] Failed to cleanup orphaned resources:`, err)
                }
                sessionManager.removeSession(existing.vmId)
            } else if (existing.status === "stopping") {
                // Session is being stopped - wait for it to complete before starting new VM
                const stopPromise = stoppingVMs.get(existing.vmId)
                if (stopPromise) {
                    console.log(`[VMOrchestrator] Waiting for existing VM to stop before starting new one for ${projectKey}`)
                    await stopPromise
                } else {
                    // No stop promise but status is stopping - clean up orphaned state
                    console.log(`[VMOrchestrator] Cleaning up orphaned stopping session for ${projectKey}`)
                    sessionManager.removeSession(existing.vmId)
                }
            }
        }

        // 2. Check if already starting (de-duplicate concurrent requests)
        const pending = startingPromises.get(projectKey)
        if (pending) {
            return pending
        }

        // 3. Start the boot process and store the promise
        const abortController = new AbortController()
        startingAborts.set(projectKey, abortController)
        
        const startPromise = (async () => {
            let consoleLogFd: FileHandle | null = null
            const startupBegin = Date.now()
            const stepTiming = { last: startupBegin }

            // Track resources for cleanup on error
            let vmId: string | undefined
            let tapDeviceCreated = false
            let configPath: string | undefined

            // Start metrics timer for VM creation duration
            const endTimer = metrics?.vmCreationStarted(projectKey)

            try {
                // Check if startup was cancelled before we even begin
                if (abortController.signal.aborted) {
                    throw new Error("VM startup cancelled before initialization")
                }
                vmId = generateVMId()
                const socketPath = getSocketPath(vmId)
                const logPath = getLogPath(vmId)
                configPath = `/tmp/firecracker-${vmId}.json`

                // Ensure directories exist before creating any files
                await mkdir(getSocketDir(), { recursive: true })
                await mkdir(getLogDir(), { recursive: true })

                // Create session object IMMEDIATELY so it's visible to other lookups
                // We'll update the PID once we have it
                const session = sessionManager.createSession(
                    vmId,
                    projectId,
                    0, // PID pending
                    socketPath,
                    workspacePath
                )
                logStartupStep("session created", stepTiming)

                // Pre-create Firecracker API log file
                await writeFile(logPath, `Firecracker log for ${vmId}\n`)
                logStartupStep("firecracker log file created", stepTiming)

                // Create or get persistent overlay disk (stores OverlayFS changes + project files)
                const overlayDiskPath = await getOrCreateOverlayDisk(
                    projectId
                )
                logStartupStep("overlay disk ready", stepTiming)

                // Check abort after overlay disk creation (prevent orphaned session)
                if (abortController.signal.aborted) {
                    // Clean up session and logs (overlay disk is persistent, keep it)
                    try {
                        await cleanupVMResources(vmId, {
                            socketAndLogs: true
                        })
                        sessionManager.removeSession(vmId)
                        console.log(`[VMOrchestrator] Cleaned up session and logs after abort`)
                    } catch {}
                    throw new Error("VM startup cancelled after overlay disk creation")
                }

                // Generate Firecracker config
                const vmConfig: VMConfig = {
                    vmId,
                    projectId,
                    workspacePath,
                    overlayDiskPath,
                    memory: DEFAULT_VM_MEMORY_MB,
                    vcpuCount: DEFAULT_VM_VCPU_COUNT,
                    kernelPath: FIRECRACKER_KERNEL,
                    rootfsPath: FIRECRACKER_ROOTFS
                }

                // Verify kernel and rootfs exist
                if (!(await fileExists(vmConfig.kernelPath))) {
                    throw new Error(`Kernel not found: ${vmConfig.kernelPath}`)
                }
                if (!(await fileExists(vmConfig.rootfsPath))) {
                    throw new Error(`Rootfs not found: ${vmConfig.rootfsPath}`)
                }
                logStartupStep("kernel/rootfs verified", stepTiming)

                // Check abort before creating TAP device (prevent orphaned network)
                if (abortController.signal.aborted) {
                    // Clean up session and logs (overlay disk is persistent, keep it)
                    try {
                        await cleanupVMResources(vmId, {
                            socketAndLogs: true
                        })
                        sessionManager.removeSession(vmId)
                        console.log(`[VMOrchestrator] Cleaned up session and logs after abort`)
                    } catch {}
                    throw new Error("VM startup cancelled before network creation")
                }

                // Create TAP device for network access
                const networkConfig = await networkManager.createTapDevice(vmId)
                tapDeviceCreated = true
                session.vmIP = networkConfig.vmIP
                logStartupStep("network tap created", stepTiming)

                const firecrackerConfig = generateFirecrackerConfig(
                    vmConfig,
                    networkConfig
                )
                await writeFile(
                    configPath,
                    JSON.stringify(firecrackerConfig, null, 2)
                )
                logStartupStep("firecracker config written", stepTiming)

                // Check abort before spawning process (prevent orphaned Firecracker)
                if (abortController.signal.aborted) {
                    // Clean up all resources created so far (except persistent overlay disk)
                    try {
                        await cleanupVMResources(vmId, {
                            tapDevice: true,
                            configFile: true,
                            socketAndLogs: true
                        })
                        sessionManager.removeSession(vmId)
                        console.log(`[VMOrchestrator] Cleaned up all resources after abort`)
                    } catch {}
                    throw new Error("VM startup cancelled before spawning Firecracker process")
                }

                // Conditionally enable verbose boot logging
                const consoleLogPath = getConsoleLogPath(vmId)
                if (ENABLE_VERBOSE_BOOT_LOGS) {
                    await writeFile(
                        consoleLogPath,
                        `Console boot output for ${vmId}\n`
                    )
                    consoleLogFd = await open(consoleLogPath, "w")
                    console.log(`📋 Verbose boot log: ${consoleLogPath}`)
                }
                logStartupStep("console log prepared", stepTiming)

                const proc = spawn(
                    FIRECRACKER_BIN,
                    [
                        "--api-sock",
                        socketPath,
                        "--config-file",
                        configPath,
                        "--log-path",
                        logPath,
                        "--level",
                        "Info"
                    ],
                    {
                        stdio: ENABLE_VERBOSE_BOOT_LOGS
                            ? ["ignore", consoleLogFd!.fd, consoleLogFd!.fd]
                            : ["ignore", "ignore", "ignore"],
                        detached: false
                    }
                )
                logStartupStep("firecracker process spawned", stepTiming)

                if (!proc.pid) {
                    throw new Error(
                        "Failed to start Firecracker process (no PID)"
                    )
                }

                // Update session with actual PID
                session.pid = proc.pid
                vmProcesses.set(vmId, proc)

                // Capture vmId for closures (vmId is definitely string here, not undefined)
                const capturedVmId = vmId

                proc.on("error", async (error: Error) => {
                    console.error(
                        `[Firecracker ${capturedVmId}] Process error:`,
                        error.message
                    )
                    
                    // Only cleanup if this is an unexpected error (not during intentional stop)
                    const currentSession = sessionManager.getSession(capturedVmId)
                    if (!currentSession || currentSession.status === "stopping") {
                        // stopVM is handling cleanup - don't interfere
                        return
                    }
                    
                    sessionManager.updateStatus(capturedVmId, "stopped")
                    
                    // Clean up VM resources (except persistent overlay disk)
                    try {
                        await cleanupVMResources(capturedVmId, {
                            tapDevice: true,
                            configFile: true,
                            socketAndLogs: true,
                            vmProcesses,
                            portForwards: true,
                            consoleLogFd
                        })
                        console.log(`[VMOrchestrator] Cleaned up resources after unexpected process error`)
                    } catch (cleanupError) {
                        console.error(`[VMOrchestrator] Failed to cleanup after process error:`, cleanupError)
                    } finally {
                        // Always remove session even if cleanup failed
                        sessionManager.removeSession(capturedVmId)
                    }
                })

                proc.on(
                    "exit",
                    async (
                        code: number | null,
                        signal: NodeJS.Signals | null
                    ) => {
                        console.log(
                            `[Firecracker ${capturedVmId}] Process exited: code=${code}, signal=${signal}`
                        )
                        
                        // Only cleanup if this is an unexpected exit (not during intentional stop)
                        const currentSession = sessionManager.getSession(capturedVmId)
                        if (!currentSession || currentSession.status === "stopping") {
                            // stopVM is handling cleanup - don't interfere
                            console.log(`[VMOrchestrator] Process exit during intentional stop - cleanup handled by stopVM`)
                            return
                        }
                        
                        sessionManager.updateStatus(capturedVmId, "stopped")
                        
                        // Clean up VM resources (except persistent overlay disk)
                        try {
                            await cleanupVMResources(capturedVmId, {
                                tapDevice: true,
                                configFile: true,
                                socketAndLogs: true,
                                vmProcesses,
                                portForwards: true,
                                consoleLogFd
                            })
                            console.log(`[VMOrchestrator] Cleaned up resources after unexpected process exit`)
                        } catch (cleanupError) {
                            console.error(`[VMOrchestrator] Failed to cleanup after process exit:`, cleanupError)
                        } finally {
                            // Always remove session even if cleanup failed
                            sessionManager.removeSession(capturedVmId)
                        }
                    }
                )

                // Wait for socket to be ready (with timeout and abort check)
                let retries = 0
                const maxRetries = 300 // 30 seconds (300 * 100ms)

                while (retries < maxRetries) {
                    // Check if startup was aborted during socket wait
                    if (abortController.signal.aborted) {
                        throw new Error("VM startup cancelled during socket wait")
                    }

                    // Check if session still exists (might have been deleted during wait)
                    const currentSession = sessionManager.getSession(vmId)
                    if (!currentSession || currentSession.status === "stopping" || currentSession.status === "stopped") {
                        console.log(`[VMOrchestrator] Session ${vmId} no longer exists or is stopping - aborting socket wait`)
                        throw new Error(`VM session ${vmId} was removed or stopped`)
                    }

                    if (await fileExists(socketPath)) {
                        console.log(`🚀 [VMOrchestrator] VM ${vmId} ready`)
                        sessionManager.updateStatus(vmId, "running")

                        // Track successful VM creation
                        if (endTimer) endTimer()
                        metrics?.vmCreated()
                        metrics?.vmActiveCountUpdate(
                            sessionManager.getAllSessions().length
                        )

                        if (ENABLE_VERBOSE_STARTUP_LOGS) {
                            const total = Date.now() - startupBegin
                            console.log(
                                `✅ [VMOrchestrator] VM ${vmId} startup complete (${total}ms)`
                            )
                        }
                        return session
                    }

                    // Check if process is still alive
                    try {
                        process.kill(proc.pid, 0)
                    } catch {
                        const logInfo = ENABLE_VERBOSE_BOOT_LOGS
                            ? `Check console log: ${consoleLogPath}`
                            : `Check logs at: ${logPath}`
                        throw new Error(
                            `Firecracker process died during startup. ${logInfo}`
                        )
                    }

                    await new Promise((resolve) => setTimeout(resolve, 100))
                    retries++
                }

                throw new Error(
                    `VM failed to start within 30s timeout. Check logs at: ${getLogPath(
                        vmId
                    )}`
                )
            } catch (error) {
                console.error(
                    `[VMOrchestrator] Failed to start VM for ${projectKey}:`,
                    error
                )

                // Track VM creation failure
                metrics?.vmCreationFailed()

                // Clean up all resources created during this startup attempt
                // NOTE: Overlay disk is persistent, so we DON'T delete it on error (keeps user data safe)
                if (vmId) {
                    console.log(`[VMOrchestrator] Cleaning up resources for failed VM ${vmId}`)
                    
                    await cleanupVMResources(vmId, {
                        process: vmProcesses.get(vmId),
                        tapDevice: tapDeviceCreated,
                        configFile: !!configPath,
                        socketAndLogs: true, // Always clean up socket/logs if they were created
                        vmProcesses,
                        portForwards: true,
                        consoleLogFd
                    })
                    
                    // Remove session
                    try {
                        sessionManager.removeSession(vmId)
                        console.log(`[VMOrchestrator] Removed session`)
                    } catch {}
                }

                throw error
            } finally {
                if (ENABLE_VERBOSE_STARTUP_LOGS) {
                    const total = Date.now() - startupBegin
                    console.log(
                        `⏱️ [VMOrchestrator] VM startup finished in ${total}ms (success or failure)`
                    )
                }
                // Always clean up Maps to prevent memory leak (critical!)
                startingPromises.delete(projectKey)
                startingAborts.delete(projectKey)
            }
        })()

        startingPromises.set(projectKey, startPromise)
        return startPromise
    }

    async function stopVM(vmId: string): Promise<void> {
        const session = sessionManager.getSession(vmId)
        if (!session) {
            return
        }

        // Deduplicate concurrent stopVM calls (prevent race conditions)
        const existingStop = stoppingVMs.get(vmId)
        if (existingStop) {
            return existingStop
        }

        const stopPromise = (async () => {
            try {
                // Cancel any in-progress startup for this project
                const projectKey = session.projectId
                const abortController = startingAborts.get(projectKey)
                if (abortController) {
                    console.log(`[VMOrchestrator] Cancelling in-progress startup for ${projectKey}`)
                    abortController.abort()
                    
                    // Wait for startup to complete cleanup
                    const startupPromise = startingPromises.get(projectKey)
                    if (startupPromise) {
                        try {
                            await startupPromise
                        } catch {
                            // Expected - startup was aborted
                            console.log(`[VMOrchestrator] Startup cancelled for ${projectKey}`)
                        }
                    }
                }

                sessionManager.updateStatus(vmId, "stopping")

                // Kill Firecracker process (use SIGTERM for graceful shutdown)
                const proc = vmProcesses.get(vmId)
                if (proc) {
                    proc.kill("SIGTERM")
                    vmProcesses.delete(vmId)
                } else if (session.pid) {
                    await killProcess(session.pid)
                }

                // Cleanup VM resources (TAP, socket, logs, config, port forwards) - overlay disk persists
                await cleanupVMResources(vmId, {
                    tapDevice: true,
                    configFile: true,
                    socketAndLogs: true,
                    vmProcesses,
                    portForwards: true
                })

                sessionManager.updateStatus(vmId, "stopped")
                sessionManager.removeSession(vmId)

                // Track VM destruction
                metrics?.vmDestroyed(vmId)
                metrics?.vmActiveCountUpdate(sessionManager.getAllSessions().length)
            } finally {
                // Clean up tracking Map to prevent memory leak
                stoppingVMs.delete(vmId)
            }
        })()

        stoppingVMs.set(vmId, stopPromise)
        return stopPromise
    }

    async function stopAllVMs(): Promise<void> {
        console.log("[VMOrchestrator] Stopping all VMs")
        const sessions = sessionManager.getAllSessions()
        await Promise.allSettled(sessions.map((s) => stopVM(s.vmId)))
    }

    function getVMProcess(vmId: string): ChildProcess | undefined {
        return vmProcesses.get(vmId)
    }

    function getSessionManager(): SessionManager {
        return sessionManager
    }

    return {
        startVM,
        stopVM,
        stopAllVMs,
        getVMProcess,
        getSessionManager
    }
}

export type VMOrchestrator = ReturnType<typeof createVMOrchestrator>
