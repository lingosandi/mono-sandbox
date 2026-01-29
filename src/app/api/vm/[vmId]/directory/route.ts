import { NextRequest, NextResponse } from "next/server"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)
const isWindows = process.platform === "win32"

function wslCommand(cmd: string): string {
    return isWindows ? `wsl ${cmd}` : cmd
}

interface DirEntry {
    path: string
    type: "file" | "directory"
    size?: number
}

// GET /api/vm/[vmId]/directory - Get directory structure from running VM
export async function GET(
    request: NextRequest,
    props: { params: Promise<{ vmId: string }> }
) {
    const params = await props.params
    const { vmId } = params

    console.log("[VM Directory] Request for VM:", vmId)

    try {
        // Connect to VM via vsock and execute find command
        const guestCid = parseInt(vmId) || 3
        const vsockPort = 1024

        console.log(
            "[VM Directory] Connecting to CID:",
            guestCid,
            "Port:",
            vsockPort
        )

        // Execute find command via socat to vsock terminal
        const command = wslCommand(`bash -c '
            (
                echo "CONNECT"
                sleep 0.3
                echo "find /mnt/project -printf \\"%p\\\\t%y\\\\t%s\\\\n\\" 2>/dev/null"
                sleep 1
                echo "exit"
            ) | timeout 5 socat - VSOCK-CONNECT:${guestCid}:${vsockPort} 2>/dev/null
        '`)

        console.log("[VM Directory] Executing command")
        const { stdout, stderr } = await execAsync(command)
        console.log("[VM Directory] stdout:", stdout.substring(0, 200))
        if (stderr) console.error("[VM Directory] stderr:", stderr)

        // Parse output
        const lines = stdout.split("\n").filter((line) => line.includes("\t"))
        const entries: DirEntry[] = []

        for (const line of lines) {
            const [path, type, size] = line.split("\t")

            if (!path || path === "/mnt/project") continue

            // Remove /mnt/project prefix to get relative path
            const relativePath = path.replace("/mnt/project/", "")
            if (!relativePath) continue

            entries.push({
                path: relativePath,
                type: type === "d" ? "directory" : "file",
                size: type === "f" ? parseInt(size) : undefined
            })
        }

        return NextResponse.json({
            entries,
            count: entries.length
        })
    } catch (error) {
        console.error("Error fetching VM directory:", error)
        return NextResponse.json(
            { error: "Failed to fetch directory from VM" },
            { status: 500 }
        )
    }
}
