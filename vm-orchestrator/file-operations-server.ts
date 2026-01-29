/**
 * File Operations Proxy Server
 *
 * Architecture (CodeSandbox pattern):
 *
 * Browser ←→ WebSocket ←→ Host Proxy (this file) ←→ HTTP + WebSocket ←→ File Server (VM)
 *                                                      ↑                      ↓
 *                                              File operations        File change events
 *
 * This proxy:
 * - Accepts WebSocket connections from browser
 * - Forwards file operations to VM file server via HTTP
 * - Connects to VM file server WebSocket for file change notifications
 * - Broadcasts file changes to all connected browser clients
 * - Maintains persistent connections for low latency
 */

import { WebSocketServer, WebSocket } from "ws"
import { Server as HTTPServer, IncomingMessage } from "http"
import { Socket as NetSocket } from "net"
import { SessionManager } from "./session-manager"
import { VMOrchestrator } from "./vm-orchestrator"
import { startPortForward, getHostPortForVM } from "./port-forward"
import { ENABLE_VERBOSE_STARTUP_LOGS } from "./config"
import type { MetricsType } from "./metrics"
import fs from "fs"

const FILE_OPS_LOG = "/tmp/vm-orchestrator/file-ops.log"

function logBoth(message: string, details?: Record<string, unknown>): void {
    const payload = details ? ` ${JSON.stringify(details)}` : ""
    const line = `${new Date().toISOString()} ${message}${payload}`
    try {
        console.log(line)
    } catch {
        // Ignore console failures
    }
    return
    try {
        fs.appendFileSync(FILE_OPS_LOG, `${line}\n`)
    } catch {
        // Ignore disk logging failures
    }
}

// Hoisted security validation
function validateIdentifier(id: string, fieldName: string): void {
    if (!id || typeof id !== "string") {
        throw new Error(`Invalid ${fieldName}: must be non-empty string`)
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw new Error(`Invalid ${fieldName}: contains illegal characters`)
    }
    if (id.length > 100) {
        throw new Error(`Invalid ${fieldName}: too long`)
    }
}

interface FileOperationMessage {
    type: "connect" | "list" | "read" | "write" | "create" | "delete" | "rename"
    requestId: string
    path?: string
    content?: string
    newPath?: string
    fileType?: "file" | "directory"
    projectId?: string
}

interface FileOperationResponse {
    type: "success" | "error"
    requestId: string
    data?:
        | Record<string, unknown>
        | {
              connected?: boolean
              vmId?: string
              content?: string
              success?: boolean
          }
    error?: string
}

// Hoisted helpers
function parseMessage(data: string): FileOperationMessage | null {
    try {
        return JSON.parse(data) as FileOperationMessage
    } catch {
        return null
    }
}

function sendResponse(ws: WebSocket, response: FileOperationResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response))
    }
}

function sendError(ws: WebSocket, requestId: string, error: string): void {
    logBoth("[FileOps] error-response", { requestId, error })
    sendResponse(ws, { type: "error", requestId, error })
}

// Get the forwarded port for a VM's file server
function getVMFileServerPort(vmId: string): number {
    return getHostPortForVM(vmId, 8080)
}

// Hoisted helper - Check if fileserver is ready
async function isFileServerReady(
    fileServerPort: number,
    vmId: string,
    sessionManager: SessionManager,
    maxRetries: number = 20,
    retryDelay: number = 500
): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(
                `http://localhost:${fileServerPort}/api/files`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        type: "list",
                        requestId: "health-check",
                        path: "",
                        depth: 0
                    }),
                    signal: AbortSignal.timeout(2000)
                }
            )
            
            if (response.ok) {
                return true
            }
        } catch {
            // Connection error - fileserver not ready yet
            if (attempt < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, retryDelay))
                
                // Check if session still exists before continuing retry loop
                const currentSession = sessionManager.getSession(vmId)
                if (!currentSession || currentSession.status === "stopping" || currentSession.status === "stopped") {
                    console.log(`[FileOps] Session ${vmId} no longer exists or is stopping - aborting fileserver readiness check`)
                    return false
                }
                
                continue
            }
        }
    }
    return false
}

