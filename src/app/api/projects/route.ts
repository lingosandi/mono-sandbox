import { NextRequest, NextResponse } from "next/server"
import { projectDb } from "@/lib/db"
import fs from "fs/promises"
import path from "path"
import { PROJECTS_BASE_DIR } from "@vm/config"

// GET /api/projects - List all projects
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const includeDeleted = searchParams.get("includeDeleted") === "true"

    const projects = projectDb.findMany(
        includeDeleted ? {} : { deletedAt: null },
        { orderBy: { updatedAt: "desc" } }
    )

    return NextResponse.json({ projects })
}

// POST /api/projects - Create new sandbox
export async function POST(request: NextRequest) {
    const body = await request.json()
    const { name, description } = body

    if (!name || typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json(
            { error: "Project name is required" },
            { status: 400 }
        )
    }

    // Create database record
    const project = projectDb.create({
        name: name.trim(),
        description: description?.trim() || null
    })

    // Note: Project files are stored in VM disk (.ext4), not host filesystem
    // No need to create host directory when using Firecracker

    return NextResponse.json({ project }, { status: 201 })
}

// DELETE /api/projects - Delete sandbox
export async function DELETE(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get("id")

    if (!projectId) {
        return NextResponse.json(
            { error: "Project ID is required" },
            { status: 400 }
        )
    }

    const project = projectDb.findUnique({ id: projectId })

    if (!project) {
        return NextResponse.json(
            { error: "Project not found" },
            { status: 404 }
        )
    }

    // Check if already soft-deleted - if so, hard delete everything
    if (project.deletedAt) {
        // Hard delete: remove from database, filesystem, and VM disk

        // 1. Delete host project directory
        const projectDir = path.join(
            PROJECTS_BASE_DIR,
            projectId
        )
        try {
            await fs.rm(projectDir, { recursive: true, force: true })
        } catch (error) {
            console.warn("Failed to delete sandbox directory:", error)
        }

        // 2. Delete sandbox overlay disk via vm-orchestrator API
        try {
            const response = await fetch(
                "http://localhost:3003/api/project-overlay",
                {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ projectId }),
                    signal: AbortSignal.timeout(5000)
                }
            )

            if (!response.ok) {
                console.warn(
                    "Failed to delete disk via vm-orchestrator:",
                    response.statusText
                )
            } else {
                const result = await response.json()
                console.log(
                    `[Cleanup] Deleted disks via vm-orchestrator:`,
                    result.deletedFiles
                )
                if (result.errors) {
                    console.warn(
                        "[Cleanup] Disk deletion errors:",
                        result.errors
                    )
                }
            }
        } catch (error) {
            console.warn(
                "Failed to call vm-orchestrator for disk cleanup:",
                error
            )
        }

        // 3. Hard delete from database
        projectDb.delete({ id: projectId })

        return NextResponse.json({ success: true, hardDeleted: true })
    }

    // Soft delete - mark as deleted AND stop any running VMs
    try {
        const response = await fetch("http://localhost:3003/api/vm/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId }),
            signal: AbortSignal.timeout(5000)
        })

        if (response.ok) {
            console.log(`[SoftDelete] Stopped VM for project ${projectId}`)
        } else if (response.status !== 404) {
            // 404 means VM wasn't running, which is fine
            console.warn(
                `[SoftDelete] Failed to stop VM:`,
                response.statusText
            )
        }
    } catch (error) {
        console.warn(`[SoftDelete] Failed to call vm-orchestrator:`, error)
    }

    projectDb.update({ id: projectId }, { deletedAt: new Date() })

    return NextResponse.json({ success: true, softDeleted: true })
}

// PATCH /api/projects - Update project
export async function PATCH(request: NextRequest) {
    const body = await request.json()
    const { id, name, description } = body

    if (!id) {
        return NextResponse.json(
            { error: "Project ID is required" },
            { status: 400 }
        )
    }

    if (!name || typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json(
            { error: "Project name is required" },
            { status: 400 }
        )
    }

    const project = projectDb.findUnique({ id })

    if (!project) {
        return NextResponse.json(
            { error: "Project not found" },
            { status: 404 }
        )
    }

    // Update in database
    const updatedProject = projectDb.update({ id }, {
        name: name.trim(),
        description: description?.trim() || null
    })

    return NextResponse.json({ project: updatedProject })
}
