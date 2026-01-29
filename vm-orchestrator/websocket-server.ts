import { WebSocketServer, WebSocket } from "ws"
import { Server as HTTPServer, IncomingMessage } from "http"
import { Socket as NetSocket } from "net"
import { TerminalMessage, VMSession } from "./types"
import { SessionManager } from "./session-manager"
import { VMOrchestrator } from "./vm-orchestrator"
import { Socket } from "net"
import { getVsockPath } from "./firecracker-config"
import type { MetricsType } from "./metrics"
import {
    VSOCK_TERMINAL_PORT,
    ENABLE_VERBOSE_STARTUP_LOGS
} from "./config"
import path from "path"

type PtyProcess = {
    onData: (handler: (data: string) => void) => void
    onExit: (handler: (event: { exitCode: number }) => void) => void
    write: (data: string) => void
    resize?: (cols: number, rows: number) => void
    kill: () => void
}

type TerminalProcess = PtyProcess | Socket

function isPtyProcess(process: TerminalProcess): process is PtyProcess {
    return "onData" in process
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

// Hoisted helper functions
function parseMessage(data: string): TerminalMessage | null {
    try {
        return JSON.parse(data) as TerminalMessage
    } catch {
        return null
    }
}

function sendMessage(ws: WebSocket, message: TerminalMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message))
    }
}

function sendError(ws: WebSocket, error: string): void {
    sendMessage(ws, { type: "error", data: error })
}

// Hoisted helper - cleanup terminal PTY process or vsock socket
function cleanupTerminal(
    vmId: string,
    process: TerminalProcess,
    terminalProcesses: Map<string, TerminalProcess>
) {
    const currentProc = terminalProcesses.get(vmId)
    if (currentProc === process) {
        terminalProcesses.delete(vmId)
    }

    try {
        if ("kill" in process) {
            // IPty process
            process.kill()
        } else {
            // Socket
            process.destroy()
        }
    } catch (error) {
        console.error(`Failed to cleanup terminal for ${vmId}:`, error)
    }
}

