"use client"

import { useState } from "react"
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

import { SandboxDialogShell, DIALOG_CONTENT_CLASS } from "@/components/sandbox-dialog-shell"

interface CreateSandboxDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCreate: (name: string, description: string) => Promise<void>
    error?: string
}

export function CreateSandboxDialog({
    open,
    onOpenChange,
    onCreate,
    error
}: CreateSandboxDialogProps) {
    const [name, setName] = useState("")
    const [description, setDescription] = useState("")
    const [isLoading, setIsLoading] = useState(false)

    const handleCreate = async () => {
        setIsLoading(true)
        try {
            await onCreate(name, description)
            setName("")
            setDescription("")
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={DIALOG_CONTENT_CLASS}>
                <SandboxDialogShell
                    title={<>Create <span className="text-gray-500 font-light">Sandbox</span></>}
                    description="Initialize a new sandbox. A default workspace will be set up automatically."
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
                                onClick={handleCreate}
                                disabled={isLoading || !name.trim()}
                                className="bg-white text-black hover:bg-white/90 font-black px-8 shadow-[0_0_20px_rgba(255,255,255,0.1)]"
                            >
                                {isLoading ? "Initializing..." : "Initialize"}
                            </Button>
                        </>
                    }
                >
                    <div className="space-y-2">
                        <Label htmlFor="create-name" className="text-[10px] uppercase font-black tracking-[0.2em] text-gray-500">
                            Project Name
                        </Label>
                        <Input
                            id="create-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. quantum-compiler-v2"
                            className="bg-white/[0.03] border-white/10 focus:border-white/20 focus:ring-0 h-12 text-lg font-medium placeholder:text-gray-700 transition-all"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="create-description" className="text-[10px] uppercase font-black tracking-[0.2em] text-gray-500">
                            Description <span className="opacity-50">(Optional)</span>
                        </Label>
                        <Input
                            id="create-description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Briefly describe the purpose..."
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
