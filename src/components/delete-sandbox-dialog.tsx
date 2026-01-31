"use client"

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Project } from "@/types/project"

import { SandboxDialogShell, DIALOG_CONTENT_CLASS } from "@/components/sandbox-dialog-shell"

interface DeleteSandboxDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    project: Project | null
    onConfirm: () => Promise<void>
}

export function DeleteSandboxDialog({
    open,
    onOpenChange,
    project,
    onConfirm
}: DeleteSandboxDialogProps) {
    if (!project) return null

    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent className={DIALOG_CONTENT_CLASS}>
                <SandboxDialogShell
                    isAlertDialog
                    title={<>{project.deletedAt ? "Purge" : "Delete"} <span className="text-gray-500 font-light">Sandbox</span></>}
                    description={
                        project.deletedAt 
                            ? "This action is irreversible. All associated disk images, configuration files, and snapshots will be permanently erased from the cluster."
                            : "You are about to decommission this sandbox. It will be moved to the archive and can be restored later or purged permanently."
                    }
                    footer={
                        <>
                            <AlertDialogCancel
                                className="bg-transparent border-none text-gray-500 hover:text-white hover:bg-white/5 font-bold transition-all"
                            >
                                Abort
                            </AlertDialogCancel>
                            <AlertDialogAction
                                onClick={onConfirm}
                                className="bg-white text-black hover:bg-white/90 font-black px-8 shadow-lg transition-all"
                            >
                                {project.deletedAt ? "Execute Purge" : "Confirm Deletion"}
                            </AlertDialogAction>
                        </>
                    }
                >
                    <div className="flex items-center gap-2 mb-2">
                        <span className="text-[10px] uppercase font-black tracking-[0.2em] text-gray-500">Target ID:</span>
                        <span className="text-[10px] font-mono text-gray-400 font-bold">{project.id}</span>
                    </div>
                </SandboxDialogShell>
            </AlertDialogContent>
        </AlertDialog>
    )
}
