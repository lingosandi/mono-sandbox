import dynamic from "next/dynamic"
import { FileCode2 } from "lucide-react"
import type { OpenFile } from "../hooks/useProjectFiles"
import { Terminal } from "./Terminal"
import { EditorTabs } from "./EditorTabs"
import { TERMINAL_MIN_WIDTH } from "@/config/constants"

const MonacoEditor = dynamic(
    () => import("@monaco-editor/react"),
    {
        ssr: false,
        loading: () => (
            <div className="flex items-center justify-center h-full">
                <span className="text-sm text-zinc-500">Loading editor...</span>
            </div>
        )
    }
)

interface EditorAreaProps {
    openFiles: OpenFile[]
    activeFile: string | null
    activeFileContent: OpenFile | undefined
    onSetActiveFile: (path: string) => void
    onCloseFile: (path: string) => void
    onUpdateContent: (path: string, content: string) => void
    projectId?: string
}

export function EditorArea({
    openFiles,
    activeFile,
    activeFileContent,
    onSetActiveFile,
    onCloseFile,
    onUpdateContent,
    projectId
}: EditorAreaProps) {
    return (
        <div
            className="flex-1 flex flex-col bg-[#09090b]"
            style={{ minWidth: `${TERMINAL_MIN_WIDTH}px` }}
        >
            <EditorTabs
                openFiles={openFiles}
                activeFile={activeFile}
                onSetActiveFile={onSetActiveFile}
                onCloseFile={onCloseFile}
            />

            {/* Editor Content */}
            <div className="flex-1 relative">
                {activeFile === "agent" ? (
                    <Terminal projectId={projectId} />
                ) : activeFileContent ? (
                    <MonacoEditor
                        height="100%"
                        theme="vs-dark"
                        language="typescript"
                        value={activeFileContent.content}
                        onChange={(value) =>
                            onUpdateContent(activeFile!, value || "")
                        }
                        options={{
                            minimap: { enabled: false },
                            wordWrap: "on"
                        }}
                        beforeMount={(monaco) => {
                            monaco.editor.defineTheme("custom-dark", {
                                base: "vs-dark",
                                inherit: true,
                                rules: [],
                                colors: {
                                    "editor.background": "#0f0f11"
                                }
                            })
                        }}
                        onMount={(editor, monaco) => {
                            monaco.editor.setTheme("custom-dark")
                        }}
                        className="pt-2"
                    />
                ) : (
                    <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-4">
                        <div className="h-16 w-16 rounded-2xl bg-white/5 flex items-center justify-center">
                            <FileCode2 className="h-8 w-8 opacity-50" />
                        </div>
                        <p>Select a file to start editing</p>
                    </div>
                )}
            </div>
        </div>
    )
}
