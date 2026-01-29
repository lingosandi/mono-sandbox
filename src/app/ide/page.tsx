"use client"

import { useEffect, useState, useCallback } from "react"
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
import { Switch } from "@/components/ui/switch"
import { Download } from "lucide-react"
import { toast } from "sonner"

interface Project {
    id: string
    name: string
    description: string | null
    createdAt: string
    updatedAt: string
    deletedAt: string | null
}

interface VMStatus {
    running: boolean
    status: string
    vmId?: string
    vmIP?: string
}

export default function IDEPage() {
    const router = useRouter()
    const [projects, setProjects] = useState<Project[]>([])
    const [loading, setLoading] = useState(true)
    const [showDeleted, setShowDeleted] = useState(false)
    const [createDialogOpen, setCreateDialogOpen] = useState(false)
    const [renameDialogOpen, setRenameDialogOpen] = useState(false)
    const [selectedProject, setSelectedProject] = useState<Project | null>(null)
    const [projectName, setProjectName] = useState("")
    const [projectDescription, setProjectDescription] = useState("")
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

    async function handleCreateProject() {
        if (!projectName.trim()) {
            setError("Project name is required")
            return
        }

        const response = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: projectName,
                description: projectDescription
            })
        })

        if (response.ok) {
            setCreateDialogOpen(false)
            setProjectName("")
            setProjectDescription("")
            setError("")
            loadProjects()
        } else {
            const data = await response.json()
            setError(data.error || "Failed to create project")
        }
    }

    async function handleRenameProject() {
        if (!selectedProject || !projectName.trim()) {
            setError("Project name is required")
            return
        }

        const response = await fetch("/api/projects", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: selectedProject.id,
                name: projectName,
                description: projectDescription
            })
        })

        if (response.ok) {
            setRenameDialogOpen(false)
            setSelectedProject(null)
            setProjectName("")
            setProjectDescription("")
            setError("")
            loadProjects()
        } else {
            const data = await response.json()
            setError(data.error || "Failed to rename project")
        }
    }

    async function handleDeleteProject(projectId: string, isDeleted: boolean) {
        const message = isDeleted
            ? "This project is already deleted. Do you want to permanently delete it? This will remove all files and VM disk and CANNOT be undone."
            : "Are you sure you want to delete this project? You can restore it later by viewing deleted projects."

        if (!confirm(message)) {
            return
        }

        const response = await fetch(`/api/projects?id=${projectId}`, {
            method: "DELETE"
        })

        if (response.ok) {
            loadProjects()
        } else {
            alert("Failed to delete project")
        }
    }

    function openRenameDialog(project: Project) {
        setSelectedProject(project)
        setProjectName(project.name)
        setProjectDescription(project.description || "")
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
            a.download = `${projectName}-overlay.ext4`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            
            toast.success("Download started!")
        } catch (error) {
            console.error("Download failed:", error)
            toast.error("Failed to download overlay")
        }
    }

    return (
        <div className="min-h-screen bg-background p-8">
            <div className="max-w-7xl mx-auto">
                    <div className="flex justify-between items-center mb-8">
                        <div>
                            <h1 className="text-4xl font-bold">IDE</h1>
                            <p className="text-muted-foreground mt-2">
                                Manage your projects
                            </p>
                        </div>
                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2">
                                <Switch
                                    id="show-deleted"
                                    checked={showDeleted}
                                    onCheckedChange={setShowDeleted}
                                />
                                <Label
                                    htmlFor="show-deleted"
                                    className="cursor-pointer"
                                >
                                    Show deleted
                                </Label>
                            </div>
                            <Button
                                onClick={() => setCreateDialogOpen(true)}
                                size="lg"
                            >
                                Create New Project
                            </Button>
                        </div>
                    </div>

                    {loading ? (
                        <div className="text-center py-12">
                            Loading projects...
                        </div>
                    ) : projects.length === 0 ? (
                        <Card className="py-12">
                            <CardContent className="text-center">
                                <p className="text-muted-foreground mb-4">
                                    No projects yet
                                </p>
                                <Button
                                    onClick={() => setCreateDialogOpen(true)}
                                >
                                    Create Your First Project
                                </Button>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {projects.map((project) => {
                                const vmStatus = vmStatuses[project.id]
                                const isVMRunning = vmStatus?.running || false
                                const isToggling = togglingVM[project.id] || false
                                
                                return (
                                    <Card
                                        key={project.id}
                                        className={`hover:shadow-lg transition-shadow ${
                                            project.deletedAt
                                                ? "opacity-60 border-destructive"
                                                : ""
                                        }`}
                                    >
                                        <CardHeader
                                            className="cursor-pointer"
                                            onClick={() =>
                                                router.push(`/ide/${project.id}`)
                                            }
                                        >
                                            <CardTitle className="flex items-center gap-2">
                                                {project.name}
                                                {project.deletedAt && (
                                                    <span className="text-xs font-normal text-destructive">
                                                        (Deleted)
                                                    </span>
                                                )}
                                            </CardTitle>
                                            <CardDescription>
                                                {project.description ||
                                                    "No description"}
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent>
                                            {!project.deletedAt && (
                                                <div 
                                                    className="flex items-center justify-between py-2"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <Label
                                                            htmlFor={`vm-${project.id}`}
                                                            className="text-sm cursor-pointer"
                                                        >
                                                            VM {isVMRunning ? "Running" : "Stopped"}
                                                        </Label>
                                                        {isVMRunning && (
                                                            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                                                        )}
                                                    </div>
                                                    <Switch
                                                        id={`vm-${project.id}`}
                                                        checked={isVMRunning}
                                                        disabled={isToggling}
                                                        onCheckedChange={() => {
                                                            handleToggleVM(project.id, isVMRunning)
                                                        }}
                                                    />
                                                </div>
                                            )}
                                        </CardContent>
                                        <CardFooter className="flex justify-between gap-2">
                                            <div className="flex gap-2">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        openRenameDialog(project)
                                                    }}
                                                >
                                                    Rename
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        handleDownloadOverlay(project.id, project.name)
                                                    }}
                                                    title="Download overlay disk"
                                                >
                                                    <Download className="h-4 w-4" />
                                                </Button>
                                            </div>
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    handleDeleteProject(
                                                        project.id,
                                                        !!project.deletedAt
                                                    )
                                                }}
                                            >
                                                {project.deletedAt
                                                    ? "Delete Forever"
                                                    : "Delete"}
                                            </Button>
                                        </CardFooter>
                                    </Card>
                                )
                            })}
                        </div>
                    )}
                </div>

            {/* Create Project Dialog */}
            <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create New Project</DialogTitle>
                        <DialogDescription>
                            Create a new project. A main file will be
                            created automatically.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <Label htmlFor="name">Project Name</Label>
                            <Input
                                id="name"
                                value={projectName}
                                onChange={(e) => setProjectName(e.target.value)}
                                placeholder="My Project"
                            />
                        </div>
                        <div>
                            <Label htmlFor="description">
                                Description (optional)
                            </Label>
                            <Input
                                id="description"
                                value={projectDescription}
                                onChange={(e) =>
                                    setProjectDescription(e.target.value)
                                }
                                placeholder="A brief description of your project"
                            />
                        </div>
                        {error && (
                            <p className="text-sm text-destructive">{error}</p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setCreateDialogOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button onClick={handleCreateProject}>
                            Create Project
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Rename Project Dialog */}
            <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Rename Project</DialogTitle>
                        <DialogDescription>
                            Update the project name and description.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <Label htmlFor="rename-name">Project Name</Label>
                            <Input
                                id="rename-name"
                                value={projectName}
                                onChange={(e) => setProjectName(e.target.value)}
                                placeholder="My Project"
                            />
                        </div>
                        <div>
                            <Label htmlFor="rename-description">
                                Description (optional)
                            </Label>
                            <Input
                                id="rename-description"
                                value={projectDescription}
                                onChange={(e) =>
                                    setProjectDescription(e.target.value)
                                }
                                placeholder="A brief description of your project"
                            />
                        </div>
                        {error && (
                            <p className="text-sm text-destructive">{error}</p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setRenameDialogOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button onClick={handleRenameProject}>
                            Save Changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
