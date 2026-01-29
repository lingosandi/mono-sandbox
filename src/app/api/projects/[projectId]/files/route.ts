import { NextRequest, NextResponse } from "next/server"
import { projectDb } from "@/lib/db"
import fs from "fs/promises"
import path from "path"

// Import Firecracker config directly from vm-orchestrator
// This ensures we use the same config as the VM orchestrator process
import {
    PROJECTS_BASE_DIR
} from "@vm/config"

const FILE_OPS_SERVER_PORT = parseInt(
    process.env.FILE_OPS_SERVER_PORT || "3003"
)

// Helper to read file from VM via file-operations server
async function readFileFromVM(
    projectId: string,
    filePath: string
): Promise<string | null> {
    try {
        // Call file-operations server which manages VM connections
        const response = await fetch(
            `http://localhost:${FILE_OPS_SERVER_PORT}/api/file-content`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    projectId,
                    path: filePath
                }),
                signal: AbortSignal.timeout(5000)
            }
        )

        if (!response.ok) {
            return null
        }

        const data = (await response.json()) as { content?: string }
        return data.content || null
    } catch {
        return null
    }
}

function getProjectDir(projectId: string) {
    return path.join(PROJECTS_BASE_DIR, projectId)
}

async function verifyProjectExists(projectId: string) {
    const project = projectDb.findUnique({ id: projectId })

    if (!project) {
        return { error: "Project not found", status: 404 }
    }

    return { project }
}

interface FileTreeNode {
    name: string
    path: string
    type: "file" | "directory"
    children?: FileTreeNode[]
}

async function getDirectoryTree(
    dirPath: string,
    basePath: string
): Promise<FileTreeNode[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const tree = []

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path
            .relative(basePath, fullPath)
            .replace(/\\/g, "/")

        if (entry.isDirectory()) {
            const children = await getDirectoryTree(fullPath, basePath)
            tree.push({
                name: entry.name,
                path: relativePath,
                type: "directory" as const,
                children
            })
        } else {
            tree.push({
                name: entry.name,
                path: relativePath,
                type: "file" as const
            })
        }
    }

    return tree.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name)
        return a.type === "directory" ? -1 : 1
    })
}

// GET /api/projects/[projectId]/files - List all files in project
export async function GET(
    request: NextRequest,
    props: { params: Promise<{ projectId: string }> }
) {
    const params = await props.params


    const { projectId } = params
    const verification = await verifyProjectExists(projectId)
    if ("error" in verification) {
        return NextResponse.json(
            { error: verification.error },
            { status: verification.status }
        )
    }

    const { searchParams } = new URL(request.url)
    const filePath = searchParams.get("path")

    const projectDir = getProjectDir(projectId)

    // If specific file requested, return its content
    if (filePath) {
        // Read from VM disk via file-operations server
        const content = await readFileFromVM(
            projectId,
            filePath
        )

        if (content === null) {
            return NextResponse.json(
                { error: "File not found" },
                { status: 404 }
            )
        }

        return NextResponse.json({ content, path: filePath })
    }

    // Otherwise, return directory tree
    try {
        const tree = await getDirectoryTree(projectDir, projectDir)
        return NextResponse.json({ files: tree })
    } catch {
        return NextResponse.json(
            { error: "Failed to read project files" },
            { status: 500 }
        )
    }
}

// POST /api/projects/[projectId]/files - Create new file or directory
export async function POST(
    request: NextRequest,
    props: { params: Promise<{ projectId: string }> }
) {
    const params = await props.params


    const { projectId } = params
    const verification = await verifyProjectExists(projectId)
    if ("error" in verification) {
        return NextResponse.json(
            { error: verification.error },
            { status: verification.status }
        )
    }

    const body = await request.json()
    const { path: filePath, type, content = "" } = body

    if (!filePath || !type) {
        return NextResponse.json(
            { error: "Path and type are required" },
            { status: 400 }
        )
    }

    const projectDir = getProjectDir(projectId)
    const fullPath = path.join(projectDir, filePath)

    // Security check
    if (!fullPath.startsWith(projectDir)) {
        return NextResponse.json(
            { error: "Invalid file path" },
            { status: 400 }
        )
    }

    try {
        // Ensure parent directory exists
        const parentDir = path.dirname(fullPath)
        await fs.mkdir(parentDir, { recursive: true })

        if (type === "directory") {
            await fs.mkdir(fullPath, { recursive: true })
        } else {
            await fs.writeFile(fullPath, content, "utf-8")
        }

        return NextResponse.json(
            { success: true, path: filePath },
            { status: 201 }
        )
    } catch {
        return NextResponse.json(
            { error: "Failed to create file" },
            { status: 500 }
        )
    }
}

