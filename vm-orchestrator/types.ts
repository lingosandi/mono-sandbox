export interface VMConfig {
    vmId: string
    projectId: string
    workspacePath: string
    overlayDiskPath?: string // Persistent overlay (OverlayFS + project files)
    memory: number // MB
    vcpuCount: number
    kernelPath: string
    rootfsPath: string
    snapshotPath?: string
}

export interface VMSession {
    vmId: string
    projectId: string
    pid: number
    socketPath: string
    workspacePath: string
    vmIP?: string
    createdAt: Date
    lastActivity: Date
    status: "starting" | "running" | "stopping" | "stopped"
}

export interface FirecrackerConfig {
    "boot-source": {
        kernel_image_path: string
        boot_args: string
        initrd_path?: string
    }
    drives: Array<{
        drive_id: string
        path_on_host: string
        is_root_device: boolean
        is_read_only: boolean
    }>
    "machine-config": {
        vcpu_count: number
        mem_size_mib: number
        smt: boolean
        track_dirty_pages?: boolean
    }
    "network-interfaces"?: Array<{
        iface_id: string
        guest_mac: string
        host_dev_name: string
    }>
    vsock?: {
        guest_cid: number
        uds_path: string
    }
}

export interface TerminalMessage {
    type: "input" | "output" | "resize" | "error" | "exit" | "connect"
    vmId?: string
    projectId?: string
    data?: string
    cols?: number
    rows?: number
    code?: number
}
