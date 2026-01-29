/**
 * Port Forwarder - Bridges VM internal port to host port using direct TCP
 *
 * Architecture:
 * Browser → Host Port (9000+) → Node.js TCP Server → Direct TCP → VM Port (8080)
 *
 * Uses TAP network for direct TCP connection to VM
 */

import net from "net"
import fs from "fs"
import { getVsockPath } from "./firecracker-config"
import { PORT_FORWARD_MIN, PORT_FORWARD_MAX } from "./config"

interface PortForwardConfig {
    vmId: string
    vmPort: number // Port inside VM (e.g., 8080)
    hostPort: number // Port on host (e.g., 9001)
    vmIP?: string // Direct TCP target (e.g., 172.20.0.2)
}

const PORT_FORWARD_LOG = "/tmp/vm-orchestrator/port-forward.log"

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
        fs.appendFileSync(PORT_FORWARD_LOG, `${line}\n`)
    } catch {
        // Ignore disk logging failures
    }
}

// Hoisted helper - start vsock proxy for a client socket
function startVsockProxy(
    clientSocket: net.Socket,
    vsockPath: string,
    vmPort: number,
    hostPort: number
): void {
    let handshakeComplete = false

    logBoth(`[PortForward:${hostPort}] start-vsock-proxy`, {
        vsockPath,
        vmPort
    })

    const vsockSocket = net.connect(vsockPath, () => {
        logBoth(`[PortForward:${hostPort}] vsock-connected`, {
            vsockPath
        })
        vsockSocket.write(`CONNECT ${vmPort}\n`)
    })

    const onFirecrackerHandshake = (data: Buffer) => {
        if (handshakeComplete) return

        const dataStr = data.toString()

        if (dataStr.startsWith("OK")) {
            handshakeComplete = true

            vsockSocket.removeListener("data", onFirecrackerHandshake)

            const okLineEnd = dataStr.indexOf("\n")
            if (okLineEnd !== -1 && okLineEnd < data.length - 1) {
                const remainingData = data.slice(okLineEnd + 1)
                clientSocket.write(remainingData)
            }

            logBoth(`[PortForward:${hostPort}] vsock-handshake-complete`, {
                vmPort
            })
            clientSocket.pipe(vsockSocket)
            vsockSocket.pipe(clientSocket)
            return
        }

        logBoth(`[PortForward:${hostPort}] vsock-unexpected-response`, {
            response: dataStr.trim()
        })
        cleanup()
    }

    vsockSocket.on("data", onFirecrackerHandshake)

    let isCleanedUp = false
    const cleanup = () => {
        if (isCleanedUp) return
        isCleanedUp = true

        clientSocket.removeAllListeners()
        vsockSocket.removeListener("data", onFirecrackerHandshake)
        vsockSocket.removeAllListeners()

        if (!clientSocket.destroyed) clientSocket.destroy()
        if (!vsockSocket.destroyed) vsockSocket.destroy()
    }

    const clientErrorHandler = (err: Error) => {
        logBoth(`[PortForward:${hostPort}] client-socket-error`, {
            error: err.message
        })
        cleanup()
    }

    const vsockErrorHandler = (err: Error) => {
        logBoth(`[PortForward:${hostPort}] vsock-socket-error`, {
            vsockPath,
            error: err.message
        })
        cleanup()
    }

    clientSocket.on("error", clientErrorHandler)
    vsockSocket.on("error", vsockErrorHandler)
    clientSocket.on("close", cleanup)
    vsockSocket.on("close", cleanup)
}

// Active port forwarders
const forwarders = new Map<string, net.Server>()
// Track active connections per forwarder for proper cleanup
const activeConnections = new Map<string, Set<net.Socket>>()
// Port allocations - maps vmId:vmPort to assigned host port (prevents collisions)
const portAllocations = new Map<string, number>()
// Track freed ports for reuse (prevents port exhaustion)
const freedPorts: number[] = []
let nextAvailablePort = PORT_FORWARD_MIN
const MAX_PORT = PORT_FORWARD_MAX // Configurable via env vars (default: 9000-19999, 11000 ports)

// Hoisted helper - Generate host port from vmId (collision-safe)
export function getHostPortForVM(vmId: string, vmPort: number = 8080): number {
    const allocationKey = `${vmId}:${vmPort}`

    // Return existing allocation if present
    if (portAllocations.has(allocationKey)) {
        return portAllocations.get(allocationKey)!
    }

    // Reuse freed port if available (prevents exhaustion)
    let port: number
    if (freedPorts.length > 0) {
        port = freedPorts.pop()!
    } else {
        // Allocate new port
        if (nextAvailablePort > MAX_PORT) {
            throw new Error("Port pool exhausted - too many VMs running")
        }
        port = nextAvailablePort++
    }

    portAllocations.set(allocationKey, port)
    return port
}

