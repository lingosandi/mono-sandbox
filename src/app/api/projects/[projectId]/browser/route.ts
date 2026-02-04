import { NextRequest, NextResponse } from "next/server"
import { projectDb } from "@/lib/db"

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    const { projectId } = await params

    console.log(`[Browser API] Launch request for project: ${projectId}`)

    try {
        // Verify project exists
        const project = projectDb.findUnique({ id: projectId })

        if (!project) {
            console.error(`[Browser API] Project not found: ${projectId}`)
            return NextResponse.json(
                { error: "Project not found" },
                { status: 404 }
            )
        }

        console.log(`[Browser API] Project found: ${project.name}`)

        // Get VM orchestrator URL
        const orchestratorUrl = process.env.VM_ORCHESTRATOR_URL || "http://localhost:3003"
        console.log(`[Browser API] Orchestrator URL: ${orchestratorUrl}`)
        
        // Get VM status with timeout
        console.log(`[Browser API] Getting VM status...`)
        const statusResponse = await fetch(
            `${orchestratorUrl}/api/vm/status`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId }),
                signal: AbortSignal.timeout(10000) // 10s timeout
            }
        )

        if (!statusResponse.ok) {
            const errorText = await statusResponse.text().catch(() => "Unknown error")
            console.error(`[Browser API] VM status check failed: ${statusResponse.status} - ${errorText}`)
            throw new Error(`Failed to get VM status: ${statusResponse.status}`)
        }

        const vmStatus = await statusResponse.json()
        console.log(`[Browser API] VM status:`, vmStatus)

        if (!vmStatus.running || !vmStatus.vmId) {
            console.error(`[Browser API] VM not running for project ${projectId}`)
            return NextResponse.json(
                { error: "VM not running. Please start the project first." },
                { status: 400 }
            )
        }

        const vmId = vmStatus.vmId
        console.log(`[Browser API] VM ID: ${vmId}`)

        // Get port mappings with timeout (triggers port forwarding)
        console.log(`[Browser API] Getting port mappings...`)
        const portResponse = await fetch(
            `${orchestratorUrl}/api/vm/${vmId}/ports`,
            {
                signal: AbortSignal.timeout(10000) // 10s timeout
            }
        )

        if (!portResponse.ok) {
            const errorText = await portResponse.text().catch(() => "Unknown error")
            console.error(`[Browser API] Port mapping failed: ${portResponse.status} - ${errorText}`)
            throw new Error(`Failed to get VNC port: ${portResponse.status}`)
        }

        const ports = await portResponse.json()
        console.log(`[Browser API] Port mappings:`, ports)
        const vncPort = ports.vnc
        
        if (!vncPort) {
            console.error(`[Browser API] VNC port not in response:`, ports)
            throw new Error("VNC port not available")
        }

        console.log(`[Browser API] VNC port: ${vncPort}`)

        // Launch Chrome with retry logic (may fail on first VM boot)
        console.log(`[Browser API] Launching Chrome in VM...`)
        let launchSuccess = false
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`[Browser API] Chrome launch attempt ${attempt}/3`)
                const launchResponse = await fetch(
                    `${orchestratorUrl}/api/vm/${vmId}/exec`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            command: "/usr/local/bin/launch-chrome"
                        }),
                        signal: AbortSignal.timeout(15000) // 15s timeout per attempt
                    }
                )

                if (launchResponse.ok) {
                    const result = await launchResponse.json()
                    console.log(`[Browser API] Chrome launch result:`, result)
                    launchSuccess = true
                    break
                } else {
                    const error = await launchResponse.text().catch(() => "Unknown error")
                    console.warn(`[Browser API] Chrome launch attempt ${attempt} failed: ${launchResponse.status} - ${error}`)
                    if (attempt < 3) {
                        // Wait before retry (VNC/X11 services may still be starting)
                        await new Promise(resolve => setTimeout(resolve, 2000))
                    }
                }
            } catch (error) {
                console.warn(`[Browser API] Chrome launch attempt ${attempt} error:`, error)
                if (attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 2000))
                }
            }
        }

        if (!launchSuccess) {
            console.warn(`[Browser API] Chrome launch failed after 3 attempts, but continuing (may already be running)`)
        }

        console.log(`[Browser API] Success! VNC available at port ${vncPort}`)
        return NextResponse.json({
            vncPort,
            vmId,
            message: "Browser ready"
        })
    } catch (error) {
        console.error(`[Browser API] Error launching browser:`, error)
        const errorMessage = error instanceof Error ? error.message : "Failed to launch browser"
        console.error(`[Browser API] Returning error: ${errorMessage}`)
        return NextResponse.json(
            {
                error: errorMessage
            },
            { status: 500 }
        )
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    const { projectId } = await params

    try {
        // Verify project exists
        const project = projectDb.findUnique({ id: projectId })

        if (!project) {
            return NextResponse.json(
                { error: "Project not found" },
                { status: 404 }
            )
        }

        // Get VM orchestrator URL
        const orchestratorUrl = process.env.VM_ORCHESTRATOR_URL || "http://localhost:3003"
        
        // Get VM status with timeout
        const statusResponse = await fetch(
            `${orchestratorUrl}/api/vm/status`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId }),
                signal: AbortSignal.timeout(5000) // 5s timeout
            }
        )

        if (!statusResponse.ok) {
            throw new Error("Failed to get VM status")
        }

        const vmStatus = await statusResponse.json()

        if (!vmStatus.running || !vmStatus.vmId) {
            return NextResponse.json(
                { error: "VM not running" },
                { status: 400 }
            )
        }

        const vmId = vmStatus.vmId
        
        // Kill Chrome process with timeout
        const killResponse = await fetch(
            `${orchestratorUrl}/api/vm/${vmId}/exec`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    command: "pkill -f chrome"
                }),
                signal: AbortSignal.timeout(5000) // 5s timeout
            }
        )

        if (!killResponse.ok) {
            const error = await killResponse.text().catch(() => "Unknown error")
            console.error("Failed to kill Chrome:", error)
            // Don't fail if Chrome isn't running
        }

        return NextResponse.json({
            message: "Browser stopped"
        })
    } catch (error) {
        console.error("Error stopping browser:", error)
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Failed to stop browser"
            },
            { status: 500 }
        )
    }
}
