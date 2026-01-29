#!/bin/bash
set -euo pipefail

# Install File Server TS into Firecracker rootfs
# Usage: sudo bash setup-fileserver-js.sh [rootfs-path] [mount-dir] [--mounted]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup-common.sh"

ROOTFS_PATH="/opt/firecracker/rootfs/ubuntu.ext4"
MOUNT_DIR="/tmp/fc-rootfs-fileserver"
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

SOURCE_DIR="/app/vm-orchestrator/fileserver"
SERVER_SRC="$SOURCE_DIR/server.ts"

if [ ! -f "$SERVER_SRC" ]; then
    echo "ERROR: Missing file server TS at $SERVER_SRC"
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

mkdir -p "$MOUNT_DIR/usr/local/lib/fileserver"
cp -v "$SERVER_SRC" "$MOUNT_DIR/usr/local/lib/fileserver/server.ts"
chmod +x "$MOUNT_DIR/usr/local/lib/fileserver/server.ts"

echo "  ✓ File server script installed"

SERVICE_FILE="$MOUNT_DIR/etc/systemd/system/fileserver.service"
if [ -f "$SERVICE_FILE" ]; then
    sed -i 's/\r$//' "$SERVICE_FILE"
    sed -i 's#^ExecStart=.*#ExecStart=/root/.bun/bin/bun /usr/local/lib/fileserver/server.ts#' "$SERVICE_FILE"
    echo "  ✓ File server service updated (ExecStart set to /root/.bun/bin/bun)"
else
    echo "  ⚠ File server service not found at $SERVICE_FILE"
fi

WANTS_FILE="$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/fileserver.service"
if [ -f "$WANTS_FILE" ]; then
    sed -i 's/\r$//' "$WANTS_FILE"
    sed -i 's#^ExecStart=.*#ExecStart=/root/.bun/bin/bun /usr/local/lib/fileserver/server.ts#' "$WANTS_FILE"
fi

if [ "$USE_EXISTING_MOUNT" = false ]; then
    cleanup_mount
fi

trap - ERR
