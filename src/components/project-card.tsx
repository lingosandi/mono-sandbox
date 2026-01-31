"use client"

import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Download } from "lucide-react"

import { Project, VMStatus } from "@/types/project"

interface ProjectCardProps {
    project: Project
    vmStatus?: VMStatus
    isToggling: boolean
    onToggleVM: (projectId: string, isRunning: boolean) => void
    onRename: (project: Project) => void
    onDownload: (projectId: string, projectName: string) => void
    onDelete: (projectId: string, isDeleted: boolean) => void
}

export function ProjectCard({
    project,
    vmStatus,
    isToggling,
    onToggleVM,
    onRename,
    onDownload,
    onDelete
}: ProjectCardProps) {
    const router = useRouter()
    const isVMRunning = vmStatus?.running || false

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        e.currentTarget.style.setProperty("--mouse-x", `${x}px`)
        e.currentTarget.style.setProperty("--mouse-y", `${y}px`)
    }

    return (
        <Card
            onMouseMove={handleMouseMove}
            className={`transition-all duration-500 spotlight-card glass-card border-2 ${
                project.deletedAt
                    ? "border-red-500/20 card-glow-red"
                    : isVMRunning
                    ? "border-green-500/30 card-glow-green"
                    : "border-white/5"
            } hover:border-white/20 group`}
        >
            <CardHeader
                className="cursor-pointer pb-2"
                onClick={() => !project.deletedAt && router.push(`/ide/${project.id}`)}
            >
                <div className="flex justify-between items-start mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 font-mono">
                        ID: {project.id.slice(0, 8)}
                    </span>
                    {project.deletedAt && (
                        <div className="bg-red-500/10 text-red-500 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border border-red-500/20">
                            Archived
                        </div>
                    )}
                </div>
                <CardTitle className="text-2xl font-black tracking-tight group-hover:text-white transition-colors">
                    {project.name}
                </CardTitle>
                <CardDescription className="text-gray-500 font-medium leading-relaxed line-clamp-2">
                    {project.description || "No project description provided."}
                </CardDescription>
            </CardHeader>
            <CardContent className="pb-4">
                <div 
                    className="flex items-center justify-between bg-black/20 p-3 rounded-lg border border-white/5"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${isVMRunning ? "bg-green-500 shadow-[0_0_12px_rgba(34,197,94,0.8)]" : "bg-gray-700"}`} />
                        <span className={`text-[11px] font-bold font-mono tracking-wider ${isVMRunning ? "text-green-400" : "text-gray-500"}`}>
                            {isVMRunning ? "VM_STATUS: ACTIVE" : "VM_STATUS: OFFLINE"}
                        </span>
                    </div>
                    <Switch
                        id={`vm-${project.id}`}
                        checked={isVMRunning}
                        disabled={isToggling || !!project.deletedAt}
                        onCheckedChange={() => onToggleVM(project.id, isVMRunning)}
                    />
                </div>
            </CardContent>
            <CardFooter className="flex justify-between gap-2 pt-2 border-t border-white/5">
                <div className="flex gap-1">
                    <Button
                        variant="secondary"
                        size="sm"
                        className="bg-transparent hover:bg-white/5 text-gray-400 hover:text-white border-none transition-all px-2"
                        onClick={(e) => {
                            e.stopPropagation()
                            onRename(project)
                        }}
                    >
                        Rename
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        className="bg-transparent hover:bg-white/5 text-gray-400 hover:text-white border-none transition-all px-2"
                        onClick={(e) => {
                            e.stopPropagation()
                            onDownload(project.id, project.name)
                        }}
                    >
                        <Download className="h-3.5 w-3.5" />
                    </Button>
                </div>
                <Button
                    variant="default"
                    size="sm"
                    className="font-bold transition-all bg-white/[0.03] hover:bg-white text-gray-400 hover:text-black border border-white/5 h-8 px-4"
                    onClick={(e) => {
                        e.stopPropagation()
                        onDelete(project.id, !!project.deletedAt)
                    }}
                >
                    {project.deletedAt ? "Purge" : "Delete"}
                </Button>
            </CardFooter>
        </Card>
    )
}
