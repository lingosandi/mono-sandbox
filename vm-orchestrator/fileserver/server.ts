/**
 * File Server - Runs INSIDE Firecracker VM
 * Hybrid HTTP + WebSocket server
 * - HTTP: File operations (list, read, write, create, delete, rename)
 * - WebSocket: Real-time file change notifications
 * - Chokidar: Watches /mnt/project, ignores node_modules/.git
 */

import http, { type IncomingMessage, type ServerResponse } from "http"
import { promises as fs } from "fs"
import fsSync from "fs"
import path from "path"
import { execSync } from "child_process"
import { WebSocketServer } from "ws"
import chokidar, { type FSWatcher } from "chokidar"

const PORT = 8080
const PROJECT_ROOT = "/mnt/project"
const MAX_DEPTH = 10
const MAX_DIR_ENTRIES = 1000
const CACHE_TTL_MS = 5000 // 5 seconds
const LOG_FILE = "/tmp/fileserver-startup.log"

type FileItemType = "directory" | "file"

type DirectoryItem = {
    name: string
    path: string
    type: FileItemType
    children?: DirectoryItem[]
}

type DirCacheEntry = {
    data: DirectoryItem[]
    timestamp: number
}

type FileOperationMessage = {
    type: "list" | "read" | "write" | "create" | "delete" | "rename"
    requestId?: string
    path?: string
    content?: string
    newPath?: string
    fileType?: FileItemType
    depth?: number
}

type FileChangeEvent = "add" | "change" | "unlink" | "addDir" | "unlinkDir"

type FileChange = {
    event: FileChangeEvent
    path: string
}

type FileServerInstance = http.Server & {
    wss?: WebSocketServer
    changeTimeout?: NodeJS.Timeout | null
    pendingChanges?: FileChange[] | null
    fileWatcher?: FSWatcher | null
}

// Cache for directory listings
const dirCache = new Map<string, DirCacheEntry>()

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

// Write to both console and log file - NEVER throw errors
function logBoth(message: string): void {
    // Always write to console first (most critical)
    try {
        console.log(message)
    } catch {
        // Even console.log can fail in extreme cases
    }
    return
    // Try to write to log file (best effort)
    try {
        const timestamp = new Date().toISOString()
        const line = `${timestamp} ${message}\n`
        fsSync.appendFileSync(LOG_FILE, line)
    } catch {
        // Silently ignore file write errors - don't prevent startup
    }
}

// Check if /mnt/project is mounted before starting
function checkProjectMounted(): boolean {
    try {
        if (!fsSync.existsSync(PROJECT_ROOT)) {
            logBoth(`[FileServer] ERROR: ${PROJECT_ROOT} does not exist`)
            return false
        }
        try {
            execSync(`mountpoint -q ${PROJECT_ROOT}`, { stdio: "pipe" })
            logBoth(`[FileServer] ✓ ${PROJECT_ROOT} is mounted`)
            return true
        } catch {
            logBoth(
                `[FileServer] ERROR: ${PROJECT_ROOT} exists but is not mounted (mountpoint check failed)`
            )
            return false
        }
    } catch (error) {
        logBoth(`[FileServer] ERROR checking mount: ${getErrorMessage(error)}`)
        return false
    }
}

// Wait for mount with retries
async function waitForMount(
    maxRetries = 10,
    retryDelayMs = 1000
): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
        if (checkProjectMounted()) return true
        if (i < maxRetries - 1) {
            logBoth(
                `[FileServer] Waiting for ${PROJECT_ROOT} to be mounted... (attempt ${i + 1}/${maxRetries})`
            )
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        }
    }
    logBoth(
        `[FileServer] FATAL: ${PROJECT_ROOT} not mounted after ${maxRetries} attempts`
    )
    return false
}

function parseRequestBody(
    req: IncomingMessage
): Promise<FileOperationMessage> {
    return new Promise((resolve, reject) => {
        let body = ""
        req.on("data", (chunk) => {
            body += chunk.toString()
        })
        req.on("end", () => {
            try {
                resolve(JSON.parse(body) as FileOperationMessage)
            } catch {
                reject(new Error("Invalid JSON"))
            }
        })
        req.on("error", reject)
    })
}

function sendJSON(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    })
    res.end(JSON.stringify(data))
}

