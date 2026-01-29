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
 * Create a new ext4 overlay disk
 * Size: 5GB (OverlayFS changes + project files + installed packages)
 */
async function createOverlayDisk(diskPath: string): Promise<void> {
    const sizeMB = 5120 // 5GB overlay disk (OverlayFS + project files + packages)

    try {
        // Create empty file
        await execAsync(
            `dd if=/dev/zero of="${diskPath}" bs=1M count=${sizeMB}`
        )

        // Format as ext4
        await execAsync(`mkfs.ext4 -F "${diskPath}"`)

        console.log(`[OverlayDisk] Created ${sizeMB}MB overlay disk`)
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
    const overlayPath = path.join(
        FIRECRACKER_PROJECTS_DIR,
        `${projectId}-overlay.ext4`
    )

    try {
        if (await pathExists(overlayPath)) {
            await execAsync(`rm -f "${overlayPath}"`)
            console.log(`[OverlayDisk] Deleted overlay: ${overlayPath}`)
        }
    } catch (error) {
        console.error(
            `[OverlayDisk] Failed to delete overlay disk:`,
            error instanceof Error ? error.message : error
        )
    }
}
