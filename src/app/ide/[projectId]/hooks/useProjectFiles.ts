import { useState, useCallback, useEffect, useRef } from "react"
import { useFileOperations } from "./useFileOperations"

export interface FileNode {
    name: string
    path: string
    type: "file" | "directory"
    children?: FileNode[]
}

export interface OpenFile {
    path: string
    content: string
    isDirty: boolean
}

interface UseProjectFilesConfig {
    projectId: string
}

export function useProjectFiles(config: UseProjectFilesConfig) {
    const { projectId } = config
    const [files, setFiles] = useState<FileNode[]>([])
    const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
    const [activeFile, setActiveFile] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [isConnected, setIsConnected] = useState(false)
    const hasLoadedRef = useRef(false)

    // Memoized callbacks to prevent infinite WebSocket reconnections
    const handleConnected = useCallback(() => {
        setIsConnected(true)
    }, [])

    const handleError = useCallback((error: Error) => {
        console.error("Connection error:", error)
        setIsConnected(false)
    }, [])

    // File change handler (loadFiles will be called via ref)
    const loadFilesRef = useRef<(() => Promise<void>) | null>(null)
    const handleFileChanged = useCallback(() => {
        // File changed in VM - refresh file list
        loadFilesRef.current?.()
    }, [])

    // Initialize WebSocket file operations
    const fileOps = useFileOperations({
        projectId,
        onConnected: handleConnected,
        onError: handleError,
        onFileChanged: handleFileChanged
    })

    const loadFiles = useCallback(async () => {
        if (!fileOps || !fileOps.isConnected) {
            return
        }

        setLoading(true)
        try {
            // Use shallow depth of 1 for fast initial load
            const response = await fileOps.listFiles("", 1)
            const fileList = Array.isArray(response) ? response : []
            // Use requestIdleCallback to update state during idle time
            if (typeof requestIdleCallback !== "undefined") {
                requestIdleCallback(
                    () => {
                        setFiles(fileList)
                        hasLoadedRef.current = true
                    },
                    { timeout: 1000 }
                )
            } else {
                setFiles(fileList)
                hasLoadedRef.current = true
            }
        } catch (error) {
            console.error("Failed to load files:", error)
        } finally {
            setLoading(false)
        }
    }, [fileOps])

    // Update ref when loadFiles changes
    useEffect(() => {
        loadFilesRef.current = loadFiles
    }, [loadFiles])

    // Auto-load files when connected
    useEffect(() => {
        if (isConnected && !hasLoadedRef.current && fileOps?.isConnected) {
            loadFiles()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isConnected])

    const openFile = useCallback(
        async (path: string) => {
            if (!fileOps) return

            const existing = openFiles.find((f) => f.path === path)
            if (existing) {
                setActiveFile(path)
                return
            }

            try {
                const data = (await fileOps.readFile(path)) as {
                    content: string
                }
                setOpenFiles([
                    ...openFiles,
                    { path, content: data.content, isDirty: false }
                ])
                setActiveFile(path)
            } catch (error) {
                console.error("Failed to open file:", error)
            }
        },
        [openFiles, fileOps]
    )

    const saveFile = useCallback(
        async (path: string) => {
            if (!fileOps) return false

            const file = openFiles.find((f) => f.path === path)
            if (!file) return false

            try {
                await fileOps.writeFile(path, file.content)

                setOpenFiles(
                    openFiles.map((f) =>
                        f.path === path ? { ...f, isDirty: false } : f
                    )
                )
                return true
            } catch (error) {
                console.error("Failed to save file:", error)
            }
            return false
        },
        [openFiles, fileOps]
    )

    const closeFile = useCallback(
        (path: string) => {
            const file = openFiles.find((f) => f.path === path)
            if (file?.isDirty) {
                if (
                    !confirm(
                        "You have unsaved changes. Are you sure you want to close this file?"
                    )
                ) {
                    return
                }
            }

            setOpenFiles(openFiles.filter((f) => f.path !== path))
            if (activeFile === path) {
                const remaining = openFiles.filter((f) => f.path !== path)
                setActiveFile(remaining.length > 0 ? remaining[0].path : null)
            }
        },
        [openFiles, activeFile]
    )

    const updateFileContent = useCallback(
        (path: string, content: string) => {
            setOpenFiles(
                openFiles.map((f) =>
                    f.path === path ? { ...f, content, isDirty: true } : f
                )
            )
        },
        [openFiles]
    )

    const createFile = useCallback(
        async (filePath: string, type: "file" | "directory") => {
            if (!fileOps) return false

            try {
                await fileOps.createItem(filePath, type)
                await loadFiles()

                if (type === "file") {
                    await openFile(filePath)
                }
                return true
            } catch (error) {
                console.error("Failed to create file:", error)
            }
            return false
        },
        [fileOps, loadFiles, openFile]
    )

    const deleteFile = useCallback(
        async (path: string) => {
            if (!fileOps) return false
            if (!confirm("Are you sure you want to delete this file?"))
                return false

            try {
                await fileOps.deleteItem(path)

                setOpenFiles(openFiles.filter((f) => f.path !== path))
                if (activeFile === path) {
                    setActiveFile(null)
                }
                await loadFiles()
                return true
            } catch (error) {
                console.error("Failed to delete file:", error)
            }
            return false
        },
        [fileOps, openFiles, activeFile, loadFiles]
    )

    const renameFile = useCallback(
        async (oldPath: string, newPath: string) => {
            if (!fileOps) return false

            try {
                await fileOps.renameItem(oldPath, newPath)

                // Update open files
                setOpenFiles(
                    openFiles.map((f) =>
                        f.path === oldPath ? { ...f, path: newPath } : f
                    )
                )
                if (activeFile === oldPath) {
                    setActiveFile(newPath)
                }
                await loadFiles()
                return true
            } catch (error) {
                console.error("Failed to rename file:", error)
            }
            return false
        },
        [fileOps, openFiles, activeFile, loadFiles]
    )

    return {
        files,
        openFiles,
        activeFile,
        loading,
        isConnected,
        setActiveFile,
        loadFiles,
        openFile,
        saveFile,
        closeFile,
        updateFileContent,
        createFile,
        deleteFile,
        renameFile
    }
}
