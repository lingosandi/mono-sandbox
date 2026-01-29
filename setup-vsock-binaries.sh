#!/bin/bash
set -euo pipefail

# Build and install vsock binaries into Firecracker rootfs
# Usage: sudo bash setup-vsock-binaries.sh [rootfs-path] [mount-dir] [--mounted]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup-common.sh"

ROOTFS_PATH="/opt/firecracker/rootfs/ubuntu.ext4"
MOUNT_DIR="/tmp/fc-rootfs-vsock"
USE_EXISTING_MOUNT=false

if [[ $# -gt 0 && -n "${1:-}" ]]; then
    ROOTFS_PATH="$1"
fi

if [[ $# -gt 1 ]]; then
    MOUNT_DIR="$2"
fi

if [[ ${3:-} == "--mounted" ]]; then
    USE_EXISTING_MOUNT=true
fi

require_root
if [ "$USE_EXISTING_MOUNT" = false ]; then
    validate_rootfs "$ROOTFS_PATH"
fi

SOURCE_DIR="/app/vm-orchestrator/vsock"
TERMINAL_SRC="$SOURCE_DIR/vsock-terminal.c"
PROXY_SRC="$SOURCE_DIR/vsock-tcp-proxy.c"

if [ ! -f "$TERMINAL_SRC" ] || [ ! -f "$PROXY_SRC" ]; then
    echo "ERROR: Missing vsock C sources in $SOURCE_DIR"
    echo "  → Expected: $TERMINAL_SRC"
    echo "  → Expected: $PROXY_SRC"
    exit 1
fi

cleanup_mount() {
    if [ "$USE_EXISTING_MOUNT" = true ]; then
        return
    fi
    umount "$MOUNT_DIR" 2>/dev/null || umount -l "$MOUNT_DIR" 2>/dev/null || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
}

trap cleanup_mount ERR

if [ "$USE_EXISTING_MOUNT" = true ]; then
    if ! mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
        echo "ERROR: $MOUNT_DIR is not mounted but --mounted was provided"
        exit 1
    fi
else
    mkdir -p "$MOUNT_DIR"
    if ! mount -o loop "$ROOTFS_PATH" "$MOUNT_DIR"; then
        echo "ERROR: Failed to mount rootfs at $ROOTFS_PATH"
        echo "  → Check if file exists and is a valid ext4 filesystem"
        echo "  → Check if another process has it mounted"
        echo "  → Try: lsof | grep $ROOTFS_PATH"
        exit 1
    fi
fi

# Compile vsock terminal binary (static)
echo "  → Compiling vsock terminal..."
if ! command -v gcc &> /dev/null; then
    echo "  ✗ gcc not found. Please install build tools:"
    echo "    sudo apt-get install build-essential"
    if [ "$USE_EXISTING_MOUNT" = false ]; then
        cleanup_mount
    fi
    exit 1
fi

BUILD_DIR="/tmp/vsock-build"
mkdir -p "$BUILD_DIR"

if ! gcc -static -O2 -o "$BUILD_DIR/vsock-terminal" "$TERMINAL_SRC" -lutil; then
    echo "  ✗ Failed to compile vsock terminal"
    if [ "$USE_EXISTING_MOUNT" = false ]; then
        cleanup_mount
    fi
    exit 1
fi

if ! gcc -static -O2 -o "$BUILD_DIR/vsock-tcp-proxy" "$PROXY_SRC" -lutil; then
    echo "  ✗ Failed to compile vsock-tcp-proxy"
    if [ "$USE_EXISTING_MOUNT" = false ]; then
        cleanup_mount
    fi
    exit 1
fi

mkdir -p "$MOUNT_DIR/usr/local/bin"
cp -v "$BUILD_DIR/vsock-terminal" "$MOUNT_DIR/usr/local/bin/"
cp -v "$BUILD_DIR/vsock-tcp-proxy" "$MOUNT_DIR/usr/local/bin/"
chmod +x "$MOUNT_DIR/usr/local/bin/vsock-terminal" "$MOUNT_DIR/usr/local/bin/vsock-tcp-proxy"

rm -f "$BUILD_DIR/vsock-terminal" "$BUILD_DIR/vsock-tcp-proxy"

if [ "$USE_EXISTING_MOUNT" = false ]; then
    cleanup_mount
fi

trap - ERR

echo "  ✓ Vsock binaries installed"
