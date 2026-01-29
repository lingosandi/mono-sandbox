import { useEffect } from "react"
// @ts-expect-error - tinykeys has type issues with exports
import { createKeybindingsHandler } from "tinykeys"

export function useKeyboardShortcuts(
    activeFile: string | null,
    saveFile: (path: string) => Promise<boolean>
) {
    useEffect(() => {
        const controller = new AbortController()

        const saveActiveFile = async () => {
            if (activeFile) {
                await saveFile(activeFile)
            }
        }

        const preventAll = (e: KeyboardEvent) => {
            e.preventDefault()
        }

        const preventNotInput = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement
            if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
                e.preventDefault()
            }
        }

        const handleKeydown = createKeybindingsHandler({
            "$mod+KeyZ": preventNotInput,
            "$mod+Shift+KeyZ": preventNotInput,
            "$mod+KeyY": preventNotInput,
            "$mod+KeyS": (e: KeyboardEvent) => {
                e.preventDefault()
                saveActiveFile()
            },
            "$mod+KeyO": preventAll,
            "$mod+KeyF": preventAll,
            "$mod+KeyP": preventAll,
            Tab: preventNotInput
        })

        document.addEventListener("keydown", handleKeydown, controller)

        return () => {
            controller.abort()
        }
    }, [activeFile, saveFile])
}