// Hoisted helper - Retry fetch to file server with exponential backoff
async function fetchFromFileServer(
    fileServerPort: number,
    message: FileOperationMessage,
    vmId: string,
    sessionManager: SessionManager,
    maxRetries: number = 5,
    initialDelay: number = 500
): Promise<Response> {
    let lastError: Error | null = null

    logBoth("[FileOps] fetch", {
        type: message.type,
        requestId: message.requestId,
        port: fileServerPort
    })

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(
                `http://localhost:${fileServerPort}/api/files`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(message),
                    signal: AbortSignal.timeout(5000) // 5 second timeout per attempt
                }
            )

            // Success!
            return response
        } catch (error) {
            lastError =
                error instanceof Error ? error : new Error(String(error))

            // Check if it's a connection error (server not ready)
            const isConnectionError =
                lastError.message.includes("ECONNREFUSED") ||
                lastError.message.includes("ENOENT") ||
                lastError.message.includes("other side closed") ||
                lastError.message.includes("fetch failed")

            if (isConnectionError && attempt < maxRetries) {
                // Exponential backoff: 500ms, 1000ms, 2000ms, 4000ms, 8000ms
                const delay = initialDelay * Math.pow(2, attempt - 1)
                logBoth("[FileOps] fetch-retry", {
                    attempt,
                    maxRetries,
                    delayMs: delay,
                    error: lastError.message,
                    port: fileServerPort
                })
                await new Promise((resolve) => setTimeout(resolve, delay))
                
                // Check if session still exists before continuing retry loop
                const currentSession = sessionManager.getSession(vmId)
                if (!currentSession || currentSession.status === "stopping" || currentSession.status === "stopped") {
                    console.log(`[FileOps] Session ${vmId} no longer exists or is stopping - aborting fetch retry`)
                    throw new Error(`VM session ${vmId} was removed or stopped`)
                }
                
                continue
            }

            // Not a connection error or out of retries
            throw lastError
        }
    }

    throw lastError || new Error("Failed to connect to file server")
}

