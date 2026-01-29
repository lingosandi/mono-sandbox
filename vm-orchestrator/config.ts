/**
 * VM Orchestrator Configuration
 */

import path from "path"

// ==========================================
// Firecracker Configuration
// ==========================================

/**
 * Enable Firecracker microVM isolation for terminal sessions.
 * - false: Use local bash shell (no isolation, for development)
 * - true: Use Firecracker VMs (full isolation, for production)
 *
 * WARNING: Setting to true requires:
 * 1. Firecracker installed and configured
 * 2. Kernel and rootfs images available
 * 3. Getty configured in rootfs to listen on vsock
 *
 * See README.md for setup instructions.
 */

// ==========================================
// Server Configuration
// ==========================================

export const VM_ORCHESTRATOR_PORT = parseInt(
    process.env.VM_ORCHESTRATOR_PORT || "3003"
)

// ==========================================
// Port Forwarding Configuration
// ==========================================

/**
 * Port range for VM port forwarding (Browser → Host Port → VM)
 * Each VM gets a unique port in this range for file server access
 *
 * WINDOWS COMPATIBILITY:
 * Windows dynamic port range: 1024-15000 (netsh int ipv4 show dynamicport tcp)
 * Safe range starts AFTER Windows ephemeral ports to avoid conflicts
 *
 * Default range: 15001-25000 (9,999 ports available)
 * This allows up to ~10,000 concurrent VMs while avoiding Windows port conflicts
 *
 * To increase range (if needed):
 * - Option 1: Extend to 15001-35000 (20,000 ports) for more VMs
 * - Option 2: Change Windows dynamic range: netsh int ipv4 set dynamicport tcp start=49152 num=16384
 *   (Sets Windows to IANA standard: 49152-65535, freeing 15001-49151 for VMs)
 */
export const PORT_FORWARD_MIN = parseInt(
    process.env.PORT_FORWARD_MIN || "15001"
)

export const PORT_FORWARD_MAX = parseInt(
    process.env.PORT_FORWARD_MAX || "25000"
)

// ==========================================
// Firecracker Paths
// ==========================================

export const FIRECRACKER_BIN =
    process.env.FIRECRACKER_BIN || "/usr/local/bin/firecracker"

export const FIRECRACKER_KERNEL =
    process.env.FIRECRACKER_KERNEL || "/opt/firecracker/kernel/vmlinux-6.12"

export const FIRECRACKER_ROOTFS =
    process.env.FIRECRACKER_ROOTFS || "/opt/firecracker/rootfs/ubuntu.ext4"

export const FIRECRACKER_PROJECTS_DIR =
    process.env.FIRECRACKER_PROJECTS_DIR || "/opt/firecracker/projects"

export const PROJECTS_BASE_DIR = path.join(process.cwd(), "projects")

// ==========================================
// Firecracker VM Defaults
// ==========================================

export const DEFAULT_VM_MEMORY_MB = 1024
export const DEFAULT_VM_VCPU_COUNT = 2

/**
 * Enable verbose boot logging to diagnose slow boot times
 * When enabled, captures detailed kernel and systemd boot logs to:
 * /tmp/vm-orchestrator/logs/{vmId}-console.log
 *
 * Adds verbose kernel parameters: loglevel=7, systemd.log_level=debug
 *
 * Set to false in production to reduce disk I/O and log file size
 */
export const ENABLE_VERBOSE_BOOT_LOGS = false

/**
 * Enable verbose startup timing logs for VM creation (disk, network, boot, etc.)
 * Set to true to diagnose slow VM startup steps.
 */
export const ENABLE_VERBOSE_STARTUP_LOGS = false

// ==========================================
// Network Configuration
// ==========================================

/**
 * Bridge network configuration for VM isolation
 * This network is created by setup-network.sh and used by all VMs
 *
 * IMPORTANT: If you change these values, you must also update:
 * - setup-network.sh (bridge creation, NAT rules, DNS forwarding)
 * - setup-rootfs.sh (static IP configuration in rootfs)
 */
export const BRIDGE_NAME = "br0"
export const BRIDGE_IP = "172.20.0.1"
export const BRIDGE_SUBNET = "172.20.0.0/24"
export const BRIDGE_IPV6 = "fd00:172:20::1"
export const BRIDGE_IPV6_SUBNET = "fd00:172:20::/64"

/**
 * VM IP allocation
 * VMs are assigned sequential IPs starting from .2 (bridge uses .1)
 * Maximum 253 VMs per bridge (172.20.0.2 - 172.20.0.254)
 */
export const VM_IP_START = 2 // First octet after bridge IP (.1)

// ==========================================
// Terminal Configuration
// ==========================================

/**
 * vsock port where getty listens in Firecracker VM
 * This must match the getty configuration in the VM rootfs
 */
export const VSOCK_TERMINAL_PORT = 1024
