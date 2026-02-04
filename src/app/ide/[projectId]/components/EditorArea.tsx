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
    resizeTrigger?: boolean
}

export function EditorArea({
    openFiles,
    activeFile,
    activeFileContent,
    onSetActiveFile,
    onCloseFile,
    onUpdateContent,
    projectId,
    resizeTrigger
}: EditorAreaProps) {
    return (
        <div
            className="flex-1 flex flex-col"
            style={{ minWidth: `${TERMINAL_MIN_WIDTH}px`, backgroundColor: "#0f0f11" }}
        >
            <EditorTabs
                openFiles={openFiles}
                activeFile={activeFile}
                onSetActiveFile={onSetActiveFile}
                onCloseFile={onCloseFile}
            />

            {/* Editor Content */}
            <div className="flex-1 relative bg-black/20">
                {/* Keep terminal mounted but hidden when not active */}
                <div className={activeFile === "terminal" ? "h-full" : "hidden"}>
                    <Terminal projectId={projectId} resizeTrigger={resizeTrigger} />
                </div>
                
                {activeFile !== "terminal" && activeFileContent ? (
                    <MonacoEditor
                        height="100%"
                        theme="vs-dark"
                        language="typescript"
                        value={activeFileContent.content}
                        onChange={(value) =>
                            onUpdateContent(activeFile!, value || "")
                        }
                        options={{
                            wordWrap: "on"
                        }}
                        beforeMount={(monaco) => {
                            monaco.editor.defineTheme("custom-dark", {
                                base: "vs-dark",
                                inherit: true,
                                rules: [],
                                colors: {
                                    "editor.background": "#0c0c0e"
                                }
                            })
                        }}
                        onMount={(editor, monaco) => {
                            monaco.editor.setTheme("custom-dark")
                        }}
                        className="pt-2"
                    />
                ) : activeFile !== "terminal" && !activeFileContent ? (
                    <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-4">
                        <div className="h-16 w-16 rounded-2xl bg-white/5 flex items-center justify-center">
                            <FileCode2 className="h-8 w-8 opacity-50" />
                        </div>
                        <p>Select a file to start editing</p>
                    </div>
                ) : null}
            </div>
        </div>
    )
}
