import { NextRequest, NextResponse } from "next/server"

const VM_ORCHESTRATOR_URL =
    process.env.VM_ORCHESTRATOR_URL || "http://localhost:3003"

async function handleRequest(
    request: NextRequest,
    context: { params: Promise<{ projectId: string }> },
    isHead: boolean = false
) {
    try {
        const { projectId } = await context.params

        // Validate projectId
        if (!projectId || typeof projectId !== "string") {
            return NextResponse.json(
                { error: "Invalid project ID" },
                { status: 400 }
            )
        }

        if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
            return NextResponse.json(
                { error: "Invalid project ID format" },
                { status: 400 }
            )
        }

        // Proxy request to vm-orchestrator
        const response = await fetch(
            `${VM_ORCHESTRATOR_URL}/api/overlay/download/${projectId}`,
            { 
                method: isHead ? "HEAD" : "GET",
                signal: AbortSignal.timeout(300000) // 5 minute timeout
            }
        )

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: "Failed to download overlay" }))
            return NextResponse.json(
                { error: error.error || "Overlay disk not found" },
                { status: response.status }
            )
        }

        // For HEAD requests, just return status
        if (isHead) {
            return new NextResponse(null, { status: 200 })
        }

        // Stream the file from vm-orchestrator to client
        const headers = new Headers()
        headers.set("Content-Type", "application/gzip")
        headers.set(
            "Content-Disposition",
            `attachment; filename="${projectId}-overlay.ext4.tar.gz"`
        )
        
        const contentLength = response.headers.get("Content-Length")
        if (contentLength) {
            headers.set("Content-Length", contentLength)
        }

        // Ensure response body exists (shouldn't be null for successful response, but type safety)
        if (!response.body) {
            return NextResponse.json(
                { error: "Empty response from vm-orchestrator" },
                { status: 500 }
            )
        }

        return new NextResponse(response.body, { headers })
    } catch (error) {
        console.error("Error downloading overlay:", error)
        
        // Provide specific error message for timeout
        if (error && typeof error === 'object' && 'name' in error && error.name === 'TimeoutError') {
            return NextResponse.json(
                { error: "Download timed out. Please try again." },
                { status: 408 }
            )
        }
        
        return NextResponse.json(
            { error: "Failed to download overlay disk" },
            { status: 500 }
        )
    }
}

export async function GET(
    request: NextRequest,
    context: { params: Promise<{ projectId: string }> }
) {
    return handleRequest(request, context, false)
}

export async function HEAD(
    request: NextRequest,
    context: { params: Promise<{ projectId: string }> }
) {
    return handleRequest(request, context, true)
}
