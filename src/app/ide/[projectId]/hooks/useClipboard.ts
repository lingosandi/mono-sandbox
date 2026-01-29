import { useState, useCallback } from "react"

export type ClipboardOperation = "cut" | "copy"

export interface ClipboardItem {
    path: string
    type: "file" | "directory"
    operation: ClipboardOperation
}

export function useClipboard() {
    const [clipboardItem, setClipboardItem] = useState<ClipboardItem | null>(
        null
    )

    const copyToClipboard = useCallback(
        (path: string, type: "file" | "directory", operation: ClipboardOperation) => {
            setClipboardItem({ path, type, operation })
        },
        []
    )

    const clearClipboard = useCallback(() => {
        setClipboardItem(null)
    }, [])

    return {
        clipboardItem,
        copyToClipboard,
        clearClipboard
    }
}
