import { VMConfig, FirecrackerConfig } from "./types"
import path from "path"
import os from "os"
import { generateMACAddress } from "./network-manager"
import {
    DEFAULT_VM_MEMORY_MB,
    DEFAULT_VM_VCPU_COUNT,
    ENABLE_VERBOSE_BOOT_LOGS,
    BRIDGE_IP,
} from "./config"

const FIRECRACKER_BASE = process.env.FIRECRACKER_BASE || "/opt/firecracker"
const KERNEL_PATH = path.join(FIRECRACKER_BASE, "kernel", "vmlinux-6.12")
const ROOTFS_PATH = path.join(FIRECRACKER_BASE, "rootfs", "ubuntu.ext4")
const INITRAMFS_PATH = path.join(FIRECRACKER_BASE, "rootfs", "initramfs.img")

// Use temp directory for development, /var for production
const IS_DEV_MODE = !process.env.FIRECRACKER_PRODUCTION
const SOCKET_DIR = IS_DEV_MODE
    ? path.join(os.tmpdir(), "vm-orchestrator", "sockets")
    : "/var/run/firecracker"
const LOG_DIR = IS_DEV_MODE
    ? path.join(os.tmpdir(), "vm-orchestrator", "logs")
    : "/var/log/firecracker"

export function generateFirecrackerConfig(
    config: VMConfig,
    networkConfig?: { tapName: string; vmIP: string }
): FirecrackerConfig {
    const vsockPath = path.join(SOCKET_DIR, `${config.vmId}.vsock`)

    // Extract numeric timestamp from vmId (format: vm-{timestamp}-{random})
    // Use timestamp modulo to get a valid guest_cid (3-1000000)
    const timestamp = config.vmId.split("-")[1] || "1000"
    const guest_cid = (parseInt(timestamp, 10) % 1000000) + 3

    // Build IP configuration string if network is provided
    // Format: ip=<client-ip>::<gateway>:<netmask>::<interface>:off
    // Example: ip=172.20.0.3::172.20.0.1:255.255.255.0::eth0:off
    const ipConfig = networkConfig
        ? ` ip=${networkConfig.vmIP}::${BRIDGE_IP}:255.255.255.0::eth0:off`
        : ""

    // Use verbose boot logging if enabled, otherwise use minimal logs
    // Note: root=/dev/vda is temporary - initramfs will pivot to overlay
    const bootArgs = ENABLE_VERBOSE_BOOT_LOGS
        ? `console=ttyS0 loglevel=7 systemd.log_level=debug systemd.log_target=console systemd.show_status=true reboot=k panic=1 pci=off noapic${ipConfig}`
        : `console=ttyS0 reboot=k panic=1 pci=off noapic${ipConfig}`

    return {
        "boot-source": {
            kernel_image_path: config.kernelPath || KERNEL_PATH,
            boot_args: bootArgs,
            initrd_path: INITRAMFS_PATH // Initramfs sets up full-root overlay
        },
        drives: [
            {
                drive_id: "rootfs",
                path_on_host: config.rootfsPath || ROOTFS_PATH,
                is_root_device: true,
                is_read_only: true // Read-only base for multi-tenant isolation
            },
            ...(config.overlayDiskPath
                ? [
                      {
                          drive_id: "overlay",
                          path_on_host: config.overlayDiskPath,
                          is_root_device: false,
                          is_read_only: false // Persistent overlay (OverlayFS + project files)
                      }
                  ]
                : [])
        ],
        "machine-config": {
            vcpu_count: config.vcpuCount || DEFAULT_VM_VCPU_COUNT,
            mem_size_mib: config.memory || DEFAULT_VM_MEMORY_MB,
            smt: false,
            track_dirty_pages: false
        },
        ...(networkConfig
            ? {
                  "network-interfaces": [
                      {
                          iface_id: "eth0",
                          guest_mac: generateMACAddress(config.vmId),
                          host_dev_name: networkConfig.tapName
                      }
                  ]
              }
            : {}),
        vsock: {
            guest_cid: guest_cid,
            uds_path: vsockPath
        }
    }
}

export function getSocketPath(vmId: string): string {
    return path.join(SOCKET_DIR, `${vmId}.sock`)
}

export function getVsockPath(vmId: string): string {
    return path.join(SOCKET_DIR, `${vmId}.vsock`)
}

export function getLogPath(vmId: string): string {
    return path.join(LOG_DIR, `${vmId}.log`)
}

export function getMetricsPath(vmId: string): string {
    return path.join(LOG_DIR, `${vmId}-metrics.log`)
}

export function getConsoleLogPath(vmId: string): string {
    return path.join(LOG_DIR, `${vmId}-console.log`)
}

export function getSocketDir(): string {
    return SOCKET_DIR
}

export function getLogDir(): string {
    return LOG_DIR
}
