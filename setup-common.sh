#!/bin/bash
# Common functions for setup scripts
# Source this file in other setup scripts: source /app/setup-common.sh

# Root check
require_root() {
    if [[ $EUID -ne 0 ]]; then
        echo "ERROR: This script must be run as root (sudo)"
        exit 1
    fi
}

# Rootfs validation
validate_rootfs() {
    local rootfs_path="$1"
    if [[ ! -f "$rootfs_path" ]]; then
        echo "ERROR: Rootfs not found at $rootfs_path"
        exit 1
    fi
}

# Setup chroot environment (mount pseudo-filesystems + resolv.conf)
setup_chroot_env() {
    local mount_dir="$1"
    
    echo "[2/3] Setting up chroot environment..."
    mount -t proc none "$mount_dir/proc"
    mount -t sysfs none "$mount_dir/sys"
    mount -o bind /dev "$mount_dir/dev"
    mount -o bind /dev/pts "$mount_dir/dev/pts"
    
    # Copy resolv.conf for network access
    chattr -i "$mount_dir/etc/resolv.conf" 2>/dev/null || true
    rm -f "$mount_dir/etc/resolv.conf"
    cp /etc/resolv.conf "$mount_dir/etc/resolv.conf"
    echo "✓ Chroot environment ready"
    echo ""
}

# Cleanup chroot mounts and directory
cleanup_chroot() {
    local mount_dir="$1"
    
    echo "Cleaning up..."
    chattr -i "$mount_dir/etc/resolv.conf" 2>/dev/null || true
    umount "$mount_dir/dev/pts" 2>/dev/null || umount -l "$mount_dir/dev/pts" 2>/dev/null || true
    umount "$mount_dir/dev" 2>/dev/null || umount -l "$mount_dir/dev" 2>/dev/null || true
    umount "$mount_dir/sys" 2>/dev/null || umount -l "$mount_dir/sys" 2>/dev/null || true
    umount "$mount_dir/proc" 2>/dev/null || umount -l "$mount_dir/proc" 2>/dev/null || true
    umount "$mount_dir" 2>/dev/null || umount -l "$mount_dir" 2>/dev/null || true
    rmdir "$mount_dir" 2>/dev/null || true
}

# Mount rootfs with error checking
mount_rootfs() {
    local rootfs_path="$1"
    local mount_dir="$2"
    
    echo "[1/3] Mounting rootfs..."
    if mount -o loop "$rootfs_path" "$mount_dir"; then
        echo "✓ Mounted"
        echo ""
        return 0
    fi

    echo "ERROR: Failed to mount rootfs at $rootfs_path"
    echo "  → Check if file exists and is a valid ext4 filesystem"
    echo "  → Check if another process has it mounted"
    exit 1
}
