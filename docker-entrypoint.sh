#!/bin/bash
set -euo pipefail

echo "=== Firecracker VM Orchestrator Container Startup ==="

# Unmount helper function
safe_umount() {
    local target="$1"
    umount "$target" 2>/dev/null || umount -l "$target" 2>/dev/null || true
}

# Cleanup function for atomic operations
cleanup_on_error() {
    echo "ERROR: Startup failed, cleaning up..."
    # Unmount any stale mounts
        safe_umount /tmp/rootfs-build/var/cache/apt/archives
        safe_umount /tmp/rootfs-build
        rm -rf /tmp/rootfs-build 2>/dev/null || true
    # Remove incomplete rootfs
    if [ -f /opt/firecracker/rootfs/ubuntu.ext4.tmp ]; then
        echo "→ Removing incomplete rootfs..."
        rm -f /opt/firecracker/rootfs/ubuntu.ext4.tmp
    fi
    # Release flock
    rm -f /tmp/rootfs-setup.lock
}

trap cleanup_on_error ERR

# Load KVM module (may fail if already loaded, that's OK)
modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || echo "KVM module already loaded or not available"

# Verify KVM is accessible
if [ ! -c /dev/kvm ]; then
    echo "ERROR: /dev/kvm not found. Make sure Docker is running with --device /dev/kvm"
    exit 1
fi

echo "✓ KVM device accessible: $(ls -l /dev/kvm)"

# Create rootfs on first run if it doesn't exist
if [ ! -f /opt/firecracker/rootfs/ubuntu.ext4 ]; then
    echo "=== Creating Ubuntu rootfs (first run, ~5-10 minutes) ==="
    
    # CRITICAL: Acquire exclusive lock to prevent parallel execution
    exec 200>/tmp/rootfs-setup.lock
    if ! flock -n 200; then
        echo "ERROR: Another rootfs setup is already running. Waiting..."
        flock 200
    fi
    
    # Double-check after acquiring lock (another container may have created it)
    if [ -f /opt/firecracker/rootfs/ubuntu.ext4 ]; then
        echo "✓ Rootfs created by another process: $(ls -lh /opt/firecracker/rootfs/ubuntu.ext4)"
        flock -u 200
        exec 200>&-  # Close file descriptor
        # Skip to verification section
    else
        # CRITICAL: Check available disk space (need 5GB+ for safety)
        AVAILABLE_GB=$(df -BG /opt/firecracker | tail -1 | awk '{print $4}' | sed 's/G//')
        if [ "$AVAILABLE_GB" -lt 5 ]; then
            echo "ERROR: Insufficient disk space. Need 5GB+, have ${AVAILABLE_GB}GB"
            flock -u 200
            exit 1
        fi
        echo "✓ Disk space check passed: ${AVAILABLE_GB}GB available"
        
        # ATOMIC: Create rootfs with .tmp suffix, rename only on success
        ROOTFS_TEMP="/opt/firecracker/rootfs/ubuntu.ext4.tmp"
        ROOTFS_FINAL="/opt/firecracker/rootfs/ubuntu.ext4"
        
        echo "→ Creating 4GB ext4 image..."
        fallocate -l 4G "$ROOTFS_TEMP"
        mkfs.ext4 -F "$ROOTFS_TEMP"
        
        # Mount and install Ubuntu base
        echo "→ Mounting rootfs..."
        mkdir -p /tmp/rootfs-build
        if ! mount -o loop "$ROOTFS_TEMP" /tmp/rootfs-build; then
            echo "ERROR: Failed to mount rootfs"
            rm -rf /tmp/rootfs-build
            rm -f "$ROOTFS_TEMP"
            flock -u 200
            exit 1
        fi

        mkdir -p /tmp/rootfs-build/var/cache/apt/archives
        mkdir -p /opt/firecracker/cache/debootstrap-apt
        mount --bind /opt/firecracker/cache/debootstrap-apt /tmp/rootfs-build/var/cache/apt/archives
        
        # CRITICAL: Run debootstrap with timeout (30 min max per attempt)
        # Use a persistent cache directory to avoid re-downloading packages on failure
        DEBOOTSTRAP_CACHE_DIR="/opt/firecracker/cache/debootstrap"
        mkdir -p "$DEBOOTSTRAP_CACHE_DIR"
        echo "=========================================="
        echo "Installing Ubuntu base system with debootstrap"
        echo "This will take 5-10 minutes (timeout: 30 minutes)"
        echo "=========================================="
        echo ""
        if ! timeout 1800 debootstrap --verbose --arch=amd64 --cache-dir="$DEBOOTSTRAP_CACHE_DIR" jammy /tmp/rootfs-build http://archive.ubuntu.com/ubuntu/; then
            echo ""
            echo "ERROR: Debootstrap failed"
            safe_umount /tmp/rootfs-build/var/cache/apt/archives
            safe_umount /tmp/rootfs-build
            rm -rf /tmp/rootfs-build
            rm -f "$ROOTFS_TEMP"
            flock -u 200
            exit 1
        fi
        
        sync
        safe_umount /tmp/rootfs-build/var/cache/apt/archives
        safe_umount /tmp/rootfs-build
        rm -rf /tmp/rootfs-build
        
        echo ""
        echo "✓ Base rootfs created: $(ls -lh $ROOTFS_TEMP)"
        echo ""
        
        # Customize rootfs (setup scripts operate on temp file)
        echo "=========================================="
        echo "Customizing rootfs with dev tools"
        echo "This will take 3-5 minutes"
        echo "=========================================="
        echo ""
        
        # CRITICAL: Pass temp rootfs path to setup scripts, rollback on failure
        echo "[1/4] Setting up Python and base tools..."
        if ! bash /app/setup-rootfs.sh "$ROOTFS_TEMP"; then
            echo "ERROR: setup-rootfs.sh failed"
            rm -f "$ROOTFS_TEMP"
            flock -u 200
            exit 1
        fi
        
        echo "[2/4] Installing Node.js packages..."
        if ! bash /app/setup-npm.sh "$ROOTFS_TEMP"; then
            echo "ERROR: setup-npm.sh failed"
            rm -f "$ROOTFS_TEMP"
            flock -u 200
            exit 1
        fi
        
        echo "[3/4] Installing Python packages..."
        if ! bash /app/setup-pip.sh "$ROOTFS_TEMP"; then
            echo "ERROR: setup-pip.sh failed"
            rm -f "$ROOTFS_TEMP"
            flock -u 200
            exit 1
        fi
        
        echo "[4/4] Setting up messaging infrastructure..."
        if ! bash /app/setup-messaging.sh "$ROOTFS_TEMP"; then
            echo "ERROR: setup-messaging.sh failed"
            rm -f "$ROOTFS_TEMP"
            flock -u 200
            exit 1
        fi
        
        # Create initramfs with full-root overlay support
        echo ""
        echo "=========================================="
        echo "Creating initramfs with overlay support"
        echo "=========================================="
        echo ""
        if ! bash /app/setup-initramfs.sh "$ROOTFS_TEMP"; then
            echo "ERROR: setup-initramfs.sh failed"
            rm -f "$ROOTFS_TEMP"
            flock -u 200
            exit 1
        fi
        
        # ATOMIC: Rename temp file to final only after ALL setup succeeds
        echo "→ Finalizing rootfs..."
        mv "$ROOTFS_TEMP" "$ROOTFS_FINAL"
        
        # Release lock
        flock -u 200
        exec 200>&-
        
        echo "✓ Rootfs ready: $(ls -lh $ROOTFS_FINAL)"
    fi