// Invalidate cache for a path and its parents (all depth variants)
function invalidateCache(itemPath: string): void {
    const parts = itemPath.split(path.sep).filter(Boolean)
    for (let i = 0; i <= parts.length; i++) {
        const cachePath = parts.slice(0, i).join(path.sep)
        // Clear all depth variants
        for (let d = 0; d <= MAX_DEPTH; d++) {
            dirCache.delete(`${cachePath}:${d}`)
            dirCache.delete(`/${cachePath}:${d}`)
        }
        dirCache.delete(cachePath)
        dirCache.delete(`/${cachePath}`)
    }
    dirCache.delete("") // Root cache
    for (let d = 0; d <= MAX_DEPTH; d++) {
        dirCache.delete(`:${d}`)
    }
}

// Concurrent directory tree builder with caching and limits
async function buildDirectoryTree(
    dirPath: string,
    depth = 0,
    maxDepth = MAX_DEPTH
): Promise<DirectoryItem[]> {
    if (depth > maxDepth) {
        return [] // Prevent deep recursion
    }

    // Check cache
    const cacheKey = `${dirPath}:${maxDepth}`
    const cached = dirCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data
    }

    const fullPath = path.join(PROJECT_ROOT, dirPath)
    const entries = await fs.readdir(fullPath, { withFileTypes: true })

    if (entries.length > MAX_DIR_ENTRIES) {
        throw new Error(
            `Directory has too many entries (${entries.length} > ${MAX_DIR_ENTRIES})`
        )
    }

    // Process all entries concurrently
    const items = await Promise.all(
        entries.map(async (entry) => {
            const itemPath = path.join(dirPath, entry.name)

            const item: DirectoryItem = {
                name: entry.name,
                path: itemPath,
                type: entry.isDirectory() ? "directory" : "file"
            }

            if (entry.isDirectory()) {
                // For shallow mode (depth 0), don't load children
                if (depth < maxDepth) {
                    try {
                        item.children = await buildDirectoryTree(
                            itemPath,
                            depth + 1,
                            maxDepth
                        )
                    } catch (error) {
                        console.error(
                            `[FileServer] Error reading ${itemPath}:`,
                            getErrorMessage(error)
                        )
                        item.children = []
                    }
                } else {
                    // Mark as unexpanded for lazy loading
                    item.children = []
                }
            }

            return item
        })
    )

    // Cache the result
    dirCache.set(cacheKey, { data: items, timestamp: Date.now() })

    return items
}

async function listDirectory(
    dirPath: string,
    maxDepth = MAX_DEPTH
): Promise<DirectoryItem[]> {
    // For initial load, use shallow depth of 1 to load only top level
    return await buildDirectoryTree(dirPath || "", 0, maxDepth)
}

async function readFile(filePath: string): Promise<{ content: string; size: number }> {
    const fullPath = path.join(PROJECT_ROOT, filePath)
    const stats = await fs.stat(fullPath)
    const MAX_SIZE_FOR_MEMORY = 1024 * 1024 // 1MB

    // For large files, suggest streaming or chunking
    if (stats.size > MAX_SIZE_FOR_MEMORY) {
        console.log(
            `[FileServer] Large file detected (${stats.size} bytes), reading in chunks...`
        )
    }

    const content = await fs.readFile(fullPath, "utf-8")
    return { content, size: stats.size }
}

