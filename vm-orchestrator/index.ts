import { createServer, ServerResponse } from "http"
import { mkdir } from "fs/promises"
import fs from "fs"
import { exec } from "child_process"
import { promisify } from "util"
import { createSessionManager } from "./session-manager"
import { createVMOrchestrator } from "./vm-orchestrator"
import { createWebSocketServer } from "./websocket-server"
import { createFileOperationsProxy } from "./file-operations-server"
import { VM_ORCHESTRATOR_PORT, FIRECRACKER_PROJECTS_DIR } from "./config"
import { networkManager } from "./network-manager"
import { getHostPortForVM, startPortForward } from "./port-forward"
import { deleteOverlayDisk } from "./overlay-disk"
import path from "path"
import net from "net"
import crypto from "crypto"
import { Duplex } from "stream"
import { spawn } from "child_process"
import { metrics, metricsRegistry, updateResourceMetrics } from "./metrics"

const execAsync = promisify(exec)

// Hoisted validation helper
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

// Track active proxy connections for cleanup when VM stops
const activeProxyConnections = new Map<string, Set<Duplex | net.Socket>>()

const MAX_PROXY_BODY_SIZE = 10 * 1024 * 1024 // 10MB

async function streamUpstreamResponse(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    res: ServerResponse,
    signal: AbortSignal
): Promise<void> {
    try {
        while (true) {
            if (signal.aborted || res.destroyed || res.writableEnded) {
                break
            }

            const { done, value } = await reader.read()
            if (done) break
            if (!value || value.length === 0) continue

            if (!res.write(Buffer.from(value))) {
                await new Promise<void>((resolve) => res.once("drain", resolve))
            }
        }
    } finally {
        try {
            await reader.cancel()
        } catch {
            // Ignore reader cancellation errors
        }
    }
}

function trackProxyConnection(vmId: string, socket: Duplex | net.Socket): void {
    if (!activeProxyConnections.has(vmId)) {
        activeProxyConnections.set(vmId, new Set())
    }
    activeProxyConnections.get(vmId)!.add(socket)
    
    // Auto-cleanup when socket closes
    socket.on("close", () => {
        activeProxyConnections.get(vmId)?.delete(socket)
        if (activeProxyConnections.get(vmId)?.size === 0) {
            activeProxyConnections.delete(vmId)
        }
    })
}

function closeAllProxyConnections(vmId: string): void {
    const connections = activeProxyConnections.get(vmId)
    if (connections) {
        for (const socket of connections) {
            if (!socket.destroyed) {
                socket.destroy()
            }
        }
        activeProxyConnections.delete(vmId)
        console.log(`[VMOrchestrator] Closed ${connections.size} proxy connection(s) for VM ${vmId}`)
    }
}