// Connect to VM file server WebSocket for file change notifications
// Retries with exponential backoff if connection fails
// Returns cleanup function that must be called when browser connection closes
async function connectToVMFileWatcher(
    fileServerPort: number,
    browserWs: WebSocket,
    vmId: string,
    sessionManager: SessionManager,
    initialDelay: number = 1000
): Promise<WebSocket> {
    let attempt = 1
    const maxRetries = 60 // 60 seconds maximum (60 retries × 1s)
    let vmWs: WebSocket | null = null
    const connectStart = Date.now()

    const tryConnect = (): Promise<WebSocket> => {
        return new Promise((resolve, reject) => {
            // Check if browser ws still open before creating VM connection
            if (browserWs.readyState !== WebSocket.OPEN) {
                reject(new Error("Browser WebSocket closed"))
                return
            }

            logBoth("[FileOps] watcher-connect-attempt", {
                attempt,
                port: fileServerPort
            })

            vmWs = new WebSocket(`ws://localhost:${fileServerPort}`)
            let timeoutId: NodeJS.Timeout | null = null

            timeoutId = setTimeout(() => {
                if (vmWs && vmWs.readyState !== WebSocket.OPEN) {
                    vmWs.terminate()
                    timeoutId = null
                    reject(new Error("Connection timeout"))
                }
            }, 3000) // 3 seconds is plenty since fileserver is already confirmed ready

            vmWs.on("open", () => {
                if (timeoutId) {
                    clearTimeout(timeoutId)
                    timeoutId = null
                }

                // Race condition check: browser might have disconnected while connecting
                if (browserWs.readyState !== WebSocket.OPEN) {
                    vmWs!.terminate()
                    reject(
                        new Error("Browser WebSocket closed during connection")
                    )
                    return
                }

                logBoth("[FileOps] watcher-connected", {
                    port: fileServerPort,
                    elapsedMs: Date.now() - connectStart,
                    attempts: attempt
                })
                if (ENABLE_VERBOSE_STARTUP_LOGS) {
                    const elapsed = Date.now() - connectStart
                    console.log(
                        `✅ [FileOps] File watcher ready (${elapsed}ms, attempts ${attempt})`
                    )
                }

                // Forward file change notifications to browser client
                vmWs!.on("message", (data) => {
                    // Guard: only forward if browser still connected
                    if (browserWs.readyState !== WebSocket.OPEN) return

                    try {
                        const notification = JSON.parse(data.toString())
                        if (notification.type === "file-changed") {
                            browserWs.send(data.toString())
                        }
                    } catch (error) {
                        logBoth("[FileOps] watcher-message-parse-error", {
                            error: error instanceof Error ? error.message : String(error)
                        })
                    }
                })

                vmWs!.on("error", (error) => {
                    logBoth("[FileOps] watcher-error", {
                        error: error instanceof Error ? error.message : String(error)
                    })
                })

                vmWs!.on("close", () => {
                    logBoth("[FileOps] watcher-closed", {
                        port: fileServerPort
                    })
                })

                resolve(vmWs!)
            })

            vmWs.on("error", (error) => {
                if (timeoutId) {
                    clearTimeout(timeoutId)
                    timeoutId = null
                }
                reject(error)
            })
        })
    }

    while (attempt <= maxRetries) {
        try {
            const connectedWs = await tryConnect()
            return connectedWs
        } catch (error) {
            // Clean up failed connection attempt
            const ws = vmWs as WebSocket | null
            if (
                ws &&
                ws.readyState !== WebSocket.CLOSED &&
                ws.readyState !== WebSocket.CLOSING
            ) {
                ws.terminate()
            }
            vmWs = null

            const errorMsg =
                error instanceof Error ? error.message : String(error)

            // If browser disconnected, stop retrying
            if (errorMsg.includes("Browser WebSocket closed")) {
                throw error
            }

            const isConnectionError =
                errorMsg.includes("ECONNREFUSED") ||
                errorMsg.includes("ECONNRESET") ||
                errorMsg.includes("socket hang up") ||
                errorMsg.includes("timeout")

            if (isConnectionError) {
                console.log(
                    `[FileOps] VM file watcher connection attempt ${attempt} failed: ${errorMsg}. Retrying in ${initialDelay}ms...`
                )
                if (ENABLE_VERBOSE_STARTUP_LOGS) {
                    const elapsed = Date.now() - connectStart
                    console.log(
                        `⏱️ [FileOps] File watcher not ready after ${elapsed}ms (attempt ${attempt})`
                    )
                }
                await new Promise((resolve) => setTimeout(resolve, initialDelay))
                
                // Check if session still exists before continuing retry loop
                const currentSession = sessionManager.getSession(vmId)
                if (!currentSession || currentSession.status === "stopping" || currentSession.status === "stopped") {
                    console.log(`[FileOps] Session ${vmId} no longer exists or is stopping - aborting file watcher connection attempts`)
                    throw new Error(`VM session ${vmId} was removed or stopped`)
                }
                
                attempt++
                continue
            }

            console.error(
                `[FileOps] Non-connection error, stopping retries:`,
                error
            )
            throw error
        }
    }

    // Should never reach here with infinite retries, but TypeScript needs this
    throw new Error("Unexpected: exited infinite retry loop")
}
export function createFileOperationsProxy(
    httpServer: HTTPServer,
    sessionManager: SessionManager,
    orchestrator: VMOrchestrator,
    metrics?: MetricsType
) {
    const wss = new WebSocketServer({ noServer: true })

    // Manually handle upgrade for this path
    const upgradeHandler = (
        request: IncomingMessage,
        socket: NetSocket,
        head: Buffer
    ) => {
        if (request.url?.startsWith("/file-operations")) {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit("connection", ws, request)
            })
        }
    }
    httpServer.on("upgrade", upgradeHandler)

    wss.on("connection", (ws) => {
        let currentVmId: string | null = null
        let currentVmIp: string | null = null
        let fileServerPort: number | null = null
        let vmFileWatcherWs: WebSocket | null = null

        // Setup heartbeat
        let isAlive = true
        ws.on("pong", () => {
            isAlive = true
        })

        const heartbeat = setInterval(() => {
            if (!isAlive) {
                clearInterval(heartbeat)
                return ws.terminate()
            }
            isAlive = false
            ws.ping()
        }, 30000)

        ws.on("message", async (data) => {
            const message = parseMessage(data.toString())
            if (!message) {
                sendError(ws, "unknown", "Invalid message format")
                return
            }

            try {
                switch (message.type) {
                    case "connect": {
                        const { projectId } = message

                        if (!projectId) {
                            sendError(
                                ws,
                                message.requestId,
                                "Missing projectId"
                            )
                            return
                        }

                        // Validate inputs to prevent injection/traversal attacks
                        try {
                            validateIdentifier(projectId, "projectId")
                        } catch (error) {
                            sendError(
                                ws,
                                message.requestId,
                                error instanceof Error
                                    ? error.message
                                    : "Invalid input"
                            )
                            return
                        }

                        // Get or create VM session
                        const session = sessionManager.getSessionByProject(
                            projectId
                        )

                        if (!session) {
                            // Try creating new session
                            const workspacePath = `/tmp/projects/${projectId}`
                            const newSession = await orchestrator.startVM(
                                projectId,
                                workspacePath
                            )
                            if (!newSession) {
                                sendError(
                                    ws,
                                    message.requestId,
                                    "Failed to create VM session"
                                )
                                return
                            }
                            currentVmId = newSession.vmId
                            currentVmIp = newSession.vmIP || null
                            fileServerPort = getVMFileServerPort(
                                newSession.vmId
                            )
                        } else {
                            currentVmId = session.vmId
                            currentVmIp = session.vmIP || null
                            fileServerPort = getVMFileServerPort(session.vmId)
                        }

                        // Ensure we have a valid vmId before proceeding
                        if (!currentVmId) {
                            sendError(ws, message.requestId, "Failed to obtain VM ID")
                            return
                        }

                        // Start port forward: host port → VM port 8080
                        startPortForward({
                            vmId: currentVmId,
                            vmPort: 8080,
                            hostPort: fileServerPort,
                            vmIP: currentVmIp || undefined
                        })

                        // Wait for fileserver to be ready before responding
                        // This ensures frontend file operations work immediately
                        const ready = await isFileServerReady(fileServerPort, currentVmId, sessionManager, 20, 500)
                        if (!ready) {
                            sendError(ws, message.requestId, "VM fileserver failed to start in time")
                            return
                        }

                        // Send success response - fileserver is guaranteed ready
                        sendResponse(ws, {
                            type: "success",
                            requestId: message.requestId,
                            data: { connected: true, vmId: currentVmId }
                        })

                        // Connect to VM file server WebSocket for file change notifications in background
                        ;(async () => {
                            // Race condition check: browser might have disconnected
                            if (ws.readyState !== WebSocket.OPEN) {
                                logBoth("[FileOps] Browser disconnected during watcher connection")
                                return
                            }

                            // Ensure vmId is not null before connecting
                            if (!currentVmId) {
                                logBoth("[FileOps] No VM ID available for file watcher connection")
                                return
                            }

                            try {
                                vmFileWatcherWs = await connectToVMFileWatcher(
                                    fileServerPort,
                                    ws,
                                    currentVmId,
                                    sessionManager,
                                    1000 // Retry delay between attempts
                                )
                            } catch (error) {
                                logBoth("[FileOps] Failed to connect to file watcher", {
                                    error: error instanceof Error ? error.message : String(error)
                                })
                                // Don't fail the entire connection, just proceed without live updates
                            }
                        })()
                        break
                    }

                    case "list":
                    case "read":
                    case "write":
                    case "create":
                    case "delete":
                    case "rename": {
                        if (!currentVmId || !fileServerPort) {
                            sendError(
                                ws,
                                message.requestId,
                                "Not connected to VM"
                            )
                            return
                        }

                        // Track file operation
                        metrics?.fileOperation(message.type)

                        // Forward request to file server inside VM with retry logic
                        const response = await fetchFromFileServer(
                            fileServerPort,
                            message,
                            currentVmId,
                            sessionManager
                        )

                        if (!response.ok) {
                            throw new Error(
                                `File server error: ${response.statusText}`
                            )
                        }

                        const result =
                            (await response.json()) as FileOperationResponse
                        sendResponse(ws, result)
                        break
                    }

                    default:
                        sendError(
                            ws,
                            message.requestId,
                            `Unknown message type: ${message.type}`
                        )
                }
            } catch (error) {
                console.error("[FileOps] Error handling message:", error)
                // Note: Don't stop port forward here, other clients might be using it
                // Port forwards are cleaned up when VM stops
                sendError(
                    ws,
                    message.requestId,
                    error instanceof Error
                        ? error.message
                        : "Internal server error"
                )
            }
        })

        // Cleanup function to prevent duplication
        const cleanupConnection = () => {
            clearInterval(heartbeat)
            if (vmFileWatcherWs) {
                if (vmFileWatcherWs.readyState !== WebSocket.CLOSED) {
                    vmFileWatcherWs.close()
                }
                vmFileWatcherWs = null
            }
        }

        ws.on("close", cleanupConnection)
        ws.on("error", (error) => {
            console.error("[FileOps] WebSocket error:", error)
            cleanupConnection()
        })
    })

    function close() {
        console.log("[FileOps] Shutting down")
        // Remove upgrade listener
        httpServer.off("upgrade", upgradeHandler)
        wss.close()
    }

    return { wss, close }
}

export type FileOperationsServer = ReturnType<typeof createFileOperationsProxy>
