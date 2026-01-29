// VM Directory API Client
// Provides window.getVMDirectory() function for console debugging

interface DirEntry {
    path: string
    type: "file" | "directory"
    size?: number
}

interface VMDirectoryResponse {
    entries: DirEntry[]
    count: number
}

async function getVMDirectory(vmId: number = 3): Promise<VMDirectoryResponse> {
    try {
        const response = await fetch(`/api/vm/${vmId}/directory`)
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`)
        }
        
        const data = await response.json()
        
        // Pretty print to console
        console.log(`\n📁 VM Directory Structure (${data.count} entries):\n`)
        
        // Group by type
        const dirs = data.entries.filter((e: DirEntry) => e.type === 'directory')
        const files = data.entries.filter((e: DirEntry) => e.type === 'file')
        
        if (dirs.length > 0) {
            console.log('📂 Directories:')
            dirs.forEach((d: DirEntry) => console.log(`  ${d.path}/`))
        }
        
        if (files.length > 0) {
            console.log('\n📄 Files:')
            files.forEach((f: DirEntry) => {
                const sizeStr = f.size ? ` (${(f.size / 1024).toFixed(2)} KB)` : ''
                console.log(`  ${f.path}${sizeStr}`)
            })
        }
        
        console.log('')
        
        return data
        
    } catch (error) {
        console.error('Failed to fetch VM directory:', error)
        throw error
    }
}

// Expose to window for console access
if (typeof window !== 'undefined') {
    (window as any).getVMDirectory = getVMDirectory
}

export { getVMDirectory }
