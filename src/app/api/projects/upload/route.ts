import { NextRequest, NextResponse } from "next/server"
import { projectDb } from "@/lib/db"

export async function POST(request: NextRequest) {
    let projectId: string | null = null
    
    try {
        // Get the uploaded file
        const formData = await request.formData()
        const file = formData.get("file") as File
        
        if (!file) {
            return NextResponse.json(
                { error: "No file provided" },
                { status: 400 }
            )
        }
        
        // Validate file extension
        if (!file.name.endsWith(".tar.gz") && !file.name.endsWith(".tgz")) {
            return NextResponse.json(
                { error: "Invalid file type. Expected .tar.gz or .tgz" },
                { status: 400 }
            )
        }
        
        // Validate file size (max 10GB)
        const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024
        if (file.size > MAX_FILE_SIZE) {
            return NextResponse.json(
                { error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB` },
                { status: 400 }
            )
        }
        
        // Extract and sanitize project name from filename
        let projectName = file.name
            .replace(/-overlay\.ext4\.tar\.gz$/, "")
            .replace(/\.tar\.gz$/, "")
            .replace(/\.tgz$/, "")
            .trim()
        
        // Sanitize: remove special characters, limit length
        projectName = projectName.replace(/[^a-zA-Z0-9_-\s]/g, "").slice(0, 100)
        
        if (!projectName) {
            projectName = "Uploaded Project"
        }
        
        // Forward to vm-orchestrator
        const uploadFormData = new FormData()
        uploadFormData.append("file", file)
        uploadFormData.append("projectName", projectName)
        
        const vmResponse = await fetch("http://localhost:3003/api/overlay/upload", {
            method: "POST",
            body: uploadFormData,
            signal: AbortSignal.timeout(300000) // 5 minute timeout for large uploads
        })
        
        if (!vmResponse.ok) {
            const error = await vmResponse.json()
            return NextResponse.json(
                { error: error.error || "Upload failed" },
                { status: vmResponse.status }
            )
        }
        
        const responseData = await vmResponse.json()
        projectId = responseData.projectId
        
        if (!projectId) {
            throw new Error("VM orchestrator did not return a project ID")
        }
        
        // Check if project ID already exists (shouldn't happen with UUID, but be safe)
        const existing = projectDb.findUnique({ id: projectId })
        if (existing) {
            // Clean up orphaned disk file with retry
            let cleanupSuccess = false
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const deleteResponse = await fetch(`http://localhost:3003/api/overlay/delete/${projectId}`, {
                        method: "DELETE",
                        signal: AbortSignal.timeout(10000)
                    })
                    if (deleteResponse.ok || deleteResponse.status === 404) {
                        cleanupSuccess = true
                        break
                    }
                    console.warn(`Cleanup attempt ${attempt + 1} failed with status ${deleteResponse.status}`)
                } catch (cleanupError) {
                    console.error(`Cleanup attempt ${attempt + 1} error:`, cleanupError)
                    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000))
                }
            }
            
            if (!cleanupSuccess) {
                console.error("All cleanup attempts failed - orphaned disk may exist")
            }
            
            return NextResponse.json(
                { error: "Project ID conflict. Please try uploading again." },
                { status: 409 }
            )
        }
        
        // Create project in database with the same ID used for the overlay disk
        try {
            const project = projectDb.create({
                id: projectId,
                name: projectName,
                description: `Uploaded from ${file.name}`
            })
            
            return NextResponse.json({ project })
        } catch (dbError) {
            // Database insert failed - clean up orphaned disk file with retry
            console.error("Database insert failed, cleaning up disk:", dbError)
            
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const deleteResponse = await fetch(`http://localhost:3003/api/overlay/delete/${projectId}`, {
                        method: "DELETE",
                        signal: AbortSignal.timeout(10000)
                    })
                    if (deleteResponse.ok || deleteResponse.status === 404) {
                        break
                    }
                } catch (cleanupError) {
                    console.error(`Disk cleanup attempt ${attempt + 1} failed:`, cleanupError)
                    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000))
                }
            }
            
            throw dbError
        }
    } catch (error) {
        console.error("Upload error:", error)
        
        // Provide specific error messages for common cases
        if (error && typeof error === 'object' && 'name' in error) {
            if (error.name === 'TimeoutError') {
                return NextResponse.json(
                    { error: "Upload timed out. File may be too large or network is slow." },
                    { status: 408 }
                )
            }
            if (error.name === 'AbortError') {
                return NextResponse.json(
                    { error: "Upload was cancelled" },
                    { status: 499 }
                )
            }
        }
        
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to upload overlay" },
            { status: 500 }
        )
    }
}
