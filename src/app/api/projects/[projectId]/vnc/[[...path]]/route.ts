import { NextRequest, NextResponse } from "next/server"
import { projectDb } from "@/lib/db"

const VM_ORCHESTRATOR_URL = "http://localhost:3003"

async function proxyToVnc(
    request: NextRequest,
    projectId: string,
    path: string
) {
    const project = projectDb.findUnique({ id: projectId })

    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    // Get VM status first to ensure VM is running (with timeout)
    try {
        const statusResponse = await fetch(
            `${VM_ORCHESTRATOR_URL}/api/vm/status`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId }),
                signal: AbortSignal.timeout(5000) // 5s timeout
            }
        )

        if (!statusResponse.ok) {
            return NextResponse.json({ error: "Failed to check VM status" }, { status: 502 })
        }

        const vmStatus = await statusResponse.json()
        if (!vmStatus.running) {
            return NextResponse.json({ error: "VM not running" }, { status: 400 })
        }
    } catch (error) {
        console.error("[VNC Proxy] VM status check failed:", error)
        return NextResponse.json(
            { error: "VM orchestrator unavailable" },
            { status: 503 }
        )
    }

    // Use vm-orchestrator's proxy endpoint for VNC (port 6080)
    const url = new URL(request.url)
    const upstreamUrl = `${VM_ORCHESTRATOR_URL}/api/proxy/${projectId}/6080/${path}${url.search}`

    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.delete("connection")
    headers.delete("content-length")
    headers.delete("accept-encoding")

    headers.set("x-forwarded-host", url.host)
    headers.set("x-forwarded-proto", url.protocol.replace(":", ""))

    const forwardedFor = request.headers.get("x-forwarded-for")
    if (forwardedFor) {
        headers.set("x-forwarded-for", forwardedFor)
    }

    const hasBody = !["GET", "HEAD"].includes(request.method)
    const body = hasBody ? await request.arrayBuffer() : undefined

    const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: body ? Buffer.from(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(30000)
    })

    const responseHeaders = new Headers(upstreamResponse.headers)
    responseHeaders.delete("transfer-encoding")

    return new NextResponse(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
    })
}

export async function GET(
    request: NextRequest,
    context: { params: Promise<{ projectId: string; path: string[] }> }
) {
    const { projectId, path } = await context.params
    const pathStr = path?.join("/") || ""
    return proxyToVnc(request, projectId, pathStr)
}

export async function POST(
    request: NextRequest,
    context: { params: Promise<{ projectId: string; path: string[] }> }
) {
    const { projectId, path } = await context.params
    const pathStr = path?.join("/") || ""
    return proxyToVnc(request, projectId, pathStr)
}

export async function PUT(
    request: NextRequest,
    context: { params: Promise<{ projectId: string; path: string[] }> }
) {
    const { projectId, path } = await context.params
    const pathStr = path?.join("/") || ""
    return proxyToVnc(request, projectId, pathStr)
}

export async function DELETE(
    request: NextRequest,
    context: { params: Promise<{ projectId: string; path: string[] }> }
) {
    const { projectId, path } = await context.params
    const pathStr = path?.join("/") || ""
    return proxyToVnc(request, projectId, pathStr)
}

export async function PATCH(
    request: NextRequest,
    context: { params: Promise<{ projectId: string; path: string[] }> }
) {
    const { projectId, path } = await context.params
    const pathStr = path?.join("/") || ""
    return proxyToVnc(request, projectId, pathStr)
}
