import { FileCode2, Terminal as TerminalIcon } from "lucide-react"
import type { OpenFile } from "../hooks/useProjectFiles"
import { Tab } from "./Tab"

interface EditorTabsProps {
    openFiles: OpenFile[]
    activeFile: string | null
    onSetActiveFile: (path: string) => void
    onCloseFile: (path: string) => void
}

export function EditorTabs({
    openFiles,
    activeFile,
    onSetActiveFile,
    onCloseFile
}: EditorTabsProps) {
    return (
        <div className="h-10 border-b border-white/5 flex items-center justify-between px-4 bg-transparent">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar mask-gradient-r flex-1 mr-4">
                {/* Non-removable terminal Tab */}
                <Tab
                    label="Terminal"
                    icon={TerminalIcon}
                    isActive={activeFile === "terminal"}
                    onClick={() => onSetActiveFile("terminal")}
                />

                {openFiles.map((file) => (
                    <Tab
                        key={file.path}
                        label={file.path.split("/").pop() || ""}
                        icon={FileCode2}
                        isActive={activeFile === file.path}
                        onClick={() => onSetActiveFile(file.path)}
                        closable
                        onClose={() => onCloseFile(file.path)}
                        isDirty={file.isDirty}
                    />
                ))}
            </div>
        </div>
    )
}