async function main() {
    console.log("[VMOrchestrator] Starting VM orchestration service...")

    // Create required directories
    const socketDir =
        process.env.NODE_ENV === "production"
            ? "/var/run/firecracker/sockets"
            : "/tmp/vm-orchestrator/sockets"
    const logDir =
        process.env.NODE_ENV === "production"
            ? "/var/log/firecracker"
            : "/tmp/vm-orchestrator/logs"

    await mkdir(socketDir, { recursive: true })
    await mkdir(logDir, { recursive: true })
    console.log(`[VMOrchestrator] Directories ready: ${socketDir}, ${logDir}`)

    // Initialize session manager
    const sessionManager = createSessionManager()

    // Initialize VM orchestrator with metrics
    const orchestrator = createVMOrchestrator(sessionManager, metrics)

    // Start cleanup loop
    sessionManager.startCleanup(async (session) => {
        console.log(
            `[VMOrchestrator] Auto-cleanup expired session: ${session.vmId}`
        )
        closeAllProxyConnections(session.vmId)
        await orchestrator.stopVM(session.vmId)
    })

    // Start resource metrics update interval
    const metricsInterval = setInterval(updateResourceMetrics, 5000) // Update every 5 seconds
    updateResourceMetrics() // Initial update

    // Create HTTP server for WebSocket
    const httpServer = createServer(async (req, res) => {
        // Add CORS headers for all requests
        res.setHeader("Access-Control-Allow-Origin", "http://localhost:3000")
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        res.setHeader("Access-Control-Allow-Headers", "Content-Type")
        res.setHeader("Access-Control-Max-Age", "86400") // 24 hours
        
        // Handle preflight requests
        if (req.method === "OPTIONS") {
            res.writeHead(204)
            res.end()
            return
        }
        
        if (req.url === "/health") {
            const sessions = sessionManager.getAllSessions()
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(
                JSON.stringify({
                    status: "healthy",
                    activeSessions: sessions.length,
                    sessions: sessions.map((s) => ({
                        vmId: s.vmId,
                        projectId: s.projectId,
                        status: s.status,
                        uptime: Date.now() - s.createdAt.getTime()
                    }))
                })
            )
        } else if (req.method === "POST" && req.url === "/api/vm/status") {
            // Check VM status for a project
            let body = ""
            req.on("data", (chunk) => {
                body += chunk.toString()
            })

            req.on("end", async () => {
                try {
                    let parsedBody: { projectId: string }
                    try {
                        parsedBody = JSON.parse(body)
                    } catch {
                        res.writeHead(400, { "Content-Type": "application/json" })
                        res.end(JSON.stringify({ error: "Invalid JSON in request body" }))
                        return
                    }

                    const { projectId } = parsedBody

                    validateIdentifier(projectId, "projectId")

                    const session = sessionManager.getSessionByProject(
                        projectId
                    )

                    res.writeHead(200, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            running: !!session,
                            status: session?.status || "stopped",
                            vmId: session?.vmId,
                            vmIP: session?.vmIP
                        })
                    )
                } catch (error) {
                    console.error("[VMStatus] Error:", error)
                    res.writeHead(500, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Internal server error"
                        })
                    )
                }
            })
        } else if ((req.method === "GET" || req.method === "HEAD") && req.url?.startsWith("/api/overlay/download/")) {
            // Download overlay disk for a project
            const projectId = req.url.split("/").pop()
            
            try {
                if (!projectId) {
                    res.writeHead(400, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: "Missing project ID" }))
                    return
                }

                validateIdentifier(projectId, "projectId")

                const overlayPath = path.join(
                    FIRECRACKER_PROJECTS_DIR,
                    `${projectId}-overlay.ext4`
                )

                // Check if file exists
                if (!fs.existsSync(overlayPath)) {
                    res.writeHead(404, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            error: "Overlay disk not found. VM may not have been started yet."
                        })
                    )
                    return
                }

                // Set headers for tar.gz download (preserves sparse file)
                res.writeHead(200, {
                    "Content-Type": "application/gzip",
                    "Content-Disposition": `attachment; filename="${projectId}-overlay.ext4.tar.gz"`
                })

                // For HEAD requests, don't send body
                if (req.method === "HEAD") {
                    res.end()
                    return
                }

                // Stream file with tar --sparse and gzip compression
                // tar --sparse preserves sparse file holes, gzip compresses efficiently
                // This keeps download small (~69MB) and preserves sparse characteristics
                const tarProcess = spawn("tar", [
                    "--sparse",           // Preserve sparse file holes
                    "-czf",               // Create, gzip compress, to file (stdout)
                    "-",                  // Output to stdout
                    "-C",                 // Change to directory
                    FIRECRACKER_PROJECTS_DIR,
                    `${projectId}-overlay.ext4`  // File to archive
                ])

                tarProcess.stdout.pipe(res)
                
                // Kill tar process if client disconnects
                res.on("close", () => {
                    if (!tarProcess.killed) {
                        console.log("[OverlayDownload] Client disconnected, killing tar process")
                        tarProcess.kill("SIGTERM")
                    }
                })

                // Handle errors from tar process
                tarProcess.on("error", (error: Error) => {
                    console.error("[OverlayDownload] Tar process error:", error)
                    if (!res.headersSent) {
                        res.writeHead(500, { "Content-Type": "application/json" })
                        res.end(JSON.stringify({ error: "Failed to create archive" }))
                    }
                    // Ensure process is killed
                    if (!tarProcess.killed) {
                        tarProcess.kill("SIGKILL")
                    }
                })

                tarProcess.stderr.on("data", (data: Buffer) => {
                    console.error(`[OverlayDownload] Tar stderr: ${data}`)
                })

                tarProcess.on("close", (code: number | null) => {
                    if (code !== 0 && code !== null) {
                        console.error(`[OverlayDownload] Tar process exited with code ${code}`)
                        // Only send error if headers not sent (may have already streamed partial data)
                        if (!res.headersSent) {
                            res.writeHead(500, { "Content-Type": "application/json" })
                            res.end(JSON.stringify({ error: "Tar process failed" }))
                        }
                    }
                })
            } catch (error) {
                console.error("[OverlayDownload] Error:", error)
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Internal server error"
                        })
                    )
                }
            }
        } else if (req.method === "POST" && req.url === "/api/overlay/upload") {
            // Upload and extract overlay disk
            let tempFilePath = ""
            let extractDir = ""
            let projectId = ""
            let targetPath = ""
            
            try {
                // Convert Node.js IncomingMessage to Web Request for Bun's formData() API
                const chunks: Buffer[] = []
                let totalSize = 0
                const MAX_REQUEST_SIZE = 11 * 1024 * 1024 * 1024 // 11GB (slightly larger than max file size)
                
                for await (const chunk of req) {
                    totalSize += chunk.length
                    if (totalSize > MAX_REQUEST_SIZE) {
                        res.writeHead(413, { "Content-Type": "application/json" })
                        res.end(JSON.stringify({ error: "Request body too large" }))
                        return
                    }
                    chunks.push(chunk)
                }
                const bodyBuffer = Buffer.concat(chunks)
                
                const request = new Request(`http://localhost:${VM_ORCHESTRATOR_PORT}/api/overlay/upload`, {
                    method: "POST",
                    headers: req.headers as HeadersInit,
                    body: bodyBuffer
                })
                
                const formData = await request.formData()
                const file = formData.get("file") as File
                
                if (!file) {
                    res.writeHead(400, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: "No file provided" }))
                    return
                }
                
                // Validate file extension
                if (!file.name.endsWith(".tar.gz") && !file.name.endsWith(".tgz")) {
                    res.writeHead(400, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: "Invalid file type. Expected .tar.gz or .tgz" }))
                    return
                }
                
                // Validate file size (max 10GB - slightly larger than max 5GB overlay)
                const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024
                if (file.size > MAX_FILE_SIZE) {
                    res.writeHead(400, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB` }))
                    return
                }
                
                // Check available disk space before proceeding
                try {
                    const { stdout } = await execAsync(`df -B1 ${FIRECRACKER_PROJECTS_DIR} | tail -1 | awk '{print $4}'`)
                    const availableSpace = parseInt(stdout.trim(), 10)
                    const requiredSpace = Math.max(file.size * 2, 15 * 1024 * 1024 * 1024) // 2x file size or 15GB minimum
                    
                    if (availableSpace < requiredSpace) {
                        res.writeHead(507, { "Content-Type": "application/json" })
                        res.end(JSON.stringify({ 
                            error: `Insufficient disk space. Required: ${(requiredSpace / (1024 * 1024 * 1024)).toFixed(2)}GB, Available: ${(availableSpace / (1024 * 1024 * 1024)).toFixed(2)}GB` 
                        }))
                        return
                    }
                } catch (error) {
                    console.warn("[OverlayUpload] Could not check disk space:", error)
                    // Continue anyway - don't block uploads if df command fails
                }
                
                // Generate new project ID
                projectId = crypto.randomUUID()
                
                if (!projectId) {
                    throw new Error("Failed to generate project ID")
                }
                
                // Validate projectId
                validateIdentifier(projectId, "projectId")
                
                // Set targetPath early for race condition check
                targetPath = path.join(FIRECRACKER_PROJECTS_DIR, `${projectId}-overlay.ext4`)
                
                // Race condition protection: check if target already exists
                // UUID collision is nearly impossible, but check for .uploading temp file too
                if (fs.existsSync(targetPath) || fs.existsSync(`${targetPath}.uploading`)) {
                    console.error(`[OverlayUpload] Collision detected for projectId ${projectId}`)
                    res.writeHead(409, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: "Project ID collision. Please retry." }))
                    return
                }
                
                // Write uploaded file to temp location
                // NOTE: arrayBuffer() loads entire file into memory - acceptable for single-user system
                // For production, use streaming multipart parser
                tempFilePath = path.join("/tmp", `${projectId}-upload.tar.gz`)
                const fileArrayBuffer = await file.arrayBuffer()
                const fileBuffer = Buffer.from(fileArrayBuffer)
                fs.writeFileSync(tempFilePath, fileBuffer)
                
                // Create unique temp directory for this upload
                extractDir = path.join("/tmp", `upload-${projectId}`)
                fs.mkdirSync(extractDir, { recursive: true })
                
                // Extract tar.gz file to unique temp directory
                const extractProcess = spawn("tar", [
                    "--sparse",           // Preserve sparse file holes
                    "-xzf",               // Extract, decompress gzip, from file
                    tempFilePath,         // Input archive
                    "-C",                 // Change to directory
                    extractDir
                ])
                
                let extractError = ""
                extractProcess.stderr.on("data", (data: Buffer) => {
                    extractError += data.toString()
                })
                
                await new Promise<void>((resolve, reject) => {
                    extractProcess.on("close", (code: number | null) => {
                        if (code !== 0) {
                            reject(new Error(`Extraction failed: ${extractError || `exit code ${code}`}`))
                        } else {
                            resolve()
                        }
                    })
                    
                    extractProcess.on("error", (error: Error) => {
                        reject(error)
                    })
                })
                
                // Find the extracted file in our temp directory
                const extractedFiles = fs.readdirSync(extractDir).filter(f => f.endsWith("-overlay.ext4"))
                
                console.log(`[OverlayUpload] Extracted files in ${extractDir}: ${extractedFiles.join(", ")}`)
                
                if (extractedFiles.length === 0) {
                    throw new Error("No overlay file found in extracted archive")
                }
                
                if (extractedFiles.length > 1) {
                    throw new Error("Archive contains multiple overlay files. Expected single overlay disk.")
                }
                
                // Security: Validate filename doesn't contain path traversal
                const extractedFilename = extractedFiles[0]
                if (extractedFilename.includes("..") || extractedFilename.includes("/") || extractedFilename.includes("\\")) {
                    throw new Error("Invalid filename in archive: path traversal detected")
                }
                
                // Security: Ensure path is within extractDir (canonical path check)
                const extractedPath = path.join(extractDir, extractedFilename)
                const canonicalExtractedPath = fs.realpathSync(extractedPath)
                const canonicalExtractDir = fs.realpathSync(extractDir)
                // Ensure comparison uses path separator at end to prevent false positives
                const normalizedExtractDir = canonicalExtractDir.endsWith(path.sep) 
                    ? canonicalExtractDir 
                    : canonicalExtractDir + path.sep
                if (!canonicalExtractedPath.startsWith(normalizedExtractDir)) {
                    throw new Error("Security violation: extracted file outside temp directory")
                }
                
                // Verify extracted file exists and has non-zero size
                const extractedStats = fs.statSync(extractedPath)
                if (!extractedStats.isFile()) {
                    throw new Error("Extracted path is not a file")
                }
                if (extractedStats.size === 0) {
                    throw new Error("Extracted file is empty (0 bytes)")
                }
                
                console.log(`[OverlayUpload] Copying ${extractedPath} (${extractedStats.size} bytes) to ${targetPath}`)
                
                // Use atomic operation: copy to temp then rename
                // This prevents corruption if process is killed mid-copy
                const tempTargetPath = `${targetPath}.uploading`
                
                try {
                    // Copy preserving sparse holes (can't rename across filesystems)
                    await execAsync(`cp --sparse=always "${extractedPath}" "${tempTargetPath}"`)
                    
                    // Sync filesystem to ensure copy completed
                    await execAsync("sync")
                    
                    // Verify copied file size matches before atomic rename
                    const tempStats = fs.statSync(tempTargetPath)
                    if (tempStats.size !== extractedStats.size) {
                        throw new Error(`Copy size mismatch: expected ${extractedStats.size}, got ${tempStats.size}`)
                    }
                    
                    // Atomic rename - this is the commit point
                    try {
                        fs.renameSync(tempTargetPath, targetPath)
                    } catch {
                        // If rename fails (e.g., across filesystems), use mv command
                        await execAsync(`mv "${tempTargetPath}" "${targetPath}"`)
                    }
                } catch (copyError) {
                    // Clean up temp target if copy failed
                    if (fs.existsSync(tempTargetPath)) {
                        fs.unlinkSync(tempTargetPath)
                    }
                    throw copyError
                }
                
                // Clean up temp directory
                fs.rmSync(extractDir, { recursive: true, force: true })
                
                // Verify extracted file exists and is ext4
                if (!fs.existsSync(targetPath)) {
                    throw new Error("Extracted file not found after copy")
                }
                
                // Verify copied file has correct size
                const copiedStats = fs.statSync(targetPath)
                if (copiedStats.size === 0) {
                    throw new Error("Copied file is empty (0 bytes)")
                }
                if (copiedStats.size !== extractedStats.size) {
                    throw new Error(`Final verification failed: size mismatch ${copiedStats.size} vs ${extractedStats.size}`)
                }
                
                // Basic ext4 signature check (first 2 bytes at offset 0x438 should be 0x53EF)
                let fd = -1
                try {
                    fd = fs.openSync(targetPath, "r")
                    const buffer = Buffer.alloc(2)
                    fs.readSync(fd, buffer, 0, 2, 0x438)
                    
                    const signature = buffer.readUInt16LE(0)
                    if (signature !== 0xEF53) {
                        // Clean up invalid file and temp file
                        fs.unlinkSync(targetPath)
                        fs.unlinkSync(tempFilePath)
                        throw new Error("Invalid ext4 filesystem")
                    }
                } finally {
                    if (fd >= 0) {
                        fs.closeSync(fd)
                    }
                }
                
                // Clean up temp file
                fs.unlinkSync(tempFilePath)
                
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ projectId }))
            } catch (error) {
                console.error("[OverlayUpload] Error:", error)
                
                // Clean up temp files on error
                try {
                    if (tempFilePath && fs.existsSync(tempFilePath)) {
                        fs.unlinkSync(tempFilePath)
                    }
                    if (extractDir && fs.existsSync(extractDir)) {
                        fs.rmSync(extractDir, { recursive: true, force: true })
                    }
                    // Clean up partial target file if it exists
                    if (targetPath) {
                        if (fs.existsSync(targetPath)) {
                            fs.unlinkSync(targetPath)
                        }
                        // Also clean up .uploading temp file
                        if (fs.existsSync(`${targetPath}.uploading`)) {
                            fs.unlinkSync(`${targetPath}.uploading`)
                        }
                    }
                } catch (cleanupError) {
                    // Only log if it's not a "file not found" error
                    if (cleanupError instanceof Error && !cleanupError.message.includes('ENOENT')) {
                        console.error("[OverlayUpload] Cleanup error:", cleanupError)
                    }
                }
                
                res.writeHead(500, { "Content-Type": "application/json" })
                res.end(
                    JSON.stringify({
                        error:
                            error instanceof Error
                                ? error.message
                                : "Failed to upload overlay"
                    })
                )
            }
        } else if (req.method === "DELETE" && req.url?.startsWith("/api/overlay/delete/")) {
            // DELETE /api/overlay/delete/{projectId} - Delete orphaned overlay disk
            try {
                const projectId = req.url.split("/api/overlay/delete/")[1]
                
                if (!projectId) {
                    res.writeHead(400, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: "Project ID required" }))
                    return
                }
                
                validateIdentifier(projectId, "projectId")
                
                const overlayPath = path.join(
                    FIRECRACKER_PROJECTS_DIR,
                    `${projectId}-overlay.ext4`
                )
                
                if (!fs.existsSync(overlayPath)) {
                    res.writeHead(404, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: "Overlay disk not found" }))
                    return
                }
                
                // Check if VM is running with this overlay (don't delete if in use)
                const session = sessionManager.getSessionByProject(projectId)
                if (session) {
                    res.writeHead(409, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: "Cannot delete disk: VM is running" }))
                    return
                }
                
                // Delete the overlay file
                fs.unlinkSync(overlayPath)
                console.log(`[OverlayDelete] Deleted orphaned disk: ${overlayPath}`)
                
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ success: true }))
            } catch (error) {
                console.error("[OverlayDelete] Error:", error)
                res.writeHead(500, { "Content-Type": "application/json" })
                res.end(
                    JSON.stringify({
                        error:
                            error instanceof Error
                                ? error.message
                                : "Failed to delete overlay"
                    })
                )
            }
        } else if (req.method === "POST" && req.url === "/api/vm/start") {
            // Start VM for a project
            let body = ""
            req.on("data", (chunk) => {
                body += chunk.toString()
            })

            req.on("end", async () => {
                try {
                    let parsedBody: { projectId: string }
                    try {
                        parsedBody = JSON.parse(body)
                    } catch {
                        res.writeHead(400, { "Content-Type": "application/json" })
                        res.end(JSON.stringify({ error: "Invalid JSON in request body" }))
                        return
                    }

                    const { projectId } = parsedBody

                    validateIdentifier(projectId, "projectId")

                    const workspacePath = path.join(
                        process.cwd(),
                        "projects",
                        projectId
                    )

                    const session = await orchestrator.startVM(
                        projectId,
                        workspacePath
                    )

                    res.writeHead(200, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            success: true,
                            vmId: session.vmId,
                            vmIP: session.vmIP,
                            status: session.status
                        })
                    )
                } catch (error) {
                    console.error("[VMStart] Error:", error)
                    res.writeHead(500, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Internal server error"
                        })
                    )
                }
            })
        } else if (req.method === "POST" && req.url === "/api/vm/stop") {
            // Stop VM (cleans resources but keeps overlay disk)
            let body = ""
            req.on("data", (chunk) => {
                body += chunk.toString()
            })

            req.on("end", async () => {
                try {
                    let parsedBody: { projectId: string }
                    try {
                        parsedBody = JSON.parse(body)
                    } catch {
                        res.writeHead(400, { "Content-Type": "application/json" })
                        res.end(JSON.stringify({ error: "Invalid JSON in request body" }))
                        return
                    }

                    const { projectId } = parsedBody

                    validateIdentifier(projectId, "projectId")

                    const session = sessionManager.getSessionByProject(
                        projectId
                    )

                    if (!session) {
                        res.writeHead(404, {
                            "Content-Type": "application/json"
                        })
                        res.end(
                            JSON.stringify({
                                error: "VM session not found for this project"
                            })
                        )
                        return
                    }

                    // Close proxy connections
                    closeAllProxyConnections(session.vmId)

                    // Stop VM (keeps overlay disk)
                    await orchestrator.stopVM(session.vmId)

                    res.writeHead(200, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            success: true,
                            vmId: session.vmId
                        })
                    )
                } catch (error) {
                    console.error("[VMStop] Error:", error)
                    res.writeHead(500, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Internal server error"
                        })
                    )
                }
            })
        } else if (req.url === "/metrics") {
            // Prometheus metrics endpoint
            try {
                // Update active VM count and resource metrics before serving
                const sessions = sessionManager.getAllSessions()
                metrics.vmActiveCountUpdate(sessions.length)
                updateResourceMetrics()

                res.writeHead(200, {
                    "Content-Type": metricsRegistry.contentType
                })
                const metricsText = await metricsRegistry.metrics()
                res.end(metricsText)
            } catch (error) {
                console.error("[Metrics] Error:", error)
                res.writeHead(500, { "Content-Type": "text/plain" })
                res.end("Error generating metrics")
            }
        } else if (
            req.method === "GET" &&
            req.url?.startsWith("/api/fileserver-log/")
        ) {
            // GET /api/fileserver-log/{vmId} - Instructions for reading file server log
            const vmId = req.url.split("/api/fileserver-log/")[1]

            res.writeHead(200, { "Content-Type": "text/plain" })
            res.end(`File Server Debug Log for VM ${vmId}

The file server writes startup logs to /tmp/fileserver-startup.log inside the VM.

To read the log:
1. Connect to the VM terminal in your browser
2. Run: cat /tmp/fileserver-startup.log

To check systemd status:
  systemctl status fileserver.service
  journalctl -u fileserver.service -n 50

To check mount status:
  mount | grep /mnt/project
  ls -la /mnt/project`)
        } else if (req.method === "POST" && req.url === "/api/file-content") {
            // Handle file read requests from Next.js API routes
            let body = ""
            req.on("data", (chunk) => {
                body += chunk.toString()
            })

            req.on("end", async () => {
                try {
                    const { projectId, path } = JSON.parse(body) as {
                        projectId: string
                        path: string
                    }

                    // Find VM session
                    const allSessions = sessionManager.getAllSessions()
                    const session = allSessions.find(
                        (s) => s.projectId === projectId
                    )

                    if (!session) {
                        res.writeHead(404, {
                            "Content-Type": "application/json"
                        })
                        res.end(
                            JSON.stringify({
                                error: "VM session not found for this project"
                            })
                        )
                        return
                    }

                    // Get file server port for this VM
                    const vmId = session.vmId
                    const fileServerPort = getHostPortForVM(vmId, 8080)

                    // Forward read request to file server in VM
                    const response = await fetch(
                        `http://localhost:${fileServerPort}/api/files`,
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                type: "read",
                                requestId: `api-${Date.now()}`,
                                path
                            }),
                            signal: AbortSignal.timeout(5000)
                        }
                    )

                    if (!response.ok) {
                        throw new Error(
                            `File server error: ${response.statusText}`
                        )
                    }

                    const result = (await response.json()) as {
                        type: string
                        data?: { content?: string }
                    }

                    if (result.type === "error" || !result.data?.content) {
                        res.writeHead(404, {
                            "Content-Type": "application/json"
                        })
                        res.end(JSON.stringify({ error: "File not found" }))
                        return
                    }

                    res.writeHead(200, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ content: result.data.content }))
                } catch (error) {
                    console.error("[FileContent] Error:", error)
                    res.writeHead(500, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Internal server error"
                        })
                    )
                }
            })
        } else if (req.method === "DELETE" && req.url === "/api/project-overlay") {
            // Delete sandbox overlay disk (persistent OverlayFS + project files)
            let body = ""
            req.on("data", (chunk) => {
                body += chunk.toString()
            })

            req.on("end", async () => {
                try {
                    const { projectId } = JSON.parse(body) as {
                        projectId: string
                    }

                    validateIdentifier(projectId, "projectId")

                    const deletedFiles: string[] = []
                    const errors: string[] = []

                    // Stop any running VMs for this project (parallel for speed)
                    const projectSessions = orchestrator.getSessionManager().getAllSessions()
                        .filter(s => s.projectId === projectId)
                    
                    if (projectSessions.length > 0) {
                        console.log(`[DeleteDisk] Stopping ${projectSessions.length} VM(s) for project ${projectId}`)
                        
                        const stopResults = await Promise.allSettled(
                            projectSessions.map(session => {
                                // Close proxy connections first
                                closeAllProxyConnections(session.vmId)
                                return orchestrator.stopVM(session.vmId)
                                    .then(() => console.log(`[DeleteDisk] Stopped VM ${session.vmId}`))
                                    .catch(error => {
                                        console.warn(`[DeleteDisk] Failed to stop VM ${session.vmId}:`, error)
                                        throw error
                                    })
                            })
                        )
                        
                        // Track failures but continue with disk deletion
                        const failures = stopResults.filter(r => r.status === "rejected") as PromiseRejectedResult[]
                        for (const failure of failures) {
                            errors.push(`Failed to stop VM: ${failure.reason?.message || "Unknown error"}`)
                        }
                        
                        console.log(`[DeleteDisk] VM cleanup complete (${stopResults.length - failures.length}/${stopResults.length} succeeded)`)
                        
                        // Wait for processes to fully terminate and release file handles
                        await new Promise(resolve => setTimeout(resolve, 1000))
                        console.log(`[DeleteDisk] Waited for resource release`)
                    }

                    // Delete sandbox overlay disk (contains OverlayFS changes + project files)
                    try {
                        await deleteOverlayDisk(projectId)
                        deletedFiles.push(`${projectId}-overlay.ext4`)
                        console.log(`[DeleteDisk] Deleted overlay disk for project ${projectId}`)
                    } catch (error) {
                        errors.push(
                            `Failed to delete overlay disk: ${(error as Error).message}`
                        )
                        console.warn(
                            `[DeleteDisk] Failed to delete overlay disk:`,
                            error
                        )
                    }

                    res.writeHead(200, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            success: true,
                            deletedFiles,
                            errors: errors.length > 0 ? errors : undefined
                        })
                    )
                } catch (error) {
                    console.error("[DeleteDisk] Error:", error)
                    res.writeHead(500, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Internal server error"
                        })
                    )
                }
            })
        } else if (req.url?.startsWith("/api/proxy/")) {
            // HTTP Proxy to VM app server - handles any HTTP method
            // Format: /api/proxy/:projectId/:vmPort/*
            const urlParts = req.url.split("/").filter(p => p)
            
            if (urlParts.length < 4) {
                res.writeHead(400, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ error: "Invalid proxy URL format. Expected: /api/proxy/:projectId/:vmPort/*" }))
                return
            }

            const projectId = urlParts[2]
            const vmPort = parseInt(urlParts[3])
            const vmPath = urlParts.slice(4).join("/")

            const controller = new AbortController()
            let timeout: NodeJS.Timeout | null = null

            try {
                validateIdentifier(projectId, "projectId")

                if (isNaN(vmPort) || vmPort < 1 || vmPort > 65535) {
                    res.writeHead(400, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: "Invalid port number" }))
                    return
                }

                // Get existing session
                const session = sessionManager.getSessionByProject(projectId)
                
                if (!session) {
                    res.writeHead(404, { "Content-Type": "application/json" })
                    res.end(JSON.stringify({ error: "VM session not found" }))
                    return
                }

                // Start port forward if not already running
                const hostPort = getHostPortForVM(session.vmId, vmPort)
                startPortForward({
                    vmId: session.vmId,
                    vmPort,
                    hostPort,
                    vmIP: session.vmIP
                })

                // Build upstream URL
                const reqUrl = new URL(req.url, `http://localhost:${VM_ORCHESTRATOR_PORT}`)
                const upstreamUrl = `http://localhost:${hostPort}/${vmPath}${reqUrl.search}`

                // Prepare headers
                const headers = new Headers()
                for (const [key, value] of Object.entries(req.headers)) {
                    if (value && !["host", "connection", "content-length", "accept-encoding"].includes(key.toLowerCase())) {
                        headers.set(key, Array.isArray(value) ? value[0] : value)
                    }
                }

                timeout = setTimeout(() => controller.abort(), 30000)
                const abortOnClose = () => controller.abort()

                req.once("aborted", abortOnClose)
                req.once("close", abortOnClose)
                res.once("close", abortOnClose)

                // Read body if present
                const hasBody = !["GET", "HEAD"].includes(req.method || "GET")
                let bodyData: Uint8Array | null = null

                if (hasBody) {
                    const chunks: Buffer[] = []
                    let totalBytes = 0
                    for await (const chunk of req) {
                        totalBytes += chunk.length
                        if (totalBytes > MAX_PROXY_BODY_SIZE) {
                            if (timeout) clearTimeout(timeout)
                            res.writeHead(413, { "Content-Type": "application/json" })
                            res.end(
                                JSON.stringify({
                                    error: "Request body too large"
                                })
                            )
                            return
                        }
                        chunks.push(chunk)
                    }
                    bodyData = new Uint8Array(Buffer.concat(chunks))
                }

                // Forward request to VM
                const upstreamResponse = await fetch(upstreamUrl, {
                    method: req.method,
                    headers,
                    body: bodyData as BodyInit | null | undefined,
                    redirect: "manual",
                    signal: controller.signal
                })

                // Forward response back
                res.writeHead(upstreamResponse.status, {
                    "content-type": upstreamResponse.headers.get("content-type") || "text/plain"
                })

                if (upstreamResponse.body) {
                    const reader = upstreamResponse.body.getReader()
                    await streamUpstreamResponse(reader, res, controller.signal)
                }

                if (!res.writableEnded && !res.destroyed) {
                    res.end()
                }
                if (timeout) clearTimeout(timeout)
            } catch (error) {
                if (timeout) clearTimeout(timeout)
                console.error("[Proxy] Error:", error)
                if (controller.signal.aborted || res.destroyed) {
                    return
                }
                if (!res.headersSent && !res.destroyed) {
                    res.writeHead(500, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Internal server error"
                        })
                    )
                } else if (!res.writableEnded && !res.destroyed) {
                    res.end()
                }
            }
        } else if (req.method === "POST" && req.url === "/api/port-forward") {
            // Create/ensure VM session and start port forward for a VM app port
            let body = ""
            req.on("data", (chunk) => {
                body += chunk.toString()
            })

            req.on("end", async () => {
                try {
                    const { projectId, vmPort } = JSON.parse(body) as {
                        projectId: string
                        vmPort?: number
                    }

                    validateIdentifier(projectId, "projectId")

                    const appPort =
                        typeof vmPort === "number" && vmPort > 0 ? vmPort : 5173

                    const workspacePath = path.join(
                        process.cwd(),
                        "projects",
                        projectId
                    )

                    const session = await orchestrator.startVM(
                        projectId,
                        workspacePath
                    )

                    const hostPort = getHostPortForVM(session.vmId, appPort)

                    startPortForward({
                        vmId: session.vmId,
                        vmPort: appPort,
                        hostPort,
                        vmIP: session.vmIP
                    })

                    res.writeHead(200, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            vmId: session.vmId,
                            hostPort,
                            vmPort: appPort
                        })
                    )
                } catch (error) {
                    console.error("[PortForward] Error:", error)
                    res.writeHead(500, { "Content-Type": "application/json" })
                    res.end(
                        JSON.stringify({
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Internal server error"
                        })
                    )
                }
            })
        } else {
            res.writeHead(404)
            res.end("Not Found")
        }
    })

    // Start WebSocket server for terminal
    const wsServer = createWebSocketServer(
        httpServer,
        sessionManager,
        orchestrator,
        metrics
    )

    // Start WebSocket proxy for file operations
    const fileOpsServer = createFileOperationsProxy(
        httpServer,
        sessionManager,
        orchestrator,
        metrics
    )

    // WebSocket proxy for VM app servers (socket.io, etc.)
    httpServer.on("upgrade", (req, socket) => {
        // Check if this is a proxy WebSocket upgrade
        if (req.url?.startsWith("/api/proxy/")) {
            const urlParts = req.url.split("/").filter(p => p)
            
            if (urlParts.length < 4) {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
                socket.destroy()
                return
            }

            const projectId = urlParts[2]
            const vmPort = parseInt(urlParts[3])

            try {
                validateIdentifier(projectId, "projectId")

                if (isNaN(vmPort) || vmPort < 1 || vmPort > 65535) {
                    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
                    socket.destroy()
                    return
                }

                // Get existing session
                const session = sessionManager.getSessionByProject(projectId)
                
                if (!session) {
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n")
                    socket.destroy()
                    return
                }

                // Start port forward if not already running
                const hostPort = getHostPortForVM(session.vmId, vmPort)
                startPortForward({
                    vmId: session.vmId,
                    vmPort,
                    hostPort,
                    vmIP: session.vmIP
                })

                // Connect to the forwarded port
                const upstreamSocket = net.connect(hostPort, "localhost")

                // Track connection for cleanup when VM stops
                trackProxyConnection(session.vmId, socket)
                trackProxyConnection(session.vmId, upstreamSocket)

                upstreamSocket.on("connect", () => {
                    // Forward the upgrade request
                    const vmPath = urlParts.slice(4).join("/")
                    const path = vmPath ? `/${vmPath}` : "/"
                    
                    upstreamSocket.write(
                        `${req.method} ${path} HTTP/1.1\r\n` +
                        Object.entries(req.headers)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join("\r\n") +
                        "\r\n\r\n"
                    )

                    // Pipe bidirectionally
                    socket.pipe(upstreamSocket)
                    upstreamSocket.pipe(socket)
                })

                upstreamSocket.on("error", (err) => {
                    console.error("[ProxyWS] Upstream socket error:", err)
                    socket.destroy()
                })

                socket.on("error", (err) => {
                    console.error("[ProxyWS] Client socket error:", err)
                    upstreamSocket.destroy()
                })

                socket.on("close", () => {
                    upstreamSocket.destroy()
                })

                upstreamSocket.on("close", () => {
                    socket.destroy()
                })
            } catch (error) {
                console.error("[ProxyWS] Error:", error)
                socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n")
                socket.destroy()
            }
        }
        // Otherwise, let other upgrade handlers process it (terminal, file-ops)
    })

    httpServer.listen(VM_ORCHESTRATOR_PORT, () => {
        console.log(
            `[VMOrchestrator] WebSocket server listening on port ${VM_ORCHESTRATOR_PORT}`
        )
        console.log(
            `[VMOrchestrator] Health check: http://localhost:${VM_ORCHESTRATOR_PORT}/health`
        )
        console.log(
            `[VMOrchestrator] Metrics: http://localhost:${VM_ORCHESTRATOR_PORT}/metrics`
        )
    })

    // Graceful shutdown
    const shutdown = async () => {
        console.log("[VMOrchestrator] Shutting down...")

        clearInterval(metricsInterval)
        sessionManager.stopCleanup()
        wsServer.shutdown()
        fileOpsServer.close()
        await orchestrator.stopAllVMs()

        // Cleanup network resources
        await networkManager.cleanupAllTapDevices()

        httpServer.close(() => {
            console.log("[VMOrchestrator] Server closed")
            process.exit(0)
        })

        // Force exit after 10 seconds
        setTimeout(() => {
            console.error("[VMOrchestrator] Forced shutdown")
            process.exit(1)
        }, 10000)
    }

    process.on("SIGTERM", shutdown)
    process.on("SIGINT", shutdown)

    process.on("uncaughtException", (error) => {
        console.error("[VMOrchestrator] UNCAUGHT EXCEPTION:", error)
        // Give time for logs to be written
        setTimeout(() => process.exit(1), 100)
    })

    process.on("unhandledRejection", (reason, promise) => {
        console.error(
            "[VMOrchestrator] UNHANDLED REJECTION at:",
            promise,
            "reason:",
            reason
        )
    })

    console.log("[VMOrchestrator] Service started successfully")
}

main().catch((error) => {
    console.error("[VMOrchestrator] Fatal error:", error)
    process.exit(1)
})
