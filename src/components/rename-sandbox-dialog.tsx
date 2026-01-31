"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Project } from "@/types/project"

import { SandboxDialogShell, DIALOG_CONTENT_CLASS } from "@/components/sandbox-dialog-shell"

interface RenameSandboxDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    project: Project | null
    onRename: (name: string, description: string) => Promise<void>
    error?: string
}

export function RenameSandboxDialog({
    open,
    onOpenChange,
    project,
    onRename,
    error
}: RenameSandboxDialogProps) {
    const [name, setName] = useState("")
    const [description, setDescription] = useState("")
    const [isLoading, setIsLoading] = useState(false)

    useEffect(() => {
        if (project) {
            setName(project.name)
            setDescription(project.description || "")
        }
    }, [project])

    const handleRename = async () => {
        setIsLoading(true)
        try {
            await onRename(name, description)
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={DIALOG_CONTENT_CLASS}>
                <SandboxDialogShell
                    title={<>Rename <span className="text-gray-500 font-light">Sandbox</span></>}
                    description="Update the identity of your sandbox."
                    footer={
                        <>
                            <Button
                                variant="ghost"
                                className="text-gray-500 hover:text-white hover:bg-white/5 font-bold"
                                onClick={() => onOpenChange(false)}
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={handleRename}
                                disabled={isLoading || !name.trim()}
                                className="bg-white text-black hover:bg-white/90 font-black px-8 shadow-[0_0_20px_rgba(255,255,255,0.1)]"
                            >
                                {isLoading ? "Saving..." : "Save Changes"}
                            </Button>
                        </>
                    }
                >
                    <div className="space-y-2">
                        <Label htmlFor="rename-name" className="text-[10px] uppercase font-black tracking-[0.2em] text-gray-500">
                            Updated Name
                        </Label>
                        <Input
                            id="rename-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. quantum-compiler-v3"
                            className="bg-white/[0.03] border-white/10 focus:border-white/20 focus:ring-0 h-12 text-lg font-medium placeholder:text-gray-700 transition-all"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="rename-description" className="text-[10px] uppercase font-black tracking-[0.2em] text-gray-500">
                            Updated Description
                        </Label>
                        <Input
                            id="rename-description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Refresh project goals..."
                            className="bg-white/[0.03] border-white/10 focus:border-white/20 focus:ring-0 h-12 text-lg font-medium placeholder:text-gray-700 transition-all"
                        />
                    </div>
                    {error && (
                        <p className="text-sm font-bold text-red-500/80 bg-red-500/5 p-3 rounded border border-red-500/10 underline underline-offset-4 decoration-2">
                            {error}
                        </p>
                    )}
                </SandboxDialogShell>
            </DialogContent>
        </Dialog>
    )
}
