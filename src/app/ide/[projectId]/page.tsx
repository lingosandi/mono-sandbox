"use client"

import { useState, useEffect } from "react"
import { useParams } from "next/navigation"
import { useProjectFiles } from "./hooks/useProjectFiles"
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts"
import { useClipboard } from "./hooks/useClipboard"
import {
    FileExplorer,
    EditorArea
} from "./components"

// Import VM directory utility for console debugging
import "@/lib/vm-directory"

export default function IDEProjectPage() {
    const params = useParams()
    const projectId = params.projectId as string

    // Project files management
    const {
        files,
        openFiles,
        activeFile,
        loading,
        setActiveFile,
        openFile,
        saveFile,
        closeFile,
        updateFileContent,
        createFile,
        deleteFile,
        renameFile
    } = useProjectFiles({ projectId })

    // Clipboard management
    const { clipboardItem, copyToClipboard, clearClipboard } = useClipboard()

    // Keyboard shortcuts
    useKeyboardShortcuts(activeFile, saveFile)

    // Default to terminal tab when no files are open
    useEffect(() => {
        if (openFiles.length === 0 && activeFile !== "terminal") {
            setActiveFile("terminal")
        }
    }, [openFiles.length, activeFile, setActiveFile])

    // Inline file/folder creation
    const [creatingItem, setCreatingItem] = useState<{
        type: "file" | "directory"
        parentPath: string
    } | null>(null)

    // Inline rename
    const [renamingItem, setRenamingItem] = useState<{
        path: string
        type: "file" | "directory"
        currentName: string
    } | null>(null)

    async function handleCreateItem(
        name: string,
        type: "file" | "directory",
        parentPath: string
    ) {
        if (!name) {
            setCreatingItem(null)
            return
        }

        const fullPath = parentPath ? `${parentPath}/${name}` : name
        await createFile(fullPath, type)
        setCreatingItem(null)
    }

    async function handleCut(path: string, type: "file" | "directory") {
        copyToClipboard(path, type, "cut")
    }

    async function handleCopy(path: string, type: "file" | "directory") {
        copyToClipboard(path, type, "copy")
    }

    async function handlePaste(parentPath: string) {
        if (!clipboardItem) return

        const fileName = clipboardItem.path.split("/").pop() || ""
        const newPath = parentPath ? `${parentPath}/${fileName}` : fileName

        if (clipboardItem.operation === "cut") {
            // Move the file/folder
            await renameFile(clipboardItem.path, newPath)
            clearClipboard()
        } else {
            // TODO: Implement full copy operation by reading file content and creating duplicate
            // For now, just show an alert
            alert(
                "Copy operation not yet fully implemented. Please use cut/paste for moving files."
            )
        }
    }

    async function handleStartRename(path: string, type: "file" | "directory") {
        const fileName = path.split("/").pop() || ""
        setRenamingItem({ path, type, currentName: fileName })
    }

    async function handleRenameItem(oldPath: string, newName: string) {
        if (!newName || newName === oldPath.split("/").pop()) {
            setRenamingItem(null)
            return
        }

        const parentPath = oldPath.substring(0, oldPath.lastIndexOf("/"))
        const newPath = parentPath ? `${parentPath}/${newName}` : newName
        await renameFile(oldPath, newPath)
        setRenamingItem(null)
    }

    const activeFileContent = openFiles.find((f) => f.path === activeFile)

    return (
        <div className="flex h-screen hex-background text-zinc-100 overflow-hidden font-sans selection:bg-blue-500/20">
            <FileExplorer
                files={files}
                loading={loading}
                activeFile={activeFile}
                creatingItem={creatingItem}
                renamingItem={renamingItem}
                onOpenFile={openFile}
                onCreateFile={() =>
                    setCreatingItem({ type: "file", parentPath: "" })
                }
                onCreateFolder={() =>
                    setCreatingItem({ type: "directory", parentPath: "" })
                }
                onCreateItem={handleCreateItem}
                onCancelCreate={() => setCreatingItem(null)}
                onStartCreateFile={(parentPath) =>
                    setCreatingItem({ type: "file", parentPath })
                }
                onStartCreateFolder={(parentPath) =>
                    setCreatingItem({ type: "directory", parentPath })
                }
                onDeleteFile={deleteFile}
                onCut={handleCut}
                onCopy={handleCopy}
                onPaste={handlePaste}
                onStartRename={handleStartRename}
                onRenameItem={handleRenameItem}
                onCancelRename={() => setRenamingItem(null)}
                clipboardItem={clipboardItem}
            />

            <EditorArea
                openFiles={openFiles}
                activeFile={activeFile}
                activeFileContent={activeFileContent}
                onSetActiveFile={setActiveFile}
                onCloseFile={closeFile}
                onUpdateContent={updateFileContent}
                projectId={projectId}
            />
        </div>
    )
}
