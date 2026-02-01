#!/bin/bash
set -euo pipefail

# Install Global Python Packages with uv pip in Firecracker Rootfs
# Usage: sudo bash setup-pip.sh [rootfs-path]

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup-common.sh"

ROOTFS_PATH="${1:-/opt/firecracker/rootfs/ubuntu.ext4}"
MOUNT_DIR="/tmp/fc-rootfs-pip"
UV_CACHE_DIR="/opt/firecracker/cache/uv"
UV_MOUNT_DIR="$MOUNT_DIR/root/.cache/uv"

retry_cmd() {
    local attempts=3
    local delay=2
    local count=1
    while true; do
        if "$@"; then
            return 0
        fi
        if [ "$count" -ge "$attempts" ]; then
            return 1
        fi
        sleep "$delay"
        count=$((count + 1))
    done
}

require_root
validate_rootfs "$ROOTFS_PATH"

echo "====================================="
echo "Install Global Python Packages"
echo "====================================="
echo ""
echo "Rootfs: $ROOTFS_PATH"
echo ""

# Create mount directory
mkdir -p "$MOUNT_DIR"

# Cleanup using common function
cleanup_pip() {
    if mountpoint -q "$UV_MOUNT_DIR" 2>/dev/null; then
        umount "$UV_MOUNT_DIR" 2>/dev/null || umount -l "$UV_MOUNT_DIR" 2>/dev/null || true
    fi
    cleanup_chroot "$MOUNT_DIR"
}

trap "cleanup_pip" EXIT ERR

mount_rootfs "$ROOTFS_PATH" "$MOUNT_DIR"
setup_chroot_env "$MOUNT_DIR"

# Bind uv cache to persistent host cache
mkdir -p "$UV_CACHE_DIR"
mkdir -p "$UV_MOUNT_DIR"
mount --bind "$UV_CACHE_DIR" "$UV_MOUNT_DIR"
echo "  ✓ Bound uv cache: $UV_CACHE_DIR"

# Install global Python packages
echo "[3/3] Installing global Python packages with uv pip..."
echo ""
echo "  → No global packages configured"
echo "  → Add packages here as needed"
echo ""

echo "======================================"
echo "✓ Global Python packages installed!"
echo "======================================"
