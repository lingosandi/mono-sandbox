/**
 * WebSocket File Operations Hook
 *
 * Connects to the VM's file server via WebSocket proxy
 * Following CodeSandbox pattern: Browser → WebSocket → Host Proxy → VM file server
 */

import { useEffect, useRef, useCallback, useState } from "react"

interface FileOperationMessage {
    type: "connect" | "list" | "read" | "write" | "create" | "delete" | "rename"
    requestId: string
    path?: string
    content?: string
    newPath?: string
    fileType?: "file" | "directory"
    projectId?: string
    depth?: number
}

interface FileOperationResponse {
    type: "success" | "error" | "file-changed"
    requestId: string
    data?: {
        connected?: boolean
        vmId?: string
        content?: string
        success?: boolean
        tree?: unknown
        changes?: Array<{ event: string; path: string }> // For file-changed type
    }
    error?: string
}

interface FileOperationConfig {
    projectId: string
    onConnected?: () => void
    onError?: (error: Error) => void
    onFileChanged?: () => void // Callback when files change in VM
}

export function useFileOperations(config: FileOperationConfig) {
    const wsRef = useRef<WebSocket | null>(null)
    const pendingRequests = useRef<
        Map<
            string,
            {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                resolve: (data: any) => void
                reject: (error: Error) => void
            }
        >
    >(new Map())
    const requestIdCounter = useRef(0)
    const [isConnected, setIsConnected] = useState(false)
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)

    // Generate unique request ID
    const generateRequestId = useCallback(() => {
        requestIdCounter.current += 1
        return `req_${Date.now()}_${requestIdCounter.current}`
    }, [])

    // Send message and wait for response
    const sendRequest = useCallback(
        async <T = unknown>(
            message: Omit<FileOperationMessage, "requestId">
        ): Promise<T> => {
            return new Promise((resolve, reject) => {
                if (
                    !wsRef.current ||
                    wsRef.current.readyState !== WebSocket.OPEN
                ) {
                    reject(new Error("WebSocket not connected"))
                    return
                }

                const requestId = generateRequestId()
                const fullMessage: FileOperationMessage = {
                    ...message,
                    requestId
                }

                // Store pending request
                pendingRequests.current.set(requestId, { resolve, reject })

                // Send message
                wsRef.current.send(JSON.stringify(fullMessage))

                // Timeout after 30 seconds
                setTimeout(() => {
                    const pending = pendingRequests.current.get(requestId)
                    if (pending) {
                        pendingRequests.current.delete(requestId)
                        reject(new Error("Request timeout"))
                    }
                }, 30000)
            })
        },
        [generateRequestId]
    )

    // File operations
    const listFiles = useCallback(
        async (path?: string, depth: number = 1) => {
            return sendRequest<{ tree: unknown }>({
                type: "list",
                path,
                depth
            })
        },
        [sendRequest]
    )

    const readFile = useCallback(
        async (path: string) => {
            return sendRequest<{ content: string }>({ type: "read", path })
        },
        [sendRequest]
    )

    const writeFile = useCallback(
        async (path: string, content: string) => {
            return sendRequest<{ success: boolean }>({
                type: "write",
                path,
                content
            })
        },
        [sendRequest]
    )

    const createItem = useCallback(
        async (path: string, fileType: "file" | "directory") => {
            return sendRequest<{ success: boolean }>({
                type: "create",
                path,
                fileType
            })
        },
        [sendRequest]
    )

    const deleteItem = useCallback(
        async (path: string) => {
            return sendRequest<{ success: boolean }>({ type: "delete", path })
        },
        [sendRequest]
    )

    const renameItem = useCallback(
        async (path: string, newPath: string) => {
            return sendRequest<{ success: boolean }>({
                type: "rename",
                path,
                newPath
            })
        },
        [sendRequest]
    )

    const { projectId, onConnected, onError, onFileChanged } = config

    useEffect(() => {
        const pendingReqs = pendingRequests.current
        let isCleanedUp = false
        let ws: WebSocket | null = null

        const connect = () => {
            if (isCleanedUp) return

            const wsUrl =
                process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3003"
            ws = new WebSocket(`${wsUrl}/file-operations`)
            wsRef.current = ws

            ws.onopen = () => {
                if (isCleanedUp) {
                    ws?.close()
                    return
                }

                // Send connect message
                const connectMessage: FileOperationMessage = {
                    type: "connect",
                    requestId: generateRequestId(),
                    projectId
                }
                ws?.send(JSON.stringify(connectMessage))
            }

            ws.onmessage = (event) => {
                if (isCleanedUp) return

                try {
                    const response = JSON.parse(
                        event.data
                    ) as FileOperationResponse

                    // Handle file change notifications
                    if (response.type === "file-changed") {
                        onFileChanged?.()
                        return
                    }

                    if (
                        response.type === "success" &&
                        response.data?.connected
                    ) {
                        setIsConnected(true)
                        onConnected?.()
                        return
                    }

                    // Handle pending request response
                    const pending = pendingRequests.current.get(
                        response.requestId
                    )
                    if (pending) {
                        pendingRequests.current.delete(response.requestId)
                        if (response.type === "success") {
                            pending.resolve(response.data)
                        } else {
                            pending.reject(
                                new Error(response.error || "Unknown error")
                            )
                        }
                    }
                } catch (error) {
                    console.error("Failed to parse WebSocket message:", error)
                }
            }

            ws.onerror = () => {
                // Don't log errors during cleanup (React Strict Mode)
                if (!isCleanedUp) {
                    onError?.(new Error("WebSocket connection error"))
                }
            }

            ws.onclose = () => {
                if (isCleanedUp) return

                setIsConnected(false)
                wsRef.current = null

                // Clear pending requests
                for (const pending of pendingRequests.current.values()) {
                    pending.reject(new Error("Connection closed"))
                }
                pendingRequests.current.clear()

                // Reconnect after 3 seconds
                reconnectTimeoutRef.current = setTimeout(() => {
                    if (!isCleanedUp) {
                        connect()
                    }
                }, 3000)
            }
        }

        connect()

        return () => {
            isCleanedUp = true
            setIsConnected(false)

            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current)
                reconnectTimeoutRef.current = null
            }

            // Capture pending requests before cleanup
            for (const pending of pendingReqs.values()) {
                pending.reject(new Error("Component unmounted"))
            }
            pendingReqs.clear()

            // Clean up WebSocket - both ws and wsRef.current point to same object
            if (ws && ws.readyState !== WebSocket.CLOSED) {
                // Remove error handler to prevent "closed before established" log in React Strict Mode
                ws.onerror = null
                ws.onclose = null
                ws.onmessage = null
                ws.close()
            }
            ws = null
            wsRef.current = null
        }
    }, [
        projectId,
        onConnected,
        onError,
        onFileChanged,
        generateRequestId
    ])

    return {
        listFiles,
        readFile,
        writeFile,
        createItem,
        deleteItem,
        renameItem,
        isConnected
    }
}
