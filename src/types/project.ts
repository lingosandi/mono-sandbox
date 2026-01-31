export interface Project {
    id: string
    name: string
    description: string | null
    createdAt: string
    updatedAt: string
    deletedAt: string | null
}

export interface VMStatus {
    running: boolean
    status: string
    vmId?: string
    vmIP?: string
}
