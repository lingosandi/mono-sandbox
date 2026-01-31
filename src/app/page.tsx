"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
    Card,
    CardContent
} from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Upload } from "lucide-react"
import { toast } from "sonner"
import { ProjectCard } from "@/components/project-card"
import { CreateSandboxDialog } from "@/components/create-sandbox-dialog"
import { RenameSandboxDialog } from "@/components/rename-sandbox-dialog"
import { DeleteSandboxDialog } from "@/components/delete-sandbox-dialog"
import { Project, VMStatus } from "@/types/project"

export default function Home() {
    const [projects, setProjects] = useState<Project[]>([])
    const [loading, setLoading] = useState(true)
    const [showDeleted, setShowDeleted] = useState(false)
    const [createDialogOpen, setCreateDialogOpen] = useState(false)
    const [renameDialogOpen, setRenameDialogOpen] = useState(false)
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
    const [selectedProject, setSelectedProject] = useState<Project | null>(null)
    const [error, setError] = useState("")
    const [vmStatuses, setVMStatuses] = useState<Record<string, VMStatus>>({})
    const [togglingVM, setTogglingVM] = useState<Record<string, boolean>>({})

    const fetchAllVMStatuses = useCallback(
        async (
            projectList: Project[],
            signal?: AbortSignal,
            cleanupFlag?: boolean
        ) => {
            
            const statuses: Record<string, VMStatus> = {}
            
            await Promise.all(
                projectList
                    .filter(p => !p.deletedAt) // Only check non-deleted projects
                    .map(async (project) => {
                        try {
                            const response = await fetch("http://localhost:3003/api/vm/status", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    projectId: project.id
                                }),
                                signal
                            })
                            
                            if (response.ok) {
                                statuses[project.id] = await response.json()
                            }
                        } catch (error) {
                            if (error instanceof Error && error.name === 'AbortError') {
                                // Request was aborted - expected on unmount
                                return
                            }
                            console.error(`Failed to fetch VM status for ${project.id}:`, error)
                        }
                    })
            )
            
            // Only update state if component is still mounted
            if (!cleanupFlag) {
                setVMStatuses(statuses)
            }
        },
        []
    )

    useEffect(() => {
        let isCleanedUp = false
        const abortController = new AbortController()

        async function fetchProjects() {
            setLoading(true)
            const url = `/api/projects${
                showDeleted ? "?includeDeleted=true" : ""
            }`
            
            try {
                const response = await fetch(url, {
                    signal: abortController.signal
                })

                // Check if component unmounted during fetch
                if (isCleanedUp) return

                if (response.ok) {
                    const data = await response.json()

                    // Check again after async operation
                    if (isCleanedUp) return

                    setProjects(data.projects)
                    
                    // Fetch VM status for all projects
                    await fetchAllVMStatuses(data.projects, abortController.signal, isCleanedUp)
                }
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    // Request was aborted - this is expected on unmount
                    return
                }
                console.error('Failed to fetch projects:', error)
            } finally {
                if (!isCleanedUp) {
                    setLoading(false)
                }
            }
        }
        fetchProjects()

        return () => {
            isCleanedUp = true
            abortController.abort()
        }
    }, [showDeleted, fetchAllVMStatuses])

    async function handleToggleVM(projectId: string, currentlyRunning: boolean) {
        
        // Prevent double-toggle
        if (togglingVM[projectId]) return
        
        setTogglingVM(prev => ({ ...prev, [projectId]: true }))
        
        try {
            const endpoint = currentlyRunning ? "/api/vm/stop" : "/api/vm/start"
            
            const response = await fetch(`http://localhost:3003${endpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    projectId
                }),
                signal: AbortSignal.timeout(30000) // 30s timeout
            })
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}))
                throw new Error(errorData.error || `Failed to ${currentlyRunning ? "stop" : "start"} VM`)
            }
            
            // Refresh VM status for this project
            const statusResponse = await fetch("http://localhost:3003/api/vm/status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    projectId
                }),
                signal: AbortSignal.timeout(10000) // 10s timeout
            })
            
            if (statusResponse.ok) {
                const newStatus = await statusResponse.json()
                setVMStatuses(prev => ({ ...prev, [projectId]: newStatus }))
            }
        } catch (error) {
            console.error("Failed to toggle VM:", error)
            
            // Provide user-friendly error messages
            let errorMessage = "Unknown error"
            if (error instanceof Error) {
                if (error.name === 'TimeoutError') {
                    errorMessage = "Request timed out. The VM might still be starting/stopping."
                } else if (error.name === 'AbortError') {
                    errorMessage = "Request was cancelled"
                } else {
                    errorMessage = error.message
                }
            }
            
            alert(`Failed to ${currentlyRunning ? "stop" : "start"} VM: ${errorMessage}`)
            
            // Refresh status to ensure UI reflects actual state
            try {
                const statusResponse = await fetch("http://localhost:3003/api/vm/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    signal: AbortSignal.timeout(10000) // 10s timeout
                })
                if (statusResponse.ok) {
                    const currentStatus = await statusResponse.json()
                    setVMStatuses(prev => ({ ...prev, [projectId]: currentStatus }))
                }
            } catch {}
        } finally {
            setTogglingVM(prev => ({ ...prev, [projectId]: false }))
        }
    }

    async function loadProjects() {
        setLoading(true)
        const url = `/api/projects${showDeleted ? "?includeDeleted=true" : ""}`
        
        try {
            const response = await fetch(url)

            if (response.ok) {
                const data = await response.json()
                setProjects(data.projects)
                await fetchAllVMStatuses(data.projects)
            }
        } catch (error) {
            console.error('Failed to load projects:', error)
        } finally {
            setLoading(false)
        }
    }

    async function handleCreateProject(name: string, description: string) {
        if (!name.trim()) {
            setError("Project name is required")
            return
        }

        const response = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: name,
                description: description
            })
        })

        if (response.ok) {
            setCreateDialogOpen(false)
            setError("")
            loadProjects()
        } else {
            const data = await response.json()
            setError(data.error || "Failed to create project")
        }
    }

    async function handleRenameProject(name: string, description: string) {
        if (!selectedProject || !name.trim()) {
            setError("Project name is required")
            return
        }

        const response = await fetch("/api/projects", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: selectedProject.id,
                name: name,
                description: description
            })
        })

        if (response.ok) {
            setRenameDialogOpen(false)
            setSelectedProject(null)
            setError("")
            loadProjects()
        } else {
            const data = await response.json()
            setError(data.error || "Failed to rename project")
        }
    }

    async function handleDeleteProject(projectId: string, isDeleted: boolean) {
        const project = projects.find(p => p.id === projectId)
        if (!project) return
        
        setSelectedProject(project)
        setDeleteDialogOpen(true)
    }

    async function handleConfirmDelete() {
        if (!selectedProject) return

        const response = await fetch(`/api/projects?id=${selectedProject.id}`, {
            method: "DELETE"
        })

        if (response.ok) {
            setDeleteDialogOpen(false)
            setSelectedProject(null)
            loadProjects()
        } else {
            toast.error("Failed to delete project")
        }
    }

    function openRenameDialog(project: Project) {
        setSelectedProject(project)
        setError("")
        setRenameDialogOpen(true)
    }

    async function handleDownloadOverlay(projectId: string, projectName: string) {
        try {
            // First check if the overlay exists
            const response = await fetch(`/api/projects/${projectId}/download`, {
                method: "HEAD"
            })
            
            if (!response.ok) {
                if (response.status === 404) {
                    toast.error("Overlay disk not found. Start the VM first to create the overlay.", {
                        duration: 5000
                    })
                } else {
                    toast.error("Failed to download overlay")
                }
                return
            }

            // Create direct download link (let browser handle streaming)
            const a = document.createElement("a")
            a.href = `/api/projects/${projectId}/download`
            a.download = `${projectName}-overlay.ext4.tar.gz`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            
            toast.success("Download started!")
        } catch (error) {
            console.error("Download failed:", error)
            toast.error("Failed to download overlay")
        }
    }

    async function handleUploadOverlay() {
        const input = document.createElement("input")
        input.type = "file"
        input.accept = ".tar.gz,.tgz"
        
        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0]
            if (!file) return
            
            try {
                // Validate file size before upload (max 10GB)
                const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024
                if (file.size > MAX_FILE_SIZE) {
                    toast.error(`File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB`)
                    return
                }
                
                // Warn about very large files
                if (file.size > 1024 * 1024 * 1024) { // > 1GB
                    toast.info(`Uploading large file (${(file.size / (1024 * 1024 * 1024)).toFixed(2)}GB). This may take several minutes...`, {
                        duration: 10000
                    })
                } else {
                    toast.info("Uploading overlay disk...")
                }
                
                const formData = new FormData()
                formData.append("file", file)
                
                const response = await fetch("/api/projects/upload", {
                    method: "POST",
                    body: formData
                })
                
                if (!response.ok) {
                    const error = await response.json()
                    throw new Error(error.error || "Upload failed")
                }
                
                const data = await response.json()
                toast.success(`Project created: ${data.project.name}`)
                
                // Reload projects
                loadProjects()
            } catch (error) {
                console.error("Upload failed:", error)
                toast.error(error instanceof Error ? error.message : "Failed to upload overlay")
            }
        }
        
        input.click()
    }

    return (
        <div className="min-h-screen hex-background text-white p-8 selection:bg-white/10 overflow-x-hidden">
            <div className="ambient-glow top-0 left-[-10%] opacity-40" />
            <div className="ambient-glow bottom-0 right-[-10%] opacity-30 animation-delay-2000" />
            
            <div className="max-w-7xl mx-auto relative z-20">
                    <div className="flex justify-between items-center mb-16">
                        <div>
                            <h1 className="text-4xl tracking-tighter">
                                <span className="font-light opacity-50">Mono</span>
                                <span className="font-black">Sandbox</span>
                            </h1>
                        </div>
                        <div className="flex items-center gap-6">
                            <div className="flex items-center gap-3 bg-white/[0.03] px-4 py-2 rounded-full border border-white/[0.08] backdrop-blur-md">
                                <Switch
                                    id="show-deleted"
                                    checked={showDeleted}
                                    onCheckedChange={setShowDeleted}
                                />
                                <Label
                                    htmlFor="show-deleted"
                                    className="cursor-pointer text-xs font-bold uppercase tracking-widest text-gray-500"
                                >
                                    Deleted
                                </Label>
                            </div>
                            <Button
                                onClick={handleUploadOverlay}
                                size="lg"
                                variant="outline"
                                className="bg-white/[0.03] hover:bg-white/[0.08] text-white border-white/[0.08] backdrop-blur-md transition-all"
                            >
                                <Upload className="h-4 w-4 mr-2" />
                                Upload
                            </Button>
                            <Button
                                onClick={() => setCreateDialogOpen(true)}
                                size="lg"
                                className="bg-white text-black hover:bg-white/90 font-black px-6 border-none shadow-[0_0_30px_rgba(255,255,255,0.15)] transition-all"
                            >
                                Create Sandbox
                            </Button>
                        </div>
                    </div>

                    {loading ? (
                        <div className="text-center py-24 text-gray-400 text-lg animate-pulse">
                            Loading projects...
                        </div>
                    ) : projects.length === 0 ? (
                        <Card className="py-24 glass-card border-2 border-white/10">
                            <CardContent className="text-center">
                                <p className="text-gray-400 text-lg mb-6">
                                    No sandbox found
                                </p>
                                <Button
                                    onClick={() => setCreateDialogOpen(true)}
                                    className="bg-green-600 hover:bg-green-700 text-white font-bold px-8 py-6"
                                >
                                    Create Your First Sandbox
                                </Button>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {projects.map((project) => (
                                <ProjectCard
                                    key={project.id}
                                    project={project}
                                    vmStatus={vmStatuses[project.id]}
                                    isToggling={togglingVM[project.id] || false}
                                    onToggleVM={handleToggleVM}
                                    onRename={openRenameDialog}
                                    onDownload={handleDownloadOverlay}
                                    onDelete={handleDeleteProject}
                                />
                            ))}
                        </div>
                    )}
                </div>

            <CreateSandboxDialog
                open={createDialogOpen}
                onOpenChange={setCreateDialogOpen}
                onCreate={handleCreateProject}
                error={error}
            />

            <RenameSandboxDialog
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
                project={selectedProject}
                onRename={handleRenameProject}
                error={error}
            />

            <DeleteSandboxDialog
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
                project={selectedProject}
                onConfirm={handleConfirmDelete}
            />
        </div>
    )
}