export function startPortForward(config: PortForwardConfig): number {
    const { vmId, vmPort, hostPort, vmIP } = config
    const forwardKey = `${vmId}:${vmPort}`

    // Check if already running
    const existing = forwarders.get(forwardKey)
    if (existing && existing.listening) {
        return hostPort
    }

    const vsockPath = getVsockPath(vmId)

    logBoth(`[PortForward:${hostPort}] start-port-forward`, {
        vmId,
        vmPort,
        hostPort,
        vsockPath,
        vmIP
    })

    // Create TCP server that proxies to VM over direct TCP
    const tcpServer = net.createServer((clientSocket) => {
        logBoth(`[PortForward:${hostPort}] client-connected`)

        // Track connection for cleanup
        if (!activeConnections.has(forwardKey)) {
            activeConnections.set(forwardKey, new Set())
        }
        activeConnections.get(forwardKey)!.add(clientSocket)

        // Remove from tracking when closed
        const removeFromTracking = () => {
            activeConnections.get(forwardKey)?.delete(clientSocket)
        }
        clientSocket.once("close", removeFromTracking)

        // If vmIP is provided, connect directly to VM over TAP network
        if (vmIP) {
            const vmSocket = net.connect(vmPort, vmIP)
            let connectTimeout: NodeJS.Timeout | null = null

            connectTimeout = setTimeout(() => {
                logBoth(`[PortForward:${hostPort}] vm-connect-timeout`, {
                    vmIP,
                    vmPort
                })
                cleanup()
            }, 3000)

            // Buffer client data until VM connection is ready
            let clientBuffer: Buffer[] = []
            let vmConnected = false
            const MAX_BUFFER_SIZE = 1024 * 1024 // 1MB max buffer to prevent memory exhaustion

            let isCleanedUp = false
            const cleanup = () => {
                if (isCleanedUp) return
                isCleanedUp = true

                if (connectTimeout) {
                    clearTimeout(connectTimeout)
                    connectTimeout = null
                }

                // Clear buffer to prevent memory leak
                clientBuffer = []

                clientSocket.removeAllListeners()
                vmSocket.removeAllListeners()

                if (!clientSocket.destroyed) clientSocket.destroy()
                if (!vmSocket.destroyed) vmSocket.destroy()
            }

            const clientErrorHandler = (err: Error) => {
                logBoth(`[PortForward:${hostPort}] client-socket-error`, {
                    error: err.message
                })
                cleanup()
            }

            const vmErrorHandler = (err: Error) => {
                logBoth(`[PortForward:${hostPort}] vm-socket-error`, {
                    vmIP,
                    vmPort,
                    error: err.message
                })
                cleanup()
            }

            const clientDataHandler = (data: Buffer) => {
                if (vmConnected) {
                    vmSocket.write(data)
                } else {
                    // Check buffer size to prevent memory exhaustion
                    const currentBufferSize = clientBuffer.reduce(
                        (sum, buf) => sum + buf.length,
                        0
                    )
                    if (currentBufferSize + data.length > MAX_BUFFER_SIZE) {
                        logBoth(`[PortForward:${hostPort}] buffer-overflow`, {
                            currentSize: currentBufferSize,
                            maxSize: MAX_BUFFER_SIZE
                        })
                        cleanup()
                        return
                    }
                    clientBuffer.push(data)
                }
            }

            clientSocket.on("data", clientDataHandler)

            vmSocket.on("connect", () => {
                if (connectTimeout) {
                    clearTimeout(connectTimeout)
                    connectTimeout = null
                }

                logBoth(`[PortForward:${hostPort}] vm-socket-connected`, {
                    vmIP,
                    vmPort,
                    bufferedBytes: clientBuffer.reduce(
                        (sum, buf) => sum + buf.length,
                        0
                    )
                })

                vmConnected = true

                // Flush buffered data to VM
                for (const bufferedData of clientBuffer) {
                    vmSocket.write(bufferedData)
                }
                clientBuffer = []

                // Race condition check: ensure cleanup hasn't been called
                if (isCleanedUp) return

                // Remove data handler and use pipes for remaining data
                clientSocket.removeListener("data", clientDataHandler)
                clientSocket.pipe(vmSocket)
                vmSocket.pipe(clientSocket)
            })

            clientSocket.on("error", clientErrorHandler)
            vmSocket.on("error", vmErrorHandler)
            clientSocket.on("close", cleanup)
            vmSocket.on("close", cleanup)
            return
        }

        startVsockProxy(clientSocket, vsockPath, vmPort, hostPort)
    })

    tcpServer.on("error", (err) => {
        logBoth(`[PortForward] tcp-server-error`, {
            error: err.message
        })
        forwarders.delete(forwardKey)
    })

    tcpServer.listen(hostPort, "127.0.0.1", () => {
        logBoth(`[PortForward:${hostPort}] listening`, {
            hostPort,
            vmId,
            vmPort
        })
    })

    forwarders.set(forwardKey, tcpServer)

    return hostPort
}

export function stopPortForward(vmId: string, vmPort: number): void {
    const forwardKey = `${vmId}:${vmPort}`
    const forwarder = forwarders.get(forwardKey)

    if (!forwarder) {
        return
    }

    // Close all active connections
    const connections = activeConnections.get(forwardKey)
    if (connections) {
        for (const socket of connections) {
            if (!socket.destroyed) {
                socket.destroy()
            }
        }
        activeConnections.delete(forwardKey)
    }

    if (forwarder.listening) {
        forwarder.close()
    }

    forwarders.delete(forwardKey)
    // Free port for reuse
    const port = portAllocations.get(forwardKey)
    if (port !== undefined) {
        freedPorts.push(port)
        portAllocations.delete(forwardKey)
    }
}

export function stopAllPortForwards(vmId: string): void {
    for (const [key, forwarder] of forwarders) {
        if (key.startsWith(`${vmId}:`)) {
            // Close all active connections
            const connections = activeConnections.get(key)
            if (connections) {
                for (const socket of connections) {
                    if (!socket.destroyed) {
                        socket.destroy()
                    }
                }
                activeConnections.delete(key)
            }

            if (forwarder.listening) {
                forwarder.close()
            }
            forwarders.delete(key)
            // Free port for reuse
            const port = portAllocations.get(key)
            if (port !== undefined) {
                freedPorts.push(port)
                portAllocations.delete(key)
            }
        }
    }
}
