#!/bin/bash
set -euo pipefail

# Install Global NPM Packages with bun in Firecracker Rootfs
# Usage: sudo bash setup-npm.sh [rootfs-path]

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup-common.sh"

ROOTFS_PATH="${1:-/opt/firecracker/rootfs/ubuntu.ext4}"
MOUNT_DIR="/tmp/fc-rootfs-packages"
PLAYWRIGHT_CACHE_DIR="/opt/firecracker/cache/ms-playwright"
PLAYWRIGHT_MOUNT_DIR="$MOUNT_DIR/root/.cache/ms-playwright"
BUN_CACHE_DIR="/opt/firecracker/cache/bun-install-cache"
BUN_MOUNT_DIR="$MOUNT_DIR/root/.bun/install/cache"
APT_CACHE_DIR="/opt/firecracker/cache/apt"
APT_MOUNT_DIR="$MOUNT_DIR/var/cache/apt/archives"

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
echo "Install Global Packages in Rootfs"
echo "====================================="
echo ""
echo "Rootfs: $ROOTFS_PATH"
echo ""

# Create mount directory
mkdir -p "$MOUNT_DIR"

# Cleanup using common function
cleanup_packages() {
    if mountpoint -q "$PLAYWRIGHT_MOUNT_DIR" 2>/dev/null; then
        umount "$PLAYWRIGHT_MOUNT_DIR" 2>/dev/null || umount -l "$PLAYWRIGHT_MOUNT_DIR" 2>/dev/null || true
    fi
    if mountpoint -q "$BUN_MOUNT_DIR" 2>/dev/null; then
        umount "$BUN_MOUNT_DIR" 2>/dev/null || umount -l "$BUN_MOUNT_DIR" 2>/dev/null || true
    fi
    if mountpoint -q "$APT_MOUNT_DIR" 2>/dev/null; then
        umount "$APT_MOUNT_DIR" 2>/dev/null || umount -l "$APT_MOUNT_DIR" 2>/dev/null || true
    fi
    cleanup_chroot "$MOUNT_DIR"
}

trap "cleanup_packages" EXIT ERR

mount_rootfs "$ROOTFS_PATH" "$MOUNT_DIR"
setup_chroot_env "$MOUNT_DIR"

# Bind Playwright browser cache to persistent host cache
mkdir -p "$PLAYWRIGHT_CACHE_DIR"
mkdir -p "$PLAYWRIGHT_MOUNT_DIR"
mount --bind "$PLAYWRIGHT_CACHE_DIR" "$PLAYWRIGHT_MOUNT_DIR"
echo "  ✓ Bound Playwright cache: $PLAYWRIGHT_CACHE_DIR"

# Bind bun cache to persistent host cache
mkdir -p "$BUN_CACHE_DIR"
mkdir -p "$BUN_MOUNT_DIR"
mount --bind "$BUN_CACHE_DIR" "$BUN_MOUNT_DIR"
echo "  ✓ Bound bun cache: $BUN_CACHE_DIR"

# Bind APT cache to persist Playwright install-deps downloads
mkdir -p "$APT_CACHE_DIR"
mkdir -p "$APT_MOUNT_DIR"
mount --bind "$APT_CACHE_DIR" "$APT_MOUNT_DIR"
echo "  ✓ Bound APT cache: $APT_CACHE_DIR"

# Install global packages
echo "[3/3] Installing global packages with bun..."
echo ""

echo "  → Installing chokidar and ws..."
if ! retry_cmd chroot "$MOUNT_DIR" /bin/bash -c '
    export DEBIAN_FRONTEND=noninteractive
    export TZ=Etc/UTC
    export NVM_DIR=/root/.nvm
    [ -s $NVM_DIR/nvm.sh ] && . $NVM_DIR/nvm.sh
    export PATH=/root/.bun/bin:$PATH
    set -x
    bun add --verbose -g chokidar@3 ws@latest
'; then
    echo "  ✗ Failed to install chokidar and ws"
    exit 1
fi
echo "  ✓ chokidar and ws installed globally"
echo ""

echo "  → Installing playwright and typescript..."
if ! retry_cmd chroot "$MOUNT_DIR" /bin/bash -c '
    export DEBIAN_FRONTEND=noninteractive
    export TZ=Etc/UTC
    export NVM_DIR=/root/.nvm
    [ -s $NVM_DIR/nvm.sh ] && . $NVM_DIR/nvm.sh
    export PATH=/root/.bun/bin:$PATH
    set -x
    bun add --verbose -g playwright typescript
'; then
    echo "  ✗ Failed to install playwright and typescript"
    exit 1
fi
echo "  ✓ playwright and typescript installed globally"
echo ""

# Also install chokidar and ws as local dependencies for the in-VM file server
echo "  → Installing chokidar and ws into /usr/local/lib/fileserver..."
if ! retry_cmd chroot "$MOUNT_DIR" /bin/bash -c '
    export DEBIAN_FRONTEND=noninteractive
    export TZ=Etc/UTC
    export NVM_DIR=/root/.nvm
    [ -s $NVM_DIR/nvm.sh ] && . $NVM_DIR/nvm.sh
    export PATH=/root/.bun/bin:$PATH
    set -x
    mkdir -p /usr/local/lib/fileserver
    cd /usr/local/lib/fileserver || exit 1
    # Ensure a minimal package.json so bun will install node_modules here
    if [ ! -f package.json ]; then
        printf "{\"name\":\"fileserver\",\"version\":\"1.0.0\"}\n" > package.json
    fi
    bun add --verbose chokidar@3 ws@latest
'; then
    echo "  ✗ Failed to install chokidar/ws in /usr/local/lib/fileserver"
    exit 1
fi
echo "  ✓ chokidar and ws installed in /usr/local/lib/fileserver"
echo ""

echo "======================================"
echo "✓ Global packages installed!"
echo "======================================"