// Hoisted helper - start terminal via Firecracker vsock
async function startTerminalVsock(
    session: VMSession,
    ws: WebSocket,
    sessionManager: SessionManager,
    terminalProcesses: Map<string, TerminalProcess>
): Promise<Socket> {
    const vsockPath = getVsockPath(session.vmId)
    let retries = 0
    const maxRetries = 60 // 60 seconds maximum (60 retries × 1s)
    const retryDelay = 1000
    const attemptStart = Date.now()

    while (retries < maxRetries) {
        try {
            console.log(
                `[Terminal] Vsock connection attempt ${retries + 1} for VM ${
                    session.vmId
                }`
            )

            const socket = await new Promise<Socket>((resolve, reject) => {
                const s = new Socket()
                let responded = false

                const timeout = setTimeout(() => {
                    if (!responded) {
                        responded = true
                        s.destroy()
                        reject(new Error("Handshake timeout"))
                    }
                }, 5000)

                const dataHandler = (data: Buffer) => {
                    if (responded) return
                    const response = data.toString()
                    if (response.startsWith("OK")) {
                        responded = true
                        clearTimeout(timeout)
                        s.removeListener("data", dataHandler)
                        s.removeListener("error", errorHandler)
                        s.removeListener("close", closeHandler)
                        resolve(s)
                    }
                }

                const errorHandler = (err: Error) => {
                    if (responded) return
                    responded = true
                    clearTimeout(timeout)
                    s.removeListener("data", dataHandler)
                    s.removeListener("error", errorHandler)
                    s.removeListener("close", closeHandler)
                    s.destroy()
                    reject(err)
                }

                const closeHandler = () => {
                    if (responded) return
                    responded = true
                    clearTimeout(timeout)
                    s.removeListener("data", dataHandler)
                    s.removeListener("error", errorHandler)
                    s.removeListener("close", closeHandler)
                    reject(new Error("Connection closed during handshake"))
                }

                s.connect(vsockPath, () => {
                    s.write(`CONNECT ${VSOCK_TERMINAL_PORT}\n`)
                })

                s.on("data", dataHandler)
                s.on("error", errorHandler)
                s.on("close", closeHandler)
            })

            console.log(
                `[Terminal] Vsock handshake complete for VM ${session.vmId}`
            )
            if (ENABLE_VERBOSE_STARTUP_LOGS) {
                const elapsed = Date.now() - attemptStart
                console.log(
                    `⏱️ [Terminal] Vsock ready for ${session.vmId} (${elapsed}ms, attempts ${retries + 1})`
                )
            }

            sendMessage(ws, {
                type: "output",
                vmId: session.vmId,
                data: `\r\n\x1b[32m[System] Connected to isolated VM (${session.vmId})\x1b[0m\r\n\r\n`
            })

            socket.on("data", (data) => {
                if (ws.readyState === WebSocket.OPEN) {
                    sendMessage(ws, {
                        type: "output",
                        vmId: session.vmId,
                        data: data.toString()
                    })
                    sessionManager.touchSession(session.vmId)
                }
            })

            socket.on("end", () => {
                if (ws.readyState === WebSocket.OPEN) {
                    sendMessage(ws, {
                        type: "exit",
                        vmId: session.vmId,
                        code: 0
                    })
                }
                cleanupTerminal(session.vmId, socket, terminalProcesses)
            })

            socket.on("error", (error) => {
                console.error(
                    `[Terminal] Vsock error for ${session.vmId}:`,
                    error
                )
                if (ws.readyState === WebSocket.OPEN) {
                    sendMessage(ws, {
                        type: "error",
                        data: `Connection error: ${error.message}`
                    })
                }
                cleanupTerminal(session.vmId, socket, terminalProcesses)
            })

            terminalProcesses.set(session.vmId, socket)
            return socket
        } catch (error) {
            retries++
            const errMessage =
                error instanceof Error ? error.message : String(error)
            if (ENABLE_VERBOSE_STARTUP_LOGS) {
                const elapsed = Date.now() - attemptStart
                console.log(
                    `⏱️ [Terminal] Vsock attempt ${retries} failed after ${elapsed}ms: ${errMessage}`
                )
            }
            console.log(
                `[Terminal] Vsock attempt ${retries} failed: ${errMessage}. Retrying in ${retryDelay}ms...`
            )
            
            // Check if session still exists before continuing retry loop
            const currentSession = sessionManager.getSession(session.vmId)
            if (!currentSession || currentSession.status === "stopping" || currentSession.status === "stopped") {
                console.log(`[Terminal] Session ${session.vmId} no longer exists or is stopping - aborting connection attempts`)
                throw new Error(`VM session ${session.vmId} was removed or stopped`)
            }
            
            await new Promise((resolve) => setTimeout(resolve, retryDelay))
        }
    }

    throw new Error(
        `Failed to establish terminal connection to VM ${session.vmId} after ${maxRetries} attempts`
    )
}

