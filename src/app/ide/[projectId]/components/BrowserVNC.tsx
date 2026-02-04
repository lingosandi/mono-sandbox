"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Switch } from "@/components/ui/switch"
import { 
    Loader2, 
    ChevronLeft, 
    ChevronRight, 
    Home, 
    ExternalLink,
    RefreshCw,
    Globe,
    ShieldCheck
} from "lucide-react"

interface BrowserVNCProps {
    projectId: string
}

export function BrowserVNC({ projectId }: BrowserVNCProps) {
    const [enabled, setEnabled] = useState(false)
    const [loading, setLoading] = useState(false)
    const [vncUrl, setVncUrl] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [refreshKey, setRefreshKey] = useState(0)
    const iframeRef = useRef<HTMLIFrameElement>(null)

    const launchBrowser = useCallback(async () => {
        console.log(`[BrowserVNC] Launching browser for project ${projectId}...`)
        setLoading(true)
        setError(null)

        try {
            // Launch Chrome in the VM and get VNC port
            console.log(`[BrowserVNC] Fetching /api/projects/${projectId}/browser`)
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 30000) // 30s timeout
            
            try {
                const response = await fetch(`/api/projects/${projectId}/browser`, {
                    method: "POST",
                    signal: controller.signal
                })
                clearTimeout(timeoutId)

                console.log(`[BrowserVNC] Response status: ${response.status}`)

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: "Unknown error" }))
                    console.error(`[BrowserVNC] Error response:`, errorData)
                    throw new Error(errorData.error || `Server error: ${response.status}`)
                }

                const data = await response.json()
                console.log(`[BrowserVNC] Success! Data:`, data)
                
                // Load vnc_auto.html from vm-orchestrator with explicit connection parameters
                // noVNC will connect to ws://host:port/path
                const vncUrl = `http://localhost:3003/api/proxy/${projectId}/6080/vnc_auto.html?host=localhost&port=3003&path=api/proxy/${projectId}/6080/websockify&password=password&logging=debug&resize=scale`
                console.log(`[BrowserVNC] VNC URL: ${vncUrl}`)
                setVncUrl(vncUrl)
            } catch (fetchError) {
                clearTimeout(timeoutId)
                throw fetchError
            }
        } catch (err) {
            const errorMessage = err instanceof Error 
                ? (err.name === "AbortError" ? "Request timeout - VM may be slow to start" : err.message)
                : "Unknown error"
            console.error(`[BrowserVNC] Launch failed:`, err)
            setError(errorMessage)
            setEnabled(false)
        } finally {
            setLoading(false)
        }
    }, [projectId])

    useEffect(() => {
        if (enabled) {
            launchBrowser()
        } else {
            setVncUrl(null)
        }
    }, [enabled, launchBrowser])

    const handleRefresh = () => {
        setRefreshKey(prev => prev + 1)
    }

    return (
        <div className="flex flex-col h-full bg-black/20 backdrop-blur-sm overflow-hidden">
            {/* Premium Browser Header */}
            <div className="h-12 border-b border-white/10 flex items-center px-4 glass-card z-10">
                <div className="flex items-center gap-4 w-full">
                    <div className="flex items-center gap-2">
                        <button className="p-1.5 hover:bg-white/5 rounded-md text-zinc-400 transition-colors" title="Back">
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <button className="p-1.5 hover:bg-white/5 rounded-md text-zinc-400 transition-colors" title="Forward">
                            <ChevronRight className="h-4 w-4" />
                        </button>
                        <button 
                            onClick={handleRefresh}
                            className={`p-1.5 hover:bg-white/5 rounded-md text-zinc-400 transition-colors ${loading ? 'animate-spin' : ''}`} 
                            title="Refresh"
                        >
                            <RefreshCw className="h-4 w-4" />
                        </button>
                        <button className="p-1.5 hover:bg-white/5 rounded-md text-zinc-400 transition-colors" title="Home">
                            <Home className="h-4 w-4" />
                        </button>
                    </div>

                    {/* Address Bar */}
                    <div className="flex-1 max-w-2xl h-8 bg-black/40 border border-white/10 rounded-full flex items-center px-3 gap-2 group focus-within:border-blue-500/50 transition-all">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500/70" />
                        <div className="flex-1 text-[13px] text-zinc-300 font-medium truncate select-none opacity-80 group-hover:opacity-100 italic">
                            {enabled ? "localhost:3000" : "browser inactive"}
                        </div>
                        <Globe className="h-3.5 w-3.5 text-zinc-500" />
                    </div>

                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 mr-2">
                            <div className={`h-2 w-2 rounded-full ${enabled ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'}`} />
                            <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">
                                {enabled ? "Live" : "Offline"}
                            </span>
                        </div>
                        <Switch
                            id="browser-toggle"
                            checked={enabled}
                            onCheckedChange={setEnabled}
                            disabled={loading}
                            className="data-[state=checked]:bg-blue-600"
                        />
                    </div>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 bg-[#050505] relative overflow-hidden">
                {loading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#050505] z-50">
                        <div className="flex flex-col items-center gap-4">
                            <div className="relative">
                                <Loader2 className="h-10 w-10 animate-spin text-blue-500/50" />
                                <div className="absolute inset-0 blur-xl bg-blue-500/20 animate-pulse" />
                            </div>
                            <div className="flex flex-col items-center">
                                <p className="text-sm font-medium text-zinc-300">Initialising Chromium</p>
                                <p className="text-[10px] text-zinc-500 uppercase tracking-widest mt-1">Connecting to VM session...</p>
                            </div>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#050505] z-50">
                        <div className="glass-card p-6 rounded-xl border-red-500/20 flex flex-col items-center gap-3 max-w-sm text-center">
                            <div className="h-12 w-12 rounded-full bg-red-500/10 flex items-center justify-center mb-2">
                                <ExternalLink className="h-6 w-6 text-red-400" />
                            </div>
                            <h3 className="text-sm font-semibold text-zinc-200">Connection Failed</h3>
                            <p className="text-xs text-zinc-400">{error}</p>
                            <button
                                onClick={() => { launchBrowser() }}
                                className="mt-2 px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-md text-xs font-medium transition-colors border border-white/5"
                            >
                                Reconnect
                            </button>
                        </div>
                    </div>
                )}

                {!loading && !error && !enabled && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#0a0a0a]">
                        <div className="h-16 w-16 rounded-2xl bg-white/[0.02] border border-white/5 flex items-center justify-center text-zinc-600">
                            <Globe className="h-8 w-8 opacity-20" />
                        </div>
                        <div className="text-center">
                            <p className="text-sm text-zinc-400 font-medium">Internal VM Browser</p>
                            <p className="text-xs text-zinc-600 mt-1 max-w-[200px]">Launch a browser session to preview your application inside the secure VM environment.</p>
                        </div>
                        <button 
                            onClick={() => setEnabled(true)}
                            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-full transition-all shadow-lg shadow-blue-600/20 active:scale-95"
                        >
                            Go Live
                        </button>
                    </div>
                )}

                {vncUrl && !loading && (
                    <iframe
                        key={refreshKey}
                        ref={iframeRef}
                        src={vncUrl}
                        className="w-full h-full border-0 select-none"
                        title="Browser VNC"
                        allow="clipboard-read; clipboard-write"
                    />
                )}
            </div>
            
            {/* Footer / Status Bar */}
            <div className="h-6 px-3 flex items-center justify-between border-t border-white/5 bg-black/40 text-[10px] text-zinc-500">
                <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5">
                        <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        VNC: {vncUrl ? 'Connected' : 'Disconnected'}
                    </span>
                    <span className="opacity-50">|</span>
                    <span>Ready</span>
                </div>
                <div>Chromium Instance v1.0.4</div>
            </div>
        </div>
    )
}