async function writeFile(
    filePath: string,
    content: string
): Promise<{ success: true }> {
    const fullPath = path.join(PROJECT_ROOT, filePath)
    const dir = path.dirname(fullPath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(fullPath, content, "utf-8")
    invalidateCache(path.dirname(filePath))
    return { success: true }
}

async function createItem(
    itemPath: string,
    fileType: FileItemType
): Promise<{ success: true }> {
    const fullPath = path.join(PROJECT_ROOT, itemPath)
    if (fileType === "directory") {
        await fs.mkdir(fullPath, { recursive: true })
    } else {
        const dir = path.dirname(fullPath)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(fullPath, "", "utf-8")
    }
    invalidateCache(path.dirname(itemPath))
    return { success: true }
}

async function deleteItem(itemPath: string): Promise<{ success: true }> {
    const fullPath = path.join(PROJECT_ROOT, itemPath)
    const stats = await fs.stat(fullPath)
    if (stats.isDirectory()) {
        await fs.rm(fullPath, { recursive: true, force: true })
    } else {
        await fs.unlink(fullPath)
    }
    invalidateCache(path.dirname(itemPath))
    return { success: true }
}

async function renameItem(
    oldPath: string,
    newPath: string
): Promise<{ success: true }> {
    const fullOldPath = path.join(PROJECT_ROOT, oldPath)
    const fullNewPath = path.join(PROJECT_ROOT, newPath)
    const newDir = path.dirname(fullNewPath)
    await fs.mkdir(newDir, { recursive: true })
    await fs.rename(fullOldPath, fullNewPath)
    invalidateCache(path.dirname(oldPath))
    invalidateCache(path.dirname(newPath))
    return { success: true }
}

async function handleFileOperation(message: FileOperationMessage): Promise<unknown> {
    const { type, path: itemPath, content, newPath, fileType, depth } = message
    switch (type) {
        case "list":
            return await listDirectory(itemPath || "", depth ?? 1)
        case "read":
            if (!itemPath) throw new Error("Missing path")
            return await readFile(itemPath)
        case "write":
            if (!itemPath) throw new Error("Missing path")
            if (content === undefined) throw new Error("Missing content")
            return await writeFile(itemPath, content)
        case "create":
            if (!itemPath) throw new Error("Missing path")
            if (!fileType) throw new Error("Missing fileType")
            return await createItem(itemPath, fileType)
        case "delete":
            if (!itemPath) throw new Error("Missing path")
            return await deleteItem(itemPath)
        case "rename":
            if (!itemPath) throw new Error("Missing path")
            if (!newPath) throw new Error("Missing newPath")
            return await renameItem(itemPath, newPath)
        default:
            throw new Error(`Unknown operation type: ${type}`)
    }
}

const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        sendJSON(res, 200, { ok: true })
        return
    }

    if (req.url === "/health") {
        sendJSON(res, 200, { status: "ok", timestamp: Date.now() })
        return
    }

    if (req.url === "/api/files" && req.method === "POST") {
        try {
            const message = await parseRequestBody(req)
            if (!message.requestId) throw new Error("Missing requestId")
            const result = await handleFileOperation(message)
            sendJSON(res, 200, {
                type: "success",
                requestId: message.requestId,
                data: result
            })
        } catch (error) {
            console.error("[FileServer] Error:", getErrorMessage(error))
            sendJSON(res, 500, {
                type: "error",
                requestId: "unknown",
                error: getErrorMessage(error)
            })
        }
        return
    }

    sendJSON(res, 404, { error: "Not found" })
}) as FileServerInstance

// Main startup - wait for mount before starting server
async function startServer(): Promise<void> {
    logBoth("[FileServer] ==================== STARTUP BEGIN ====================")
    logBoth("[FileServer] Starting up...")
    logBoth(`[FileServer] PID: ${process.pid}`)
    logBoth(`[FileServer] Runtime: ${process.versions?.bun ?? process.version}`)
    logBoth(`[FileServer] CWD: ${process.cwd()}`)
    logBoth(`[FileServer] Log file: ${LOG_FILE}`)

    // Wait for /mnt/project to be mounted
    logBoth("[FileServer] Checking for mounted project directory...")
    const mounted = await waitForMount(10, 1000)
    if (!mounted) {
        logBoth("[FileServer] ==================== FATAL ERROR ====================")
        logBoth("[FileServer] FATAL: Cannot start without mounted project directory")
        logBoth("[FileServer] Check: mount | grep overlay (initramfs overlay setup)")
        logBoth("[FileServer] Check: mount | grep /mnt/project")
        logBoth("[FileServer] Check: ls -la /dev/vdb")
        logBoth("[FileServer] Check: dmesg | grep overlay")
        logBoth("[FileServer] ======================================================")
        process.exit(1)
    }

    logBoth("[FileServer] ✓ Mount check passed, starting HTTP server...")

    // Start HTTP server with explicit error handling
    try {
        server.listen(PORT, "0.0.0.0", () => {
            logBoth(
                `[FileServer] ✅✅✅ HTTP SERVER LISTENING ON PORT ${PORT} ✅✅✅`
            )
            logBoth(`[FileServer] Serving files from ${PROJECT_ROOT}`)
            logBoth("[FileServer] Initializing WebSocket...")
            initWebSocket()
            logBoth("[FileServer] Initializing file watcher...")
            initFileWatcher()
            logBoth("[FileServer] ==================== STARTUP COMPLETE ====================")
        })

        server.on("error", (error: NodeJS.ErrnoException) => {
            logBoth("[FileServer] ==================== SERVER ERROR ====================")
            logBoth(`[FileServer] Server error: ${getErrorMessage(error)}`)
            logBoth(`[FileServer] Error code: ${error.code}`)
            if (error.code === "EADDRINUSE") {
                logBoth(`[FileServer] Port ${PORT} already in use`)
                logBoth("[FileServer] Check: lsof -i :8080")
            }
            logBoth("[FileServer] ======================================================")
            process.exit(1)
        })
    } catch (error) {
        logBoth(
            `[FileServer] Exception during server.listen: ${getErrorMessage(error)}`
        )
        process.exit(1)
    }
}

