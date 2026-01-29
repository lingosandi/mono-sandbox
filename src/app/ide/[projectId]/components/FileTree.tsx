import { useMemo, useCallback, useState, useRef, useEffect } from "react"
import { TreeView, type TreeDataItem } from "@/components/ui/tree-view"
import { getFileIcon } from "@/lib/file-icons"
import type { FileNode } from "../hooks/useProjectFiles"
import type { ClipboardItem } from "../hooks/useClipboard"
import {
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator
} from "@/components/ui/context-menu"
import {
    Scissors,
    Copy,
    FilePlus2,
    FolderPlus,
    Clipboard,
    FileText,
    Edit3,
    Trash2,
    File,
    ChevronRight
} from "lucide-react"

interface FileTreeProps {
    nodes: FileNode[]
    onSelect: (path: string) => void
    onDelete: (path: string) => void
    activeFile: string | null
    level?: number
    creatingItem?: { type: "file" | "directory"; parentPath: string } | null
    renamingItem?: {
        path: string
        type: "file" | "directory"
        currentName: string
    } | null
    onCreateItem?: (
        name: string,
        type: "file" | "directory",
        parentPath: string
    ) => void
    onCancelCreate?: () => void
    onStartCreateFile?: (parentPath: string) => void
    onStartCreateFolder?: (parentPath: string) => void
    onCut?: (path: string, type: "file" | "directory") => void
    onCopy?: (path: string, type: "file" | "directory") => void
    onPaste?: (parentPath: string) => void
    onStartRename?: (path: string, type: "file" | "directory") => void
    onRenameItem?: (oldPath: string, newName: string) => void
    onCancelRename?: () => void
    clipboardItem?: ClipboardItem | null
}

// Extended TreeDataItem with additional metadata
interface ExtendedTreeDataItem extends TreeDataItem {
    path: string
    isDirectory: boolean
    children?: ExtendedTreeDataItem[]
}

function handleCopyPath(path: string) {
    navigator.clipboard.writeText(path).catch((error) => {
        console.error("Failed to copy path to clipboard:", error)
        alert(`Path: ${path}`)
    })
}

function handleCopyRelativePath(path: string) {
    navigator.clipboard.writeText(path).catch((error) => {
        console.error("Failed to copy relative path to clipboard:", error)
        alert(`Relative path: ${path}`)
    })
}

// Create input component for new files/folders
function CreateInput({
    type,
    parentPath,
    onSubmit,
    onCancel
}: {
    type: "file" | "directory"
    parentPath: string
    onSubmit: (
        name: string,
        type: "file" | "directory",
        parentPath: string
    ) => void
    onCancel: () => void
}) {
    const [value, setValue] = useState("")
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        inputRef.current?.focus()
    }, [])

    const handleSubmit = () => {
        const trimmed = value.trim()
        if (trimmed) {
            onSubmit(trimmed, type, parentPath)
            setValue("")
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault()
            handleSubmit()
        } else if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
        }
    }

    const handleBlur = () => {
        const trimmed = value.trim()
        if (trimmed) {
            handleSubmit()
        } else {
            onCancel()
        }
    }

    return (
        <div className="flex text-left items-center py-0.5 px-2 before:right-1">
            {type === "directory" ? (
                <ChevronRight className="h-4 w-4 shrink-0 mr-1 text-zinc-400" />
            ) : (
                <File className="h-4 w-4 shrink-0 mr-1 text-zinc-400" />
            )}
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                className="grow text-sm bg-transparent border-none outline-none text-zinc-300 focus:ring-0"
                placeholder={type === "directory" ? "Folder name" : "File name"}
            />
        </div>
    )
}

