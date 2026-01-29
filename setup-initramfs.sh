#!/bin/bash
set -euo pipefail

# setup-initramfs.sh - Create initramfs with overlay support
# This creates a minimal initramfs that sets up full-root overlay before systemd starts
# Industry standard approach: initramfs → overlay setup → pivot_root → systemd

ROOTFS_PATH="${1:-}"
if [ -z "$ROOTFS_PATH" ]; then
    echo "ERROR: Usage: $0 <rootfs-path>"
    exit 1
fi

if [ ! -f "$ROOTFS_PATH" ]; then
    echo "ERROR: Rootfs not found at $ROOTFS_PATH"
    exit 1
fi

echo "=== Creating initramfs with overlay support ==="

# Create temporary directory for initramfs
INITRAMFS_DIR=$(mktemp -d)
trap "rm -rf $INITRAMFS_DIR" EXIT

cd "$INITRAMFS_DIR"

# Create directory structure
mkdir -p bin sbin lib lib64 etc proc sys dev mnt/rootfs mnt/overlay mnt/newroot run

# Copy essential binaries from host (busybox approach)
echo "→ Copying essential binaries..."
cp /bin/busybox bin/ || cp /usr/bin/busybox bin/
cp /bin/mount bin/ || cp /usr/bin/mount bin/
cp /bin/umount bin/ || cp /usr/bin/umount bin/
cp /sbin/switch_root sbin/ 2>/dev/null || cp /usr/sbin/switch_root sbin/ || {
    echo "ERROR: switch_root not found on host"
    exit 1
}

# Copy required libraries
echo "→ Copying required libraries..."
for binary in bin/busybox bin/mount bin/umount sbin/switch_root; do
    if [ -f "$binary" ]; then
        # Get library dependencies (skip if statically linked)
        ldd "$binary" 2>/dev/null | grep -o '/[^ ]*' | while read lib; do
            if [ -f "$lib" ]; then
                mkdir -p "$(dirname "$lib" | sed 's|^/||')"
                cp -L "$lib" "$(echo "$lib" | sed 's|^/||')" 2>/dev/null || true
            fi
        done || true  # Ignore ldd errors (e.g., for statically linked binaries)
    fi
done

# Create busybox symlinks
for cmd in sh ash mount umount mkdir rmdir mknod sleep cat echo ls; do
    ln -sf busybox "bin/$cmd" 2>/dev/null || true
done

# Create init script (PID 1)
cat > init << 'INIT_EOF'
#!/bin/busybox sh
# Initramfs init - Sets up full-root overlay before systemd starts

set -e

# Mount essential filesystems
mount -t proc none /proc
mount -t sysfs none /sys
mount -t devtmpfs none /dev

echo "=== Initramfs: Setting up overlay ==="

# Wait for overlay disk (/dev/vdb) to appear
TIMEOUT=10
COUNT=0
while [ ! -b /dev/vdb ] && [ $COUNT -lt $TIMEOUT ]; do
    sleep 0.1
    COUNT=$((COUNT + 1))
done

if [ ! -b /dev/vdb ]; then
    echo "ERROR: Overlay disk /dev/vdb not found after ${TIMEOUT}s"
    echo "Falling back to read-only rootfs..."
    # Mount rootfs read-only and boot into it
    mount -o ro /dev/vda /mnt/newroot
    exec switch_root /mnt/newroot /sbin/init
fi

# Mount overlay disk
mkdir -p /mnt/overlay
mount /dev/vdb /mnt/overlay || {
    echo "ERROR: Failed to mount overlay disk"
    mount -o ro /dev/vda /mnt/newroot
    exec switch_root /mnt/newroot /sbin/init
}

# Create overlay structure
mkdir -p /mnt/overlay/upper
mkdir -p /mnt/overlay/work
mkdir -p /mnt/overlay/project

# Mount read-only rootfs
mkdir -p /mnt/rootfs
mount -o ro /dev/vda /mnt/rootfs || {
    echo "ERROR: Failed to mount rootfs"
    umount /mnt/overlay
    mount -o ro /dev/vda /mnt/newroot
    exec switch_root /mnt/newroot /sbin/init
}

# Create full-root overlay
# lowerdir = read-only rootfs (immutable base)
# upperdir = writable changes (persistent on overlay disk)
# workdir = overlay working directory (required by kernel)
mkdir -p /mnt/newroot
mount -t overlay overlay \
    -o lowerdir=/mnt/rootfs,upperdir=/mnt/overlay/upper,workdir=/mnt/overlay/work \
    /mnt/newroot || {
    echo "ERROR: Failed to create overlay"
    umount /mnt/rootfs
    umount /mnt/overlay
    mount -o ro /dev/vda /mnt/newroot
    exec switch_root /mnt/newroot /sbin/init
}

# Move overlay disk mount into new root
mkdir -p /mnt/newroot/mnt/overlay-disk
mount --move /mnt/overlay /mnt/newroot/mnt/overlay-disk

# Bind mount project directory
mkdir -p /mnt/newroot/mnt/project
mount --bind /mnt/newroot/mnt/overlay-disk/project /mnt/newroot/mnt/project

# Move essential mounts to new root
mount --move /dev /mnt/newroot/dev
mount --move /proc /mnt/newroot/proc
mount --move /sys /mnt/newroot/sys

echo "=== Initramfs: Overlay ready, starting systemd ==="

# Switch to new root and start systemd
exec switch_root /mnt/newroot /sbin/init
INIT_EOF

chmod +x init

# Create initramfs cpio archive
echo "→ Creating initramfs archive..."
find . | cpio -o -H newc | gzip > /tmp/initramfs.cpio.gz

# Copy initramfs to host location (Firecracker reads from host, not from inside rootfs)
echo "→ Installing initramfs to host..."
INITRAMFS_HOST_DIR="/opt/firecracker/rootfs"
mkdir -p "$INITRAMFS_HOST_DIR"
cp /tmp/initramfs.cpio.gz "$INITRAMFS_HOST_DIR/initramfs.img"
chmod 644 "$INITRAMFS_HOST_DIR/initramfs.img"

# Verify
INITRAMFS_SIZE=$(du -h "$INITRAMFS_HOST_DIR/initramfs.img" | cut -f1)
echo "  ✓ Initramfs installed: $INITRAMFS_HOST_DIR/initramfs.img (${INITRAMFS_SIZE})"

# Cleanup
rm -f /tmp/initramfs.cpio.gz

echo "✓ Initramfs created successfully"