// PUT /api/projects/[projectId]/files - Update file content
export async function PUT(
    request: NextRequest,
    props: { params: Promise<{ projectId: string }> }
) {
    const params = await props.params


    const { projectId } = params
    const verification = await verifyProjectExists(projectId)
    if ("error" in verification) {
        return NextResponse.json(
            { error: verification.error },
            { status: verification.status }
        )
    }

    const body = await request.json()
    const { path: filePath, content } = body

    if (!filePath || content === undefined) {
        return NextResponse.json(
            { error: "Path and content are required" },
            { status: 400 }
        )
    }

    const projectDir = getProjectDir(projectId)
    const fullPath = path.join(projectDir, filePath)

    // Security check
    if (!fullPath.startsWith(projectDir)) {
        return NextResponse.json(
            { error: "Invalid file path" },
            { status: 400 }
        )
    }

    try {
        await fs.writeFile(fullPath, content, "utf-8")
        return NextResponse.json({ success: true })
    } catch {
        return NextResponse.json(
            { error: "Failed to update file" },
            { status: 500 }
        )
    }
}

// DELETE /api/projects/[projectId]/files - Delete file or directory
export async function DELETE(
    request: NextRequest,
    props: { params: Promise<{ projectId: string }> }
) {
    const params = await props.params


    const { projectId } = params
    const verification = await verifyProjectExists(projectId)
    if ("error" in verification) {
        return NextResponse.json(
            { error: verification.error },
            { status: verification.status }
        )
    }

    const { searchParams } = new URL(request.url)
    const filePath = searchParams.get("path")

    if (!filePath) {
        return NextResponse.json({ error: "Path is required" }, { status: 400 })
    }

    const projectDir = getProjectDir(projectId)
    const fullPath = path.join(projectDir, filePath)

    // Security check
    if (!fullPath.startsWith(projectDir)) {
        return NextResponse.json(
            { error: "Invalid file path" },
            { status: 400 }
        )
    }

    try {
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) {
            await fs.rm(fullPath, { recursive: true, force: true })
        } else {
            await fs.unlink(fullPath)
        }
        return NextResponse.json({ success: true })
    } catch {
        return NextResponse.json(
            { error: "Failed to delete file" },
            { status: 500 }
        )
    }
}

// PATCH /api/projects/[projectId]/files - Rename/move file or directory
export async function PATCH(
    request: NextRequest,
    props: { params: Promise<{ projectId: string }> }
) {
    const params = await props.params


    const { projectId } = params
    const verification = await verifyProjectExists(projectId)
    if ("error" in verification) {
        return NextResponse.json(
            { error: verification.error },
            { status: verification.status }
        )
    }

    const body = await request.json()
    const { oldPath, newPath } = body

    if (!oldPath || !newPath) {
        return NextResponse.json(
            { error: "Old path and new path are required" },
            { status: 400 }
        )
    }

    const projectDir = getProjectDir(projectId)
    const fullOldPath = path.join(projectDir, oldPath)
    const fullNewPath = path.join(projectDir, newPath)

    // Security check
    if (
        !fullOldPath.startsWith(projectDir) ||
        !fullNewPath.startsWith(projectDir)
    ) {
        return NextResponse.json(
            { error: "Invalid file path" },
            { status: 400 }
        )
    }

    try {
        // Ensure parent directory exists for new path
        const parentDir = path.dirname(fullNewPath)
        await fs.mkdir(parentDir, { recursive: true })

        await fs.rename(fullOldPath, fullNewPath)
        return NextResponse.json({ success: true, newPath })
    } catch {
        return NextResponse.json(
            { error: "Failed to rename file" },
            { status: 500 }
        )
    }
}