// Rename input component
function RenameInput({
    type,
    currentName,
    oldPath,
    onSubmit,
    onCancel
}: {
    type: "file" | "directory"
    currentName: string
    oldPath: string
    onSubmit: (oldPath: string, newName: string) => void
    onCancel: () => void
}) {
    const [value, setValue] = useState(currentName)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
    }, [])

    const handleSubmit = () => {
        const trimmed = value.trim()
        if (trimmed && trimmed !== currentName) {
            onSubmit(oldPath, trimmed)
        } else {
            onCancel()
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault()
            handleSubmit()
        } else if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
        }
    }

    const handleBlur = () => {
        handleSubmit()
    }

    return (
        <div className="flex text-left items-center py-0.5 px-2 before:right-1">
            {type === "directory" ? (
                <ChevronRight className="h-4 w-4 shrink-0 mr-1 text-zinc-400" />
            ) : (
                <File className="h-4 w-4 shrink-0 mr-1 text-zinc-400" />
            )}
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                className="grow text-sm bg-transparent border-none outline-none text-zinc-300 focus:ring-0"
            />
        </div>
    )
}

// Convert FileNode to ExtendedTreeDataItem recursively
function convertToTreeData(
    nodes: FileNode[],
    onSelect: (path: string) => void,
    renderContextMenu: (node: FileNode) => React.ReactNode,
    creatingItem: { type: "file" | "directory"; parentPath: string } | null,
    createInputElement: React.ReactNode,
    renamingItem: {
        path: string
        type: "file" | "directory"
        currentName: string
    } | null,
    renameInputElement: React.ReactNode
): ExtendedTreeDataItem[] {
    return nodes.map((node) => {
        // If this node is being renamed, show the rename input instead
        if (renamingItem && node.path === renamingItem.path) {
            return {
                id: node.path,
                name: node.name,
                path: node.path,
                isDirectory: node.type === "directory",
                customContent: renameInputElement
            }
        }

        const treeItem: ExtendedTreeDataItem = {
            id: node.path,
            name: node.name,
            path: node.path,
            isDirectory: node.type === "directory",
            icon: getFileIcon(node.name, node.type === "directory"),
            children: node.children
                ? convertToTreeData(
                      node.children,
                      onSelect,
                      renderContextMenu,
                      creatingItem,
                      createInputElement,
                      renamingItem,
                      renameInputElement
                  )
                : undefined,
            onClick: () => {
                if (node.type === "file") {
                    onSelect(node.path)
                }
            },
            contextMenu: renderContextMenu(node)
        }

        // If this node is the parent where we're creating a new item, inject the input
        if (
            creatingItem &&
            node.path === creatingItem.parentPath &&
            node.type === "directory"
        ) {
            const createItemData: ExtendedTreeDataItem = {
                id: `__creating__${creatingItem.parentPath}`,
                name: "",
                path: "",
                isDirectory: creatingItem.type === "directory",
                customContent: createInputElement
            }

            treeItem.children = [createItemData, ...(treeItem.children || [])]
        }

        return treeItem
    })
}