export function createWebSocketServer(
    httpServer: HTTPServer,
    sessionManager: SessionManager,
    orchestrator: VMOrchestrator,
    metrics?: MetricsType
) {
    const wss = new WebSocketServer({ noServer: true })
    const terminalProcesses = new Map<string, TerminalProcess>()

    // Manually handle upgrade for this path
    const upgradeHandler = (
        request: IncomingMessage,
        socket: NetSocket,
        head: Buffer
    ) => {
        if (request.url?.startsWith("/terminal")) {
            wss.handleUpgrade(request, socket, head, (ws) => {
                // Track WebSocket connection
                metrics?.wsConnection()
                
                wss.emit("connection", ws, request)
            })
        }
    }
    httpServer.on("upgrade", upgradeHandler)

    wss.on("connection", (ws) => {
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

        let currentSession: VMSession | null = null
        let currentTerminal: TerminalProcess | null = null
        let connectStartTime = 0

        ws.on("message", async (data) => {
            const message = parseMessage(data.toString())
            if (!message) {
                sendError(ws, "Invalid message format")
                return
            }

            try {
                switch (message.type) {
                    case "input": {
                        if (!currentSession || !currentTerminal) {
                            return
                        }

                        if (message.data) {
                            if (
                                "write" in currentTerminal &&
                                typeof currentTerminal.write === "function"
                            ) {
                                // IPty or Socket both have write()
                                currentTerminal.write(message.data)
                            }
                            sessionManager.touchSession(currentSession.vmId)
                        }
                        break
                    }

                    case "resize": {
                        if (currentTerminal && message.cols && message.rows) {
                            if (
                                isPtyProcess(currentTerminal) &&
                                currentTerminal.resize
                            ) {
                                currentTerminal.resize(
                                    message.cols,
                                    message.rows
                                )
                            } else if ("write" in currentTerminal) {
                                // Socket - send RESIZE message to C binary
                                currentTerminal.write(
                                    `RESIZE ${message.cols} ${message.rows}\n`
                                )
                            }
                        }
                        break
                    }

                    case "connect": {
                        const { projectId } = message
                        console.log(
                            `📡 [Terminal] Connect: project=${projectId}`
                        )
                        connectStartTime = Date.now()

                        if (!projectId) {
                            sendError(ws, "Missing projectId")
                            return
                        }

                        // Validate inputs to prevent path traversal attacks
                        try {
                            validateIdentifier(projectId, "projectId")
                        } catch (error) {
                            sendError(
                                ws,
                                error instanceof Error
                                    ? error.message
                                    : "Invalid input"
                            )
                            return
                        }

                        // Use absolute path to workspace projects directory
                        const workspacePath = path.join(
                            process.cwd(),
                            "projects",
                            projectId
                        )

                        const session = await orchestrator.startVM(
                            projectId,
                            workspacePath
                        )
                        if (ENABLE_VERBOSE_STARTUP_LOGS) {
                            const elapsed = Date.now() - connectStartTime
                            console.log(
                                `⏱️ [Terminal] VM session ready for ${session.vmId} (${elapsed}ms)`
                            )
                        }

                        // Check if client disconnected while we were starting the VM
                        if (ws.readyState !== WebSocket.OPEN) {
                            return
                        }

                        if (currentTerminal) {
                            if (currentSession) {
                                cleanupTerminal(
                                    currentSession.vmId,
                                    currentTerminal,
                                    terminalProcesses
                                )
                            } else {
                                if ("kill" in currentTerminal) {
                                    currentTerminal.kill()
                                } else {
                                    currentTerminal.destroy()
                                }
                            }
                        }

                        currentSession = session
                        currentTerminal = await startTerminalVsock(
                            session,
                            ws,
                            sessionManager,
                            terminalProcesses
                        )
                        if (ENABLE_VERBOSE_STARTUP_LOGS) {
                            const elapsed = Date.now() - connectStartTime
                            console.log(
                                `✅ [Terminal] Terminal ready for ${session.vmId} (${elapsed}ms)`
                            )
                        }

                        sendMessage(ws, {
                            type: "output",
                            vmId: session.vmId,
                            data: `\r\n\x1b[32m[System] Terminal ready (${session.vmId})\x1b[0m\r\n\r\n`
                        })
                        break
                    }

                    default: {
                        console.warn(
                            `[Terminal] Unknown message type: ${message.type}`
                        )
                    }
                }
            } catch (error) {
                console.error(`❌ [Terminal] Error:`, error)
                sendError(
                    ws,
                    `Error: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
            }
        })

        ws.on("close", () => {
            clearInterval(heartbeat)
            if (currentTerminal) {
                if (currentSession) {
                    cleanupTerminal(
                        currentSession.vmId,
                        currentTerminal,
                        terminalProcesses
                    )
                } else {
                    // No session but terminal exists - still need to cleanup
                    if ("kill" in currentTerminal) {
                        currentTerminal.kill()
                    } else {
                        currentTerminal.destroy()
                    }
                }
                currentTerminal = null
            }
            currentSession = null
        })

        ws.on("error", (error) => {
            console.error(`❌ [Terminal] WebSocket error:`, error)
            clearInterval(heartbeat)
            if (currentTerminal) {
                if (currentSession) {
                    cleanupTerminal(
                        currentSession.vmId,
                        currentTerminal,
                        terminalProcesses
                    )
                } else {
                    if ("kill" in currentTerminal) {
                        currentTerminal.kill()
                    } else {
                        currentTerminal.destroy()
                    }
                }
                currentTerminal = null
            }
            currentSession = null
        })
    })

    function shutdown() {
        console.log("[WebSocket] Shutting down")

        // Remove upgrade listener
        httpServer.off("upgrade", upgradeHandler)

        // Cleanup all terminals
        for (const proc of terminalProcesses.values()) {
            if ("kill" in proc) {
                proc.kill()
            } else {
                proc.destroy()
            }
        }
        terminalProcesses.clear()

        wss.close()
    }

    return { wss, shutdown }
}

export type WebSocketTerminalServer = ReturnType<typeof createWebSocketServer>
