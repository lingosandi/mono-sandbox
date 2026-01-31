import { Button } from "@/components/ui/button"
import { Folder, Plus } from "lucide-react"
import { FileTree } from "./FileTree"
import { SectionBar } from "./SectionBar"
import type { FileNode } from "../hooks/useProjectFiles"
import type { ClipboardItem } from "../hooks/useClipboard"

interface FileExplorerProps {
    files: FileNode[]
    loading: boolean
    activeFile: string | null
    creatingItem: { type: "file" | "directory"; parentPath: string } | null
    renamingItem?: {
        path: string
        type: "file" | "directory"
        currentName: string
    } | null
    onOpenFile: (path: string) => void
    onCreateFile: () => void
    onCreateFolder: () => void
    onCreateItem: (
        name: string,
        type: "file" | "directory",
        parentPath: string
    ) => void
    onCancelCreate: () => void
    onStartCreateFile: (parentPath: string) => void
    onStartCreateFolder: (parentPath: string) => void
    onDeleteFile: (path: string) => void
    onCut: (path: string, type: "file" | "directory") => void
    onCopy: (path: string, type: "file" | "directory") => void
    onPaste: (parentPath: string) => void
    onStartRename?: (path: string, type: "file" | "directory") => void
    onRenameItem?: (oldPath: string, newName: string) => void
    onCancelRename?: () => void
    clipboardItem: ClipboardItem | null
}

export function FileExplorer({
    files,
    loading,
    activeFile,
    creatingItem,
    renamingItem,
    onOpenFile,
    onCreateFile,
    onCreateFolder,
    onCreateItem,
    onCancelCreate,
    onStartCreateFile,
    onStartCreateFolder,
    onDeleteFile,
    onCut,
    onCopy,
    onPaste,
    onStartRename,
    onRenameItem,
    onCancelRename,
    clipboardItem
}: FileExplorerProps) {
    return (
        <div className="w-64 border-r border-white/5 bg-transparent flex flex-col shrink-0">
            <SectionBar
                title="Explorer"
                actions={
                    <div className="flex items-center gap-1">
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-zinc-400 hover:text-white"
                            onClick={onCreateFile}
                            title="New File"
                        >
                            <Plus className="h-4 w-4" />
                        </Button>
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-zinc-400 hover:text-white"
                            onClick={onCreateFolder}
                            title="New Folder"
                        >
                            <Folder className="h-4 w-4" />
                        </Button>
                    </div>
                }
            />

            <div className="flex-1 overflow-auto px-2 pb-2 scrollbar-thin scrollbar-thumb-zinc-800">
                {loading ? (
                    <p className="text-xs text-zinc-500 p-2">Loading...</p>
                ) : (
                    <FileTree
                        nodes={files}
                        onSelect={onOpenFile}
                        onDelete={onDeleteFile}
                        activeFile={activeFile}
                        creatingItem={creatingItem}
                        renamingItem={renamingItem}
                        onCreateItem={onCreateItem}
                        onCancelCreate={onCancelCreate}
                        onStartCreateFile={onStartCreateFile}
                        onStartCreateFolder={onStartCreateFolder}
                        onCut={onCut}
                        onCopy={onCopy}
                        onPaste={onPaste}
                        onStartRename={onStartRename}
                        onRenameItem={onRenameItem}
                        onCancelRename={onCancelRename}
                        clipboardItem={clipboardItem}
                    />
                )}
            </div>
        </div>
    )
}
