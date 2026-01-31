import { exec } from "child_process"
import { promisify } from "util"
import { access, mkdir } from "fs/promises"
import path from "path"
import { FIRECRACKER_PROJECTS_DIR } from "./config"

const execAsync = promisify(exec)

// Track in-progress overlay disk creations to prevent race conditions
const creatingOverlays = new Map<string, Promise<string>>()

// Hoisted helper - Check if path exists
async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath)
        return true
    } catch {
        return false
    }
}

// Hoisted helper - Validate projectId for security
function validateProjectId(projectId: string): void {
    if (!projectId || typeof projectId !== "string") {
        throw new Error("Invalid projectId: must be non-empty string")
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
        throw new Error("Invalid projectId: contains illegal characters")
    }
    if (projectId.length > 100) {
        throw new Error("Invalid projectId: too long")
    }
}

/**
 * Get or create a persistent overlay disk for a project
 * Overlay disk stores writable changes to the read-only rootfs AND project files
 * Format: {projectId}-overlay.ext4
 * 
 * RACE CONDITION SAFE: Uses promise deduplication to prevent concurrent creation
 */
export async function getOrCreateOverlayDisk(
    projectId: string
): Promise<string> {
    // Validate projectId to prevent path traversal attacks
    validateProjectId(projectId)
    
    const overlayPath = path.join(FIRECRACKER_PROJECTS_DIR, `${projectId}-overlay.ext4`)
    const cacheKey = overlayPath

    // Check if overlay already exists (fast path)
    if (await pathExists(overlayPath)) {
        console.log(`[OverlayDisk] Reusing existing overlay: ${overlayPath}`)
        return overlayPath
    }

    // Check if another VM is already creating this overlay (race condition guard)
    const existingCreation = creatingOverlays.get(cacheKey)
    if (existingCreation) {
        console.log(`[OverlayDisk] Waiting for in-progress creation: ${overlayPath}`)
        return await existingCreation
    }

    // Create new overlay disk (deduped by promise)
    const creationPromise = (async () => {
        try {
            // Double-check after acquiring creation lock
            if (await pathExists(overlayPath)) {
                console.log(`[OverlayDisk] Overlay created by concurrent VM: ${overlayPath}`)
                return overlayPath
            }

            // Create overlay directory if needed
            await mkdir(FIRECRACKER_PROJECTS_DIR, { recursive: true })

            // Create overlay disk (cleanup on error to prevent corrupted disk)
            console.log(`[OverlayDisk] Creating new overlay disk: ${overlayPath}`)
            try {
                await createOverlayDisk(overlayPath)
            } catch (error) {
                // Clean up partial/corrupted disk file on creation failure
                try {
                    await execAsync(`rm -f "${overlayPath}"`)
                    console.log(`[OverlayDisk] Cleaned up partial disk after creation failure`)
                } catch {}
                throw error
            }

            return overlayPath
        } finally {
            // Clean up tracking Map to prevent memory leak
            creatingOverlays.delete(cacheKey)
        }
    })()

    // Store promise to deduplicate concurrent requests
    creatingOverlays.set(cacheKey, creationPromise)

    return await creationPromise
}

/**
 * Create a new ext4 overlay disk (sparse file that grows as needed)
 * Max Size: 5GB (OverlayFS changes + project files + installed packages)
 */
async function createOverlayDisk(diskPath: string): Promise<void> {
    const sizeGB = 5 // Max 5GB overlay disk (OverlayFS + project files + packages)

    try {
        // Create sparse file using truncate (faster than dd and truly sparse)
        // File size is 5GB but only uses disk space for written blocks
        await execAsync(`truncate -s ${sizeGB}G "${diskPath}"`)

        // Format as ext4 with optimizations:
        // -F: Force (don't prompt)
        // -m 0: Don't reserve blocks for root (we're not using this as system disk)
        // -O sparse_super2: Use sparse superblock for better sparse file support
        // -E lazy_itable_init=0,lazy_journal_init=0: Initialize immediately (avoid delays on first mount)
        await execAsync(
            `mkfs.ext4 -F -m 0 -O sparse_super2 -E lazy_itable_init=0,lazy_journal_init=0 "${diskPath}"`
        )

        // Verify disk was created successfully
        if (!(await pathExists(diskPath))) {
            throw new Error("Disk file not found after creation")
        }

        console.log(`[OverlayDisk] Created sparse overlay disk (max ${sizeGB}GB)`)
    } catch (error) {
        console.error(
            `[OverlayDisk] Failed to create overlay disk:`,
            error instanceof Error ? error.message : error
        )
        throw error
    }
}

/**
 * Clean up overlay disk for a project
 */
export async function deleteOverlayDisk(projectId: string): Promise<void> {
    // Validate projectId to prevent path traversal attacks
    validateProjectId(projectId)
    
    const overlayPath = path.join(
        FIRECRACKER_PROJECTS_DIR,
        `${projectId}-overlay.ext4`
    )

    // Wait for any in-progress creation to complete (race condition guard)
    const existingCreation = creatingOverlays.get(overlayPath)
    if (existingCreation) {
        console.log(`[OverlayDisk] Waiting for creation to complete before deletion: ${overlayPath}`)
        try {
            await existingCreation
        } catch {
            // Creation failed, continue with deletion anyway
        }
    }

    try {
        if (await pathExists(overlayPath)) {
            await execAsync(`rm -f "${overlayPath}"`)
            
            // Verify deletion succeeded
            if (await pathExists(overlayPath)) {
                throw new Error("Overlay file still exists after deletion attempt")
            }
            
            console.log(`[OverlayDisk] Deleted overlay: ${overlayPath}`)
        }
    } catch (error) {
        console.error(
            `[OverlayDisk] Failed to delete overlay disk:`,
            error instanceof Error ? error.message : error
        )
        throw error // Re-throw to propagate deletion failures
    }
}