else
    echo "✓ Rootfs already exists: $(ls -lh /opt/firecracker/rootfs/ubuntu.ext4)"
fi

# Verify Firecracker is installed and working
if ! command -v firecracker &> /dev/null; then
    echo "ERROR: Firecracker not found in PATH"
    exit 1
fi

# CRITICAL: Verify rootfs is valid (not corrupt)
if [ ! -f /opt/firecracker/rootfs/ubuntu.ext4 ]; then
    echo "ERROR: Rootfs not found at /opt/firecracker/rootfs/ubuntu.ext4"
    exit 1
fi

# Validate rootfs filesystem integrity
echo ""
echo "=========================================="
echo "Validating system components"
echo "=========================================="
echo "→ Checking rootfs integrity..."
if ! e2fsck -n /opt/firecracker/rootfs/ubuntu.ext4 >/dev/null 2>&1; then
    echo "✗ ERROR: Rootfs filesystem is corrupt. Rebuild required."
    echo "  → Delete /opt/firecracker/rootfs/ubuntu.ext4 and restart container"
    exit 1
fi

if [ ! -f /opt/firecracker/kernel/vmlinux-6.12 ]; then
    echo "✗ ERROR: Kernel not found at /opt/firecracker/kernel/vmlinux-6.12"
    exit 1
fi

echo "✓ Rootfs: $(ls -lh /opt/firecracker/rootfs/ubuntu.ext4 | awk '{print $5}') [VALID]"
echo "✓ Kernel: $(ls -lh /opt/firecracker/kernel/vmlinux-6.12 | awk '{print $5}')"

# Configure network for Firecracker VMs
echo ""
echo "=========================================="
echo "Configuring Network"
echo "=========================================="
if [ -f /app/setup-network.sh ]; then
    bash /app/setup-network.sh || {
        echo "✗ ERROR: Network setup failed"
        exit 1
    }
    
    echo ""
    echo "→ Verifying network components..."
    # Verify critical components
    if ! ip link show br0 >/dev/null 2>&1; then
        echo "✗ ERROR: Bridge br0 was not created"
        exit 1
    fi
    echo "  ✓ Bridge br0 created"
    
    if ! iptables -t nat -L POSTROUTING -n 2>/dev/null | grep -q "172.20.0.0/24"; then
        echo "  ⚠ WARNING: NAT rules may not be configured correctly"
    else
        echo "  ✓ NAT rules configured"
    fi
    
    echo ""
    echo "✓ Network configured successfully"
else
    echo "⚠ WARNING: setup-network.sh not found, skipping network configuration"
fi

# Start the VM orchestrator
echo ""
echo "=========================================="
echo "Starting VM Orchestrator"
echo "=========================================="
echo "API endpoint: http://localhost:3003"
echo "Health check: http://localhost:3003/health"
echo "Metrics: http://localhost:3003/metrics"
echo ""
exec "$@"