export function FileTree({
    nodes,
    onSelect,
    onDelete,
    activeFile,
    creatingItem,
    renamingItem,
    onCreateItem,
    onCancelCreate,
    onStartCreateFile,
    onStartCreateFolder,
    onCut,
    onCopy,
    onPaste,
    onStartRename,
    onRenameItem,
    onCancelRename,
    clipboardItem
}: FileTreeProps) {
    const renderContextMenu = useCallback(
        (node: FileNode) => {
            const isDirectory = node.type === "directory"

            return (
                <ContextMenuContent className="w-56">
                    {isDirectory ? (
                        <>
                            <ContextMenuItem
                                onClick={() => onStartCreateFile?.(node.path)}
                            >
                                <FilePlus2 className="h-4 w-4 mr-2" />
                                <span>New File</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => onStartCreateFolder?.(node.path)}
                            >
                                <FolderPlus className="h-4 w-4 mr-2" />
                                <span>New Folder</span>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                onClick={() => onCut?.(node.path, node.type)}
                            >
                                <Scissors className="h-4 w-4 mr-2" />
                                <span>Cut</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => onCopy?.(node.path, node.type)}
                            >
                                <Copy className="h-4 w-4 mr-2" />
                                <span>Copy</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => onPaste?.(node.path)}
                                disabled={!clipboardItem}
                            >
                                <Clipboard className="h-4 w-4 mr-2" />
                                <span>Paste</span>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                onClick={() => handleCopyPath(node.path)}
                            >
                                <FileText className="h-4 w-4 mr-2" />
                                <span>Copy Path</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() =>
                                    handleCopyRelativePath(node.path)
                                }
                            >
                                <FileText className="h-4 w-4 mr-2" />
                                <span>Copy Relative Path</span>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                onClick={() =>
                                    onStartRename?.(node.path, node.type)
                                }
                            >
                                <Edit3 className="h-4 w-4 mr-2" />
                                <span>Rename</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => onDelete(node.path)}
                                className="text-red-600 focus:text-red-600"
                            >
                                <Trash2 className="h-4 w-4 mr-2" />
                                <span>Delete</span>
                            </ContextMenuItem>
                        </>
                    ) : (
                        <>
                            <ContextMenuItem
                                onClick={() => onCut?.(node.path, node.type)}
                            >
                                <Scissors className="h-4 w-4 mr-2" />
                                <span>Cut</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => onCopy?.(node.path, node.type)}
                            >
                                <Copy className="h-4 w-4 mr-2" />
                                <span>Copy</span>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                onClick={() => handleCopyPath(node.path)}
                            >
                                <FileText className="h-4 w-4 mr-2" />
                                <span>Copy Path</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() =>
                                    handleCopyRelativePath(node.path)
                                }
                            >
                                <FileText className="h-4 w-4 mr-2" />
                                <span>Copy Relative Path</span>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                onClick={() =>
                                    onStartRename?.(node.path, node.type)
                                }
                            >
                                <Edit3 className="h-4 w-4 mr-2" />
                                <span>Rename</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => onDelete(node.path)}
                                className="text-red-600 focus:text-red-600"
                            >
                                <Trash2 className="h-4 w-4 mr-2" />
                                <span>Delete</span>
                            </ContextMenuItem>
                        </>
                    )}
                </ContextMenuContent>
            )
        },
        [
            onStartCreateFile,
            onStartCreateFolder,
            onCut,
            onCopy,
            onPaste,
            onStartRename,
            onDelete,
            clipboardItem
        ]
    )

    const treeData = useMemo(() => {
        const createInputElement =
            creatingItem && onCreateItem && onCancelCreate ? (
                <CreateInput
                    type={creatingItem.type}
                    parentPath={creatingItem.parentPath}
                    onSubmit={onCreateItem}
                    onCancel={onCancelCreate}
                />
            ) : null

        const renameInputElement =
            renamingItem && onRenameItem && onCancelRename ? (
                <RenameInput
                    type={renamingItem.type}
                    currentName={renamingItem.currentName}
                    oldPath={renamingItem.path}
                    onSubmit={onRenameItem}
                    onCancel={onCancelRename}
                />
            ) : null

        const items = convertToTreeData(
            nodes,
            onSelect,
            renderContextMenu,
            creatingItem || null,
            createInputElement,
            renamingItem || null,
            renameInputElement
        )

        // If creating at root level (parentPath is empty), inject at the beginning
        if (
            creatingItem &&
            creatingItem.parentPath === "" &&
            createInputElement
        ) {
            const createItemData: ExtendedTreeDataItem = {
                id: `__creating__root`,
                name: "",
                path: "",
                isDirectory: creatingItem.type === "directory",
                customContent: createInputElement
            }
            return [createItemData, ...items]
        }

        return items
    }, [
        nodes,
        onSelect,
        renderContextMenu,
        creatingItem,
        onCreateItem,
        onCancelCreate,
        renamingItem,
        onRenameItem,
        onCancelRename
    ])

    const forceExpandedIds = creatingItem
        ? [creatingItem.parentPath]
        : undefined

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <div className="h-full">
                    <TreeView
                        data={treeData}
                        initialSelectedItemId={activeFile || undefined}
                        expandAll={false}
                        forceExpandedIds={forceExpandedIds}
                    />
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
                <ContextMenuItem onClick={() => onStartCreateFile?.("")}>
                    <FilePlus2 className="h-4 w-4 mr-2" />
                    <span>New File</span>
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onStartCreateFolder?.("")}>
                    <FolderPlus className="h-4 w-4 mr-2" />
                    <span>New Folder</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                    onClick={() => onPaste?.("")}
                    disabled={!clipboardItem}
                >
                    <Clipboard className="h-4 w-4 mr-2" />
                    <span>Paste</span>
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    )
}
