import { NextRequest, NextResponse } from "next/server"
import { projectDb } from "@/lib/db"
import { VM_ORCHESTRATOR_PORT } from "@vm/config"

const VM_APP_PORT = 5173

async function proxyToVm(
    request: NextRequest,
    projectId: string,
    path: string
) {
    const project = projectDb.findUnique({ id: projectId })

    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    // Use vm-orchestrator's proxy endpoint (no userId required)
    const url = new URL(request.url)
    const upstreamUrl = `http://localhost:${VM_ORCHESTRATOR_PORT}/api/proxy/${projectId}/${VM_APP_PORT}/${path}${url.search}`

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
        headers: responseHeaders
    })
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string; path?: string[] }> }
) {
    const { projectId, path } = await params
    const proxyPath = path?.join("/") || ""
    return proxyToVm(request, projectId, proxyPath)
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string; path?: string[] }> }
) {
    const { projectId, path } = await params
    const proxyPath = path?.join("/") || ""
    return proxyToVm(request, projectId, proxyPath)
}

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string; path?: string[] }> }
) {
    const { projectId, path } = await params
    const proxyPath = path?.join("/") || ""
    return proxyToVm(request, projectId, proxyPath)
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string; path?: string[] }> }
) {
    const { projectId, path } = await params
    const proxyPath = path?.join("/") || ""
    return proxyToVm(request, projectId, proxyPath)
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string; path?: string[] }> }
) {
    const { projectId, path } = await params
    const proxyPath = path?.join("/") || ""
    return proxyToVm(request, projectId, proxyPath)
}

export async function HEAD(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string; path?: string[] }> }
) {
    const { projectId, path } = await params
    const proxyPath = path?.join("/") || ""
    return proxyToVm(request, projectId, proxyPath)
}

export async function OPTIONS(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string; path?: string[] }> }
) {
    const { projectId, path } = await params
    const proxyPath = path?.join("/") || ""
    return proxyToVm(request, projectId, proxyPath)
}
