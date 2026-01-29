"use client"

import { useEffect, useRef } from "react"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { toast } from "sonner"

interface TerminalProps {
    projectId?: string
    resizeTrigger?: boolean
}

export function Terminal({ projectId, resizeTrigger }: TerminalProps) {
    const terminalRef = useRef<HTMLDivElement>(null)
    const xtermRef = useRef<XTerm | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)
    const wsRef = useRef<WebSocket | null>(null)

    useEffect(() => {
        if (!terminalRef.current || xtermRef.current) return
        if (!projectId) return

        let isCleanedUp = false
        let ws: WebSocket | null = null
        let term: XTerm | null = null

        const initTerminal = () => {
            // Create terminal instance
            term = new XTerm({
                cursorBlink: true,
                convertEol: true,
                fontSize: 13,
                fontFamily:
                    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
                lineHeight: 1.4,
                theme: {
                    background: "#0c0c0e",
                    foreground: "#d4d4d8",
                    cursor: "#d4d4d8",
                    black: "#18181b",
                    red: "#ef4444",
                    green: "#22c55e",
                    yellow: "#eab308",
                    blue: "#3b82f6",
                    magenta: "#a855f7",
                    cyan: "#06b6d4",
                    white: "#e4e4e7",
                    brightBlack: "#52525b",
                    brightRed: "#f87171",
                    brightGreen: "#4ade80",
                    brightYellow: "#facc15",
                    brightBlue: "#60a5fa",
                    brightMagenta: "#c084fc",
                    brightCyan: "#22d3ee",
                    brightWhite: "#fafafa"
                },
                allowTransparency: true
            })

            const fitAddon = new FitAddon()
            term.loadAddon(fitAddon)

            if (isCleanedUp) {
                term.dispose()
                return
            }

            term.open(terminalRef.current!)

            // Register input handler IMMEDIATELY after opening - CRITICAL for onData to work
            const onDataDisposable = term.onData((data) => {
                if (!isCleanedUp && ws?.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "input", data }))
                }
            })

            // Register resize handler
            const onResizeDisposable = term.onResize(({ cols, rows }) => {
                if (!isCleanedUp && ws?.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "resize", cols, rows }))
                }
            })

            // Check cleanup after async operation
            if (isCleanedUp) {
                onDataDisposable.dispose()
                onResizeDisposable.dispose()
                term.dispose()
                return
            }

            fitAddon.fit()

            xtermRef.current = term
            fitAddonRef.current = fitAddon

            // Connect to WebSocket server (no auth required)
            const wsUrl =
                process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3003"
            ws = new WebSocket(`${wsUrl}/terminal`)
            wsRef.current = ws

            ws.onopen = () => {
                if (isCleanedUp) {
                    ws?.close()
                    return
                }

                term?.writeln("Connecting to sandbox environment...")

                ws?.send(
                    JSON.stringify({
                        type: "connect",
                        projectId: projectId || "demo-project"
                    })
                )
            }

            ws.onmessage = (event) => {
                if (isCleanedUp) return

                ws!.send(
                    JSON.stringify({
                        type: "resize",
                        cols: term!.cols,
                        rows: term!.rows
                    })
                )

                try {
                    const message = JSON.parse(event.data)

                    switch (message.type) {
                        case "output":
                            if (message.data) {
                                // Check for OSC sequences before writing to terminal
                                // OSC format: \x1b]99;<json>\x07
                                const oscPattern = /\x1b\]99;(.+?)\x07/g
                                let cleanedData = message.data
                                let match

                                while (
                                    (match = oscPattern.exec(message.data)) !==
                                    null
                                ) {
                                    try {
                                        // Parse the JSON payload from OSC sequence
                                        const oscPayload = JSON.parse(match[1])

                                        // Handle toast messages
                                        if (
                                            oscPayload.type === "toast" &&
                                            oscPayload.data?.message
                                        ) {
                                            toast(oscPayload.data.message)
                                        }

                                        // Handle stream messages
                                        if (
                                            oscPayload.type === "stream" &&
                                            oscPayload.data?.url
                                        ) {
                                            // Find the iframe and call showAgentStream
                                            const iframe =
                                                document.querySelector(
                                                    'iframe[src="/mono-app/index.html"]'
                                                ) as HTMLIFrameElement
                                            if (
                                                iframe?.contentWindow &&
                                                "showAgentStream" in
                                                    iframe.contentWindow
                                            ) {
                                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                (iframe.contentWindow as any).showAgentStream(
                                                    oscPayload.data.url
                                                )
                                            }
                                        }

                                        // Remove OSC sequence from terminal output
                                        cleanedData = cleanedData.replace(
                                            match[0],
                                            ""
                                        )
                                    } catch {
                                        // Silently ignore malformed OSC sequences
                                    }
                                }

                                // Write cleaned data (without OSC sequences) to terminal
                                term?.write(cleanedData)
                            }
                            break
                        case "error":
                            term?.writeln(
                                `\r\n\x1b[31mError: ${message.data}\x1b[0m\r\n`
                            )
                            break
                        case "exit":
                            term?.writeln(
                                `\r\n\x1b[33mSession ended (code: ${message.code})\x1b[0m\r\n`
                            )
                            break
                        case "toast":
                            if (message.data && message.data.message) {
                                toast(message.data.message)
                            }
                            break
                    }
                } catch (error) {
                    console.error("Failed to parse WebSocket message:", error)
                }
            }

            ws.onerror = (error) => {
                if (isCleanedUp) return
                // Don't log errors during cleanup (React Strict Mode)
                console.error("WebSocket error:", error)
                term?.writeln(
                    "\r\n\x1b[31mConnection error. Please refresh the page.\x1b[0m\r\n"
                )
            }

            ws.onclose = () => {
                if (!isCleanedUp) {
                    term?.writeln("\r\n\x1b[33mConnection closed.\x1b[0m\r\n")
                }
            }

            const handleResize = () => {
                if (!isCleanedUp) {
                    fitAddon.fit()
                }
            }
            window.addEventListener("resize", handleResize)

            // Handle copy/paste with Ctrl+C / Ctrl+V (or Cmd on Mac)
            term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
                if (isCleanedUp) return true

                // Ctrl+C / Cmd+C - Copy if text is selected, otherwise send interrupt
                if (
                    (e.metaKey || e.ctrlKey) &&
                    e.key === "c" &&
                    e.type === "keydown"
                ) {
                    const selection = term?.getSelection()
                    if (selection) {
                        e.preventDefault()
                        navigator.clipboard
                            .writeText(selection)
                            .catch((err) => {
                                console.error(
                                    "Failed to write to clipboard:",
                                    err
                                )
                            })
                        return false // Prevent xterm from handling (copied to clipboard)
                    }
                    // No selection - let xterm handle normally (send Ctrl+C to terminal)
                    return true
                }

                // Ctrl+V / Cmd+V - Paste from clipboard
                if (
                    (e.metaKey || e.ctrlKey) &&
                    e.key === "v" &&
                    e.type === "keydown"
                ) {
                    e.preventDefault()
                    navigator.clipboard
                        .readText()
                        .then((text) => {
                            if (
                                !isCleanedUp &&
                                ws?.readyState === WebSocket.OPEN
                            ) {
                                ws.send(
                                    JSON.stringify({
                                        type: "input",
                                        data: text
                                    })
                                )
                            }
                        })
                        .catch((err) => {
                            console.error("Failed to read clipboard:", err)
                        })
                    return false // Prevent xterm from handling this
                }

                return true // Let xterm handle other keys
            })

            return () => {
                window.removeEventListener("resize", handleResize)
                onDataDisposable.dispose()
                onResizeDisposable.dispose()
            }
        }

        const cleanup = initTerminal()

        return () => {
            isCleanedUp = true
            cleanup?.()
            if (ws) {
                ws.close()
                ws = null
                wsRef.current = null
            }
            if (term) {
                term.dispose()
                term = null
                xtermRef.current = null
            }
        }
    }, [projectId])

    // Trigger resize when resizeTrigger changes
    useEffect(() => {
        if (fitAddonRef.current && xtermRef.current) {
            // Use setTimeout to ensure DOM has updated
            const timer = setTimeout(() => {
                fitAddonRef.current?.fit()
            }, 100)
            return () => clearTimeout(timer)
        }
    }, [resizeTrigger])

    return (
        <div className="w-full h-full pl-4 pt-1">
            <div ref={terminalRef} className="w-full h-full" />
        </div>
    )
}