function initWebSocket(): void {
    const wss = new WebSocketServer({ server })

    wss.on("connection", (ws) => {
        console.log("[FileServer] WebSocket client connected")
        ws.on("close", () =>
            console.log("[FileServer] WebSocket client disconnected")
        )
        ws.on("error", (err) =>
            console.error("[FileServer] WebSocket error:", err)
        )
    })

    server.wss = wss
    console.log("[FileServer] WebSocket server ready")
}

function initFileWatcher(): void {
    console.log("[FileServer] Starting file watcher...")

    const watcher = chokidar.watch(PROJECT_ROOT, {
        ignored: /(^|[\/\\])(\..git|node_modules)($|[\/\\])/, 
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 300,
            pollInterval: 100
        }
    })

    // Store in server object so cleanup can access it
    server.changeTimeout = null
    server.pendingChanges = []

    const broadcastChanges = () => {
        if (!server.pendingChanges || server.pendingChanges.length === 0) return
        if (!server.wss) return

        const changes = [...server.pendingChanges]
        server.pendingChanges = []

        // Invalidate cache for all changed paths
        for (const change of changes) {
            invalidateCache(change.path)
        }

        const message = JSON.stringify({ type: "file-changed", changes })
        let clientCount = 0

        for (const client of server.wss.clients) {
            if (client.readyState === 1) {
                client.send(message)
                clientCount++
            }
        }

        if (clientCount > 0) {
            console.log(
                `[FileServer] Broadcast ${changes.length} changes to ${clientCount} clients`
            )
        }
    }

    const handleChange = (event: FileChangeEvent, filePath: string) => {
        const relativePath = path.relative(PROJECT_ROOT, filePath)
        server.pendingChanges?.push({ event, path: relativePath })

        if (server.changeTimeout) {
            clearTimeout(server.changeTimeout)
        }
        server.changeTimeout = setTimeout(broadcastChanges, 300)
    }

    watcher
        .on("add", (p) => handleChange("add", p))
        .on("change", (p) => handleChange("change", p))
        .on("unlink", (p) => handleChange("unlink", p))
        .on("addDir", (p) => handleChange("addDir", p))
        .on("unlinkDir", (p) => handleChange("unlinkDir", p))
        .on("error", (err) => console.error("[FileServer] Watcher error:", err))
        .on("ready", () => console.log("[FileServer] File watcher ready"))

    server.fileWatcher = watcher
}

function shutdown(): void {
    // Clear pending timer
    if (server.changeTimeout) {
        clearTimeout(server.changeTimeout)
        server.changeTimeout = null
    }
    // Clear pending changes array
    if (server.pendingChanges) {
        server.pendingChanges.length = 0
        server.pendingChanges = null
    }
    // Close watcher
    if (server.fileWatcher) {
        server.fileWatcher.close()
        server.fileWatcher = null
    }
    // Close WebSocket server
    if (server.wss) {
        server.wss.close()
        server.wss = undefined
    }
    // Close HTTP server
    server.close(() => process.exit(0))
}

// Start the server with comprehensive error logging
logBoth("[FileServer] ==================== SCRIPT LOADED ====================")
logBoth("[FileServer] Starting initialization...")

try {
    startServer().catch((error) => {
        logBoth("[FileServer] ==================== UNCAUGHT ERROR ====================")
        logBoth(
            `[FileServer] Fatal startup error: ${getErrorMessage(error)}`
        )
        if (error instanceof Error && error.stack) {
            logBoth(`[FileServer] Stack trace:\n${error.stack}`)
        }
        logBoth(
            "[FileServer] ================================================================"
        )
        process.exit(1)
    })
} catch (syncError) {
    logBoth("[FileServer] ==================== SYNCHRONOUS ERROR ====================")
    logBoth(`[FileServer] Sync error: ${getErrorMessage(syncError)}`)
    process.exit(1)
}

// Catch any unhandled rejections
process.on("unhandledRejection", (reason) => {
    logBoth("[FileServer] ==================== UNHANDLED REJECTION ====================")
    logBoth(`[FileServer] Reason: ${getErrorMessage(reason)}`)
    if (reason instanceof Error && reason.stack) {
        logBoth(`[FileServer] Stack: ${reason.stack}`)
    }
    process.exit(1)
})

// Catch any uncaught exceptions
process.on("uncaughtException", (error) => {
    logBoth("[FileServer] ==================== UNCAUGHT EXCEPTION ====================")
    logBoth(`[FileServer] Error: ${getErrorMessage(error)}`)
    if (error instanceof Error && error.stack) {
        logBoth(`[FileServer] Stack: ${error.stack}`)
    }
    process.exit(1)
})

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)