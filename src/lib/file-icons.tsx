import * as FileIcons from "file-icons-js"
import "file-icons-js/css/style.css"

/**
 * Get the file icon class name for a given filename
 * @param filename - The name of the file
 * @param isDirectory - Whether this is a directory
 * @returns React component that renders the icon
 */
export function getFileIcon(filename: string, isDirectory: boolean = false) {
    if (isDirectory) {
        // Return a folder icon component
        const FolderIcon = ({ className }: { className?: string }) => (
            <i className={`${className} folder-icon medium-blue`} />
        )
        FolderIcon.displayName = "FolderIcon"
        return FolderIcon
    }

    // Get icon class from file-icons-js
    const iconClass =
        FileIcons.getClassWithColor(filename) || "text-icon medium-blue"

    const FileIcon = ({ className }: { className?: string }) => (
        <div className={`${className} ${iconClass}`} />
    )
    FileIcon.displayName = "FileIcon"
    return FileIcon
}
