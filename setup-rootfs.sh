#!/bin/bash
set -euo pipefail

# Firecracker Rootfs Customization Script
# Prepares Ubuntu rootfs with systemd, vsock terminal, and development tools
# Usage: sudo bash setup-rootfs.sh [rootfs-path]

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup-common.sh"

ROOTFS_PATH="/opt/firecracker/rootfs/ubuntu.ext4"
MOUNT_DIR="/tmp/fc-rootfs-mount"
UV_CACHE_DIR="/opt/firecracker/cache/uv"

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

# Parse arguments
if [[ $# -gt 0 ]]; then
    ROOTFS_PATH="$1"
fi

require_root
validate_rootfs "$ROOTFS_PATH"

echo "====================================="
echo "Firecracker Rootfs Customization"
echo "====================================="
echo ""
echo "Rootfs: $ROOTFS_PATH"
echo "Mount point: $MOUNT_DIR"
echo ""

# Create mount directory
mkdir -p "$MOUNT_DIR"

# Cleanup function for error handling (extends common cleanup)
cleanup_rootfs() {
    echo "Error occurred, cleaning up..."
    if mountpoint -q "$MOUNT_DIR/var/cache/apt/archives" 2>/dev/null; then
        umount "$MOUNT_DIR/var/cache/apt/archives" 2>/dev/null || umount -l "$MOUNT_DIR/var/cache/apt/archives" 2>/dev/null || true
    fi
    if mountpoint -q "$MOUNT_DIR/root/.cache/uv" 2>/dev/null; then
        umount "$MOUNT_DIR/root/.cache/uv" 2>/dev/null || umount -l "$MOUNT_DIR/root/.cache/uv" 2>/dev/null || true
    fi
    cleanup_chroot "$MOUNT_DIR"
}

# Set trap to cleanup on error
trap cleanup_rootfs ERR

# Expand rootfs to have more space for packages
echo "[1/2] Expanding rootfs image..."
CURRENT_SIZE=$(du -m "$ROOTFS_PATH" | cut -f1)
echo "  → Current size: ${CURRENT_SIZE}MB"
if [ "$CURRENT_SIZE" -lt 2048 ]; then
    echo "  → Expanding to 2GB for package installation..."
    dd if=/dev/zero bs=1M count=1024 >> "$ROOTFS_PATH" status=progress
    set +e
    e2fsck -f -y "$ROOTFS_PATH"
    E2FSCK_STATUS=$?
    set -e
    if [ $E2FSCK_STATUS -ge 2 ]; then
        echo "ERROR: e2fsck reported unrecoverable errors (status $E2FSCK_STATUS)"
        exit 1
    fi
    resize2fs "$ROOTFS_PATH"
    echo "  ✓ Expanded to $(du -m "$ROOTFS_PATH" | cut -f1)MB"
else
    echo "  ✓ Size sufficient (${CURRENT_SIZE}MB)"
fi
echo ""

# Mount rootfs
echo "[2/3] Mounting rootfs..."

# Check if already mounted (idempotency)
if mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
    echo "  ⚠ $MOUNT_DIR already mounted, cleaning up first..."
    cleanup_rootfs
    # Recreate mount directory
    mkdir -p "$MOUNT_DIR"
fi

if ! mount -o loop "$ROOTFS_PATH" "$MOUNT_DIR"; then
    echo "ERROR: Failed to mount rootfs at $ROOTFS_PATH"
    echo "  → Check if file exists and is a valid ext4 filesystem"
    echo "  → Check if another process has it mounted"
    echo "  → Try: lsof | grep $ROOTFS_PATH"
    exit 1
fi
echo "✓ Mounted"
# Ensure overlay mount point exists for overlay-setup.service
mkdir -p "$MOUNT_DIR/overlay"
echo "  ✓ Created /overlay mount point in rootfs"
echo ""

# Configure systemd as init and add vsock terminal service
echo "[3/3] Configuring systemd and vsock terminal..."

# Link systemd as init
rm -f "$MOUNT_DIR/sbin/init"
ln -sf /lib/systemd/systemd "$MOUNT_DIR/sbin/init"
echo "  → Systemd installed as init"

# Install Python 3 and Node.js in rootfs
echo "  → Installing Python 3 and Node.js..."
mount -t proc none "$MOUNT_DIR/proc"
mount -t sysfs none "$MOUNT_DIR/sys"
mount -o bind /dev "$MOUNT_DIR/dev"
mount -o bind /dev/pts "$MOUNT_DIR/dev/pts"

# Copy resolv.conf for network access during package installation
# Remove immutable flag first (if set from previous run), then remove if it's a symlink
chattr -i "$MOUNT_DIR/etc/resolv.conf" 2>/dev/null || true
rm -f "$MOUNT_DIR/etc/resolv.conf"
cp /etc/resolv.conf "$MOUNT_DIR/etc/resolv.conf"

# Initialize dpkg database if needed
echo "  → Initializing package database..."
mkdir -p "$MOUNT_DIR/var/lib/dpkg"
if [ ! -f "$MOUNT_DIR/var/lib/dpkg/status" ]; then
    touch "$MOUNT_DIR/var/lib/dpkg/status"
fi
mkdir -p "$MOUNT_DIR/var/lib/dpkg/updates"
mkdir -p "$MOUNT_DIR/var/lib/dpkg/info"
mkdir -p "$MOUNT_DIR/var/lib/dpkg/alternatives"
mkdir -p "$MOUNT_DIR/var/lib/dpkg/triggers"
mkdir -p "$MOUNT_DIR/var/cache/apt/archives/partial"
mkdir -p "$MOUNT_DIR/var/lib/apt/lists/partial"

# Bind a persistent APT cache to avoid re-downloading packages
APT_CACHE_DIR="/opt/firecracker/cache/apt"
UV_CACHE_DIR="/opt/firecracker/cache/uv"
mkdir -p "$APT_CACHE_DIR"
mkdir -p "$UV_CACHE_DIR"
mkdir -p "$MOUNT_DIR/var/cache/apt/archives"
if ! mountpoint -q "$MOUNT_DIR/var/cache/apt/archives" 2>/dev/null; then
    mount --bind "$APT_CACHE_DIR" "$MOUNT_DIR/var/cache/apt/archives"
fi
echo "  ✓ Bound APT cache: $APT_CACHE_DIR"

# Bind uv cache to avoid re-downloading Python builds and wheels
mkdir -p "$MOUNT_DIR/root/.cache/uv"
if ! mountpoint -q "$MOUNT_DIR/root/.cache/uv" 2>/dev/null; then
    mount --bind "$UV_CACHE_DIR" "$MOUNT_DIR/root/.cache/uv"
fi
echo "  ✓ Bound uv cache: $UV_CACHE_DIR"

# Restore default Ubuntu mirrors using HTTP (HTTPS requires ca-certificates)
echo "  → Configuring default Ubuntu mirrors (HTTP)..."
cat > "$MOUNT_DIR/etc/apt/sources.list" << 'EOF'
deb http://archive.ubuntu.com/ubuntu/ jammy main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu/ jammy-updates main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu/ jammy-backports main restricted universe multiverse
deb http://security.ubuntu.com/ubuntu/ jammy-security main restricted universe multiverse
EOF

echo "  → Running apt-get update..."
if ! chroot "$MOUNT_DIR" /bin/bash -c 'export DEBIAN_FRONTEND=noninteractive; export TZ=Etc/UTC; dpkg --configure -a && apt-get -o Acquire::Retries=3 update'; then
    echo "  ✗ Failed to update package lists"
    umount "$MOUNT_DIR/dev/pts" 2>/dev/null || umount -l "$MOUNT_DIR/dev/pts" 2>/dev/null || true
    umount "$MOUNT_DIR/dev" 2>/dev/null || umount -l "$MOUNT_DIR/dev" 2>/dev/null || true
    umount "$MOUNT_DIR/sys" 2>/dev/null || umount -l "$MOUNT_DIR/sys" 2>/dev/null || true
    umount "$MOUNT_DIR/proc" 2>/dev/null || umount -l "$MOUNT_DIR/proc" 2>/dev/null || true
    umount "$MOUNT_DIR" 2>/dev/null || umount -l "$MOUNT_DIR" 2>/dev/null || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
    exit 1
fi

echo "  → Installing curl, Git, vim, nano, build tools, udev, unzip, and SSL certificates..."
if ! chroot "$MOUNT_DIR" /bin/bash -c 'export DEBIAN_FRONTEND=noninteractive; export TZ=Etc/UTC; apt-get -o Acquire::Retries=3 -f install -y && apt-get -o Acquire::Retries=3 install -y --no-install-recommends --fix-missing curl git vim nano build-essential socat ca-certificates udev unzip iputils-ping lsof iproute2 dnsutils telnet netcat-openbsd traceroute mtr-tiny screen'; then
    echo "  ✗ Failed to install packages"
    umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
    umount "$MOUNT_DIR/dev" 2>/dev/null || true
    umount "$MOUNT_DIR/sys" 2>/dev/null || true
    umount "$MOUNT_DIR/proc" 2>/dev/null || true
    umount "$MOUNT_DIR"
    rmdir "$MOUNT_DIR"
    exit 1
fi

echo "  → Cleaning apt lists..."
chroot "$MOUNT_DIR" /bin/bash -c 'rm -rf /var/lib/apt/lists/*'

# Cache directory for installers
CACHE_DIR="/opt/firecracker/cache"
mkdir -p "$CACHE_DIR"

# Check if uv is already installed
UV_INSTALLED=false
if chroot "$MOUNT_DIR" /bin/bash -c 'command -v uv >/dev/null 2>&1' 2>/dev/null; then
    UV_INSTALLED=true
    echo "  ✓ uv already installed"
fi

if [ "$UV_INSTALLED" = false ]; then
    echo "  → Installing uv (Python package manager)..."
    
    # Check if uv installer is cached
    UV_CACHE="$CACHE_DIR/uv-install.sh"
    UV_CACHE_SHA="$CACHE_DIR/uv-install.sh.sha256"
    CACHE_VALID=false
    
    if [ -f "$UV_CACHE" ] && [ -f "$UV_CACHE_SHA" ]; then
        echo "  → Verifying cached uv installer..."
        STORED_SHA=$(cat "$UV_CACHE_SHA")
        CURRENT_SHA=$(sha256sum "$UV_CACHE" | cut -d' ' -f1)
        
        if [ "$STORED_SHA" = "$CURRENT_SHA" ]; then
            echo "  ✓ Cache integrity verified"
            CACHE_VALID=true
        else
            echo "  ⚠ Cache integrity check failed, will re-download"
            rm -f "$UV_CACHE" "$UV_CACHE_SHA"
        fi
    fi
    
    if [ "$CACHE_VALID" = false ]; then
        echo "  → Downloading uv installer to cache..."
        UV_TEMP="${UV_CACHE}.tmp"
        if ! curl -# -fL --retry 3 --retry-all-errors --max-time 120 https://astral.sh/uv/install.sh -o "$UV_TEMP"; then
            rm -f "$UV_TEMP"
            echo "  ✗ Failed to download uv installer"
            umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
            umount "$MOUNT_DIR/dev" 2>/dev/null || true
            umount "$MOUNT_DIR/sys" 2>/dev/null || true
            umount "$MOUNT_DIR/proc" 2>/dev/null || true
            umount "$MOUNT_DIR"
            rmdir "$MOUNT_DIR"
            exit 1
        fi
        
        # Compute hash and atomically move to cache
        UV_HASH=$(sha256sum "$UV_TEMP" | cut -d' ' -f1)
        mv "$UV_TEMP" "$UV_CACHE"
        echo "$UV_HASH" > "$UV_CACHE_SHA"
        echo "  ✓ Downloaded and cached with integrity hash"
    fi
    
    # Copy installer into chroot temporarily
    cp "$UV_CACHE" "$MOUNT_DIR/tmp/uv-install.sh"
    chmod +x "$MOUNT_DIR/tmp/uv-install.sh"
    
    if ! retry_cmd chroot "$MOUNT_DIR" /bin/bash -c "
        sh /tmp/uv-install.sh
    "; then
        rm -f "$MOUNT_DIR/tmp/uv-install.sh"
        echo "  ✗ Failed to install uv after retries"
        umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
        umount "$MOUNT_DIR/dev" 2>/dev/null || true
        umount "$MOUNT_DIR/sys" 2>/dev/null || true
        umount "$MOUNT_DIR/proc" 2>/dev/null || true
        umount "$MOUNT_DIR"
        rmdir "$MOUNT_DIR"
        exit 1
    fi
    rm -f "$MOUNT_DIR/tmp/uv-install.sh"
    echo "  ✓ uv installed"
fi

# Note: Agent bridge setup moved to setup-messaging.sh
# Run that script separately to install/update messaging features

echo "  → Installing Python 3 via uv..."
if ! retry_cmd chroot "$MOUNT_DIR" /bin/bash -c "
    export PATH=/root/.local/bin:\$PATH
    UV_NO_PROGRESS=0 uv python install 3.11
    uv python pin 3.11
"; then
    echo "  ✗ Failed to install Python 3 via uv"
    umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
    umount "$MOUNT_DIR/dev" 2>/dev/null || true
    umount "$MOUNT_DIR/sys" 2>/dev/null || true
    umount "$MOUNT_DIR/proc" 2>/dev/null || true
    umount "$MOUNT_DIR"
    rmdir "$MOUNT_DIR"
    exit 1
fi
echo "  ✓ Python 3 installed via uv"

echo "  → Creating python3 and pip3 symlinks..."
chroot "$MOUNT_DIR" /bin/bash -c '
    export PATH=/root/.local/bin:$PATH
    PYTHON_PATH=$(uv python find 3.11)
    ln -sf "$PYTHON_PATH" /usr/local/bin/python3
    ln -sf /usr/local/bin/python3 /usr/local/bin/python
    
    # Create pip wrapper that uses uv pip with correct Python
    cat > /usr/local/bin/pip3 << "PIPEOF"
#!/bin/bash
export PATH=/root/.local/bin:$PATH
exec uv pip "$@"
PIPEOF
    chmod +x /usr/local/bin/pip3
    ln -sf /usr/local/bin/pip3 /usr/local/bin/pip
'
echo "  ✓ python3 and pip3 symlinks created"

echo "  → Cleaning apt lists..."
chroot "$MOUNT_DIR" /bin/bash -c 'rm -rf /var/lib/apt/lists/*' 2>/dev/null || true

# Check if nvm is already installed
NVM_INSTALLED=false
if chroot "$MOUNT_DIR" /bin/bash -c 'test -d /root/.nvm' 2>/dev/null; then
    NVM_INSTALLED=true
    echo "  ✓ nvm already installed"
fi

if [ "$NVM_INSTALLED" = false ]; then
    echo "  → Installing nvm (Node Version Manager)..."
    NVM_CACHE="$CACHE_DIR/nvm-install.sh"
    NVM_CACHE_SHA="$CACHE_DIR/nvm-install.sh.sha256"
    CACHE_VALID=false

    if [ -f "$NVM_CACHE" ] && [ -f "$NVM_CACHE_SHA" ]; then
        STORED_SHA=$(cat "$NVM_CACHE_SHA")
        CURRENT_SHA=$(sha256sum "$NVM_CACHE" | cut -d' ' -f1)
        if [ "$STORED_SHA" = "$CURRENT_SHA" ]; then
            CACHE_VALID=true
            echo "  ✓ Cached nvm installer verified"
        else
            echo "  ⚠ nvm installer cache invalid, re-downloading"
            rm -f "$NVM_CACHE" "$NVM_CACHE_SHA"
        fi
    fi

    if [ "$CACHE_VALID" = false ]; then
        NVM_TEMP="${NVM_CACHE}.tmp"
        if ! curl -# -fL --retry 3 --retry-all-errors --max-time 120 https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh -o "$NVM_TEMP"; then
            rm -f "$NVM_TEMP"
            echo "  ✗ Failed to download nvm installer"
            umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
            umount "$MOUNT_DIR/dev" 2>/dev/null || true
            umount "$MOUNT_DIR/sys" 2>/dev/null || true
            umount "$MOUNT_DIR/proc" 2>/dev/null || true
            umount "$MOUNT_DIR"
            rmdir "$MOUNT_DIR"
            exit 1
        fi
        NVM_HASH=$(sha256sum "$NVM_TEMP" | cut -d' ' -f1)
        mv "$NVM_TEMP" "$NVM_CACHE"
        echo "$NVM_HASH" > "$NVM_CACHE_SHA"
        echo "  ✓ nvm installer cached"
    fi

    # Copy installer into chroot temporarily
    cp "$NVM_CACHE" "$MOUNT_DIR/tmp/nvm-install.sh"
    chmod +x "$MOUNT_DIR/tmp/nvm-install.sh"
    
    if ! retry_cmd chroot "$MOUNT_DIR" /bin/bash -c "
        export NVM_DIR=/root/.nvm
        export PROFILE=/dev/null
        bash /tmp/nvm-install.sh
    "; then
        rm -f "$MOUNT_DIR/tmp/nvm-install.sh"
        echo "  ✗ Failed to install nvm after retries"
        umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
        umount "$MOUNT_DIR/dev" 2>/dev/null || true
        umount "$MOUNT_DIR/sys" 2>/dev/null || true
        umount "$MOUNT_DIR/proc" 2>/dev/null || true
        umount "$MOUNT_DIR"
        rmdir "$MOUNT_DIR"
        exit 1
    fi
    rm -f "$MOUNT_DIR/tmp/nvm-install.sh"
    echo "  ✓ nvm installed"
fi

echo "  → Installing Node.js 22 (LTS) via nvm..."
if ! retry_cmd chroot "$MOUNT_DIR" /bin/bash -c "
    export NVM_DIR=/root/.nvm
    [ -s \$NVM_DIR/nvm.sh ] && \. \$NVM_DIR/nvm.sh
    nvm install 22
    nvm alias default 22
"; then
    echo "  ✗ Failed to install Node.js via nvm"
    umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
    umount "$MOUNT_DIR/dev" 2>/dev/null || true
    umount "$MOUNT_DIR/sys" 2>/dev/null || true
    umount "$MOUNT_DIR/proc" 2>/dev/null || true
    umount "$MOUNT_DIR"
    rmdir "$MOUNT_DIR"
    exit 1
fi
echo "  ✓ Node.js 22 (LTS) installed via nvm"

# Install bun
echo "  → Installing bun..."
BUN_CACHE="$CACHE_DIR/bun-install.sh"
BUN_CACHE_SHA="$CACHE_DIR/bun-install.sh.sha256"
CACHE_VALID=false

if [ -f "$BUN_CACHE" ] && [ -f "$BUN_CACHE_SHA" ]; then
    STORED_SHA=$(cat "$BUN_CACHE_SHA")
    CURRENT_SHA=$(sha256sum "$BUN_CACHE" | cut -d' ' -f1)
    if [ "$STORED_SHA" = "$CURRENT_SHA" ]; then
        CACHE_VALID=true
        echo "  ✓ Cached bun installer verified"
    else
        echo "  ⚠ bun installer cache invalid, re-downloading"
        rm -f "$BUN_CACHE" "$BUN_CACHE_SHA"
    fi
fi

if [ "$CACHE_VALID" = false ]; then
    BUN_TEMP="${BUN_CACHE}.tmp"
    if ! curl -# -fL --retry 3 --retry-all-errors --max-time 120 https://bun.sh/install -o "$BUN_TEMP"; then
        rm -f "$BUN_TEMP"
        echo "  ✗ Failed to download bun installer"
        umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
        umount "$MOUNT_DIR/dev" 2>/dev/null || true
        umount "$MOUNT_DIR/sys" 2>/dev/null || true
        umount "$MOUNT_DIR/proc" 2>/dev/null || true
        umount "$MOUNT_DIR"
        rmdir "$MOUNT_DIR"
        exit 1
    fi
    BUN_HASH=$(sha256sum "$BUN_TEMP" | cut -d' ' -f1)
    mv "$BUN_TEMP" "$BUN_CACHE"
    echo "$BUN_HASH" > "$BUN_CACHE_SHA"
    echo "  ✓ bun installer cached"
fi

# Copy installer into chroot temporarily
cp "$BUN_CACHE" "$MOUNT_DIR/tmp/bun-install.sh"
chmod +x "$MOUNT_DIR/tmp/bun-install.sh"

if ! retry_cmd chroot "$MOUNT_DIR" /bin/bash -c "
    export BUN_INSTALL=/root/.bun
    export PATH=/root/.bun/bin:\$PATH
    set +e
    bash /tmp/bun-install.sh
    install_status=\$?
    set -e
    if [ ! -x /root/.bun/bin/bun ]; then
        exit \$install_status
    fi
    ln -s /root/.bun/bin/bun /usr/local/bin/bun
    exit 0
"; then
    rm -f "$MOUNT_DIR/tmp/bun-install.sh"
    echo "  ✗ Failed to install bun after retries"
    umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
    umount "$MOUNT_DIR/dev" 2>/dev/null || true
    umount "$MOUNT_DIR/sys" 2>/dev/null || true
    umount "$MOUNT_DIR/proc" 2>/dev/null || true
    umount "$MOUNT_DIR"
    rmdir "$MOUNT_DIR"
    exit 1
fi
rm -f "$MOUNT_DIR/tmp/bun-install.sh"
echo "  ✓ bun installed"

echo "  → Cleaning up..."
chroot "$MOUNT_DIR" /bin/bash -c 'rm -rf /var/lib/apt/lists/*' 2>/dev/null || true

echo "  → Skipping global package installation (use setup-npm.sh)"
echo "  ✓ Run 'sudo bash setup-npm.sh' to install chokidar, ws, and other global packages"

echo "  ✓ Python installed"
echo "  ✓ Node.js installed"
echo "  ✓ bun installed"

# Unmount APT cache bind
if mountpoint -q "$MOUNT_DIR/var/cache/apt/archives" 2>/dev/null; then
    umount "$MOUNT_DIR/var/cache/apt/archives" 2>/dev/null || umount -l "$MOUNT_DIR/var/cache/apt/archives" 2>/dev/null || true
fi

# Unmount uv cache bind
if mountpoint -q "$MOUNT_DIR/root/.cache/uv" 2>/dev/null; then
    umount "$MOUNT_DIR/root/.cache/uv" 2>/dev/null || umount -l "$MOUNT_DIR/root/.cache/uv" 2>/dev/null || true
fi

# Unmount pseudo-filesystems
umount "$MOUNT_DIR/dev/pts" 2>/dev/null || true
umount "$MOUNT_DIR/dev" 2>/dev/null || true
umount "$MOUNT_DIR/sys" 2>/dev/null || true
umount "$MOUNT_DIR/proc" 2>/dev/null || true

# Compile vsock binaries (terminal + proxy)
echo "  → Installing vsock binaries..."
if [ ! -f /app/setup-vsock-binaries.sh ]; then
    echo "ERROR: /app/setup-vsock-binaries.sh not found"
    exit 1
fi
if ! mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
    echo "ERROR: Rootfs is not mounted at $MOUNT_DIR"
    exit 1
fi
if ! bash /app/setup-vsock-binaries.sh "$ROOTFS_PATH" "$MOUNT_DIR" --mounted; then
    echo "  ✗ Failed to install vsock binaries"
    exit 1
fi

# Create systemd service for vsock-tcp proxy
cat > "$MOUNT_DIR/etc/systemd/system/vsock-proxy.service" << 'EOF'
[Unit]
Description=Vsock to TCP Proxy for File Server
After=network.target fileserver.service

[Service]
ExecStart=/usr/local/bin/vsock-tcp-proxy
Restart=always
RestartSec=1
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Enable vsock proxy service
mkdir -p "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/vsock-proxy.service "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/vsock-proxy.service"
echo "  ✓ Vsock proxy service enabled"

# Create systemd service for vsock terminal
cat > "$MOUNT_DIR/etc/systemd/system/vsock-terminal.service" << 'EOF'
[Unit]
Description=Vsock Terminal Listener
DefaultDependencies=no
After=systemd-modules-load.service
Before=basic.target

[Service]
ExecStart=/usr/local/bin/vsock-terminal
Restart=always
RestartSec=1

[Install]
WantedBy=basic.target
EOF

# Enable the service
ln -sf /etc/systemd/system/vsock-terminal.service "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/vsock-terminal.service"
echo "  ✓ Vsock terminal service enabled"

# Note: Agent bridge systemd service moved to setup-messaging.sh

# Copy file server script to VM
echo "  → Installing file server script..."
if [ ! -f /app/setup-fileserver-js.sh ]; then
    echo "ERROR: /app/setup-fileserver-js.sh not found"
    exit 1
fi
if ! mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
    echo "ERROR: Rootfs is not mounted at $MOUNT_DIR"
    exit 1
fi
if ! bash /app/setup-fileserver-js.sh "$ROOTFS_PATH" "$MOUNT_DIR" --mounted; then
    echo "  ✗ Failed to install file server script"
    exit 1
fi

# Update fileserver service to not depend on overlay-setup.service
cat > "$MOUNT_DIR/etc/systemd/system/fileserver.service" << 'EOF'
[Unit]
Description=File Server
After=network-online.target
RequiresMountsFor=/mnt/project

[Service]
Type=simple
ExecStart=/root/.bun/bin/bun /usr/local/lib/fileserver/server.ts
# Restart always - script will exit if mount not ready
Restart=always
RestartSec=2
# Allow many retries - mount might be slow
StartLimitBurst=15
StartLimitInterval=60
WorkingDirectory=/
# Log to file directly - systemd journal capture is unreliable for JS runtimes
StandardOutput=append:/tmp/fileserver-output.log
StandardError=append:/tmp/fileserver-error.log
Environment=NODE_ENV=production
Environment=NVM_DIR=/root/.nvm
Environment=PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
Environment=IN_FIRECRACKER_VM=1
Environment=PATH=/root/.bun/bin:/root/.nvm/versions/node/v22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

# Enable file server service
mkdir -p "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/fileserver.service "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/fileserver.service"
echo "  ✓ File server service enabled"

# Create a helper service to dump fileserver logs to console after 10 seconds
# This helps diagnose issues when fileserver doesn't start
cat > "$MOUNT_DIR/etc/systemd/system/fileserver-log-dumper.service" << 'EOF'
[Unit]
Description=Dump File Server Logs to Console (Debug Helper)
After=fileserver.service
Wants=fileserver.service

[Service]
Type=oneshot
# Wait 10 seconds then dump logs directly to /dev/console
ExecStartPre=/bin/sleep 10
ExecStart=/bin/sh -c 'exec 1>/dev/console 2>&1; echo "===== FILE SERVER STARTUP LOG ====="; cat /tmp/fileserver-startup.log 2>/dev/null || echo "No startup log found"; echo "===== FILE SERVER OUTPUT LOG ====="; cat /tmp/fileserver-output.log 2>/dev/null || echo "No output log found"; echo "===== FILE SERVER ERROR LOG ====="; cat /tmp/fileserver-error.log 2>/dev/null || echo "No error log found"; echo "===== FILE SERVER PROCESS STATUS ====="; ps aux | grep "[b]un.*fileserver" || echo "No fileserver process found"; echo "===== MOUNT STATUS ====="; mount | grep /mnt/project || echo "/mnt/project not mounted"'
RemainAfterExit=yes
StandardOutput=inherit
StandardError=inherit

[Install]
WantedBy=multi-user.target
EOF

# Enable log dumper service
ln -sf /etc/systemd/system/fileserver-log-dumper.service "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/fileserver-log-dumper.service"
echo "  ✓ File server log dumper service enabled"

# Note: OverlayFS setup is now handled by initramfs (setup-initramfs.sh)
# The initramfs sets up full-root overlay before systemd starts
# This is the industry-standard approach for overlay-based sandboxes

# Create tmpfs mount for /tmp (writable in-memory filesystem)
cat > "$MOUNT_DIR/etc/systemd/system/tmp.mount" << 'EOF'
[Unit]
Description=Temporary Directory (/tmp)
ConditionPathIsSymbolicLink=!/tmp
DefaultDependencies=no
Conflicts=umount.target
Before=local-fs.target umount.target

[Mount]
What=tmpfs
Where=/tmp
Type=tmpfs
Options=mode=1777,strictatime,nosuid,nodev

[Install]
WantedBy=local-fs.target
EOF

# Enable tmpfs mount
mkdir -p "$MOUNT_DIR/etc/systemd/system/local-fs.target.wants"
ln -sf /etc/systemd/system/tmp.mount "$MOUNT_DIR/etc/systemd/system/local-fs.target.wants/tmp.mount"
echo "  ✓ tmpfs mount for /tmp enabled"

echo "✓ Systemd and vsock terminal configured"
echo ""

# Configure network with DHCP
echo "Configuring network..."

# Create systemd-network directory
mkdir -p "$MOUNT_DIR/etc/systemd/network"

cat > "$MOUNT_DIR/etc/systemd/network/50-eth0.network" << 'EOF'
[Match]
Name=eth0

[Network]
# IP is configured via kernel boot parameter (ip= in firecracker-config.ts)
# Tell systemd-networkd to keep the kernel-configured IP
KeepConfiguration=static

[Link]
# Ensure interface comes up
RequiredForOnline=yes
EOF

# Enable systemd-networkd
mkdir -p "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants"
mkdir -p "$MOUNT_DIR/etc/systemd/system/sockets.target.wants"
ln -sf /lib/systemd/system/systemd-networkd.service "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/systemd-networkd.service"
ln -sf /lib/systemd/system/systemd-networkd.socket "$MOUNT_DIR/etc/systemd/system/sockets.target.wants/systemd-networkd.socket"

echo "  ✓ Network configuration created (run setup-network.sh to configure DNS and IPv6 settings)"

# Configure /etc/hosts with localhost resolution (dual-stack)
cat > "$MOUNT_DIR/etc/hosts" << 'EOF'
127.0.0.1       localhost
127.0.1.1       vm

# IPv6 localhost
::1             localhost ip6-localhost ip6-loopback
ff02::1         ip6-allnodes
ff02::2         ip6-allrouters
EOF

echo "  ✓ /etc/hosts configured with localhost resolution (IPv4 + IPv6)"

echo "✓ Network interfaces created (run setup-network.sh to configure DNS and dual-stack IPv4/IPv6)"
echo ""

# Create .bashrc for better shell experience
cat > "$MOUNT_DIR/root/.bashrc" << EOF
# Custom bashrc for Firecracker VM

# uv (Python package manager)
export PATH="/root/.local/bin:\$PATH"

# nvm environment
export NVM_DIR=/root/.nvm
[ -s "\$NVM_DIR/nvm.sh" ] && \. "\$NVM_DIR/nvm.sh"
[ -s "\$NVM_DIR/bash_completion" ] && \. "\$NVM_DIR/bash_completion"

# bun
export PATH="/root/.bun/bin:\$PATH"

# Playwright browsers location (installed in rootfs, read-only shared across VMs)
export PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# Set HOME to /root (standard location, persistent with overlay disk)
export HOME=/root
cd /mnt/project 2>/dev/null || true

# Auto-create and activate Python virtual environment with system packages access
if [ ! -d "/mnt/project/.venv" ]; then
    uv venv --system-site-packages /mnt/project/.venv 2>/dev/null
fi

if [ -f "/mnt/project/.venv/bin/activate" ]; then
    source /mnt/project/.venv/bin/activate
fi

export PS1='\[\033[01;32m\]\u@vm\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
export TERM=xterm-256color
export IN_FIRECRACKER_VM=1

# Add local bin directories to PATH
export PATH="/mnt/project/.local/bin:/mnt/project/node_modules/.bin:\$PATH"

# Aliases
alias ll='ls -la'
alias la='ls -A'
alias l='ls -CF'
alias python='python3'

# Python
export PYTHONUNBUFFERED=1

# Node.js
export NODE_ENV=development

# Welcome message function
welcome() {
    echo "Firecracker MicroVM - Ubuntu 22.04 Jammy"
    echo ""
    echo "Home directory: $HOME"
    echo "Working directory: $(pwd)"
}
EOF

# Also add PATH to .profile for login shells
cat > "$MOUNT_DIR/root/.profile" << 'EOF'
# ~/.profile: executed by the command interpreter for login shells.

# Set PATH for uv, nvm, and bun
export PATH="/root/.local/bin:$PATH"
export NVM_DIR=/root/.nvm
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
export PATH="/root/.bun/bin:$PATH"

# If running bash, source .bashrc
if [ -n "$BASH_VERSION" ]; then
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi
EOF

# Unmount everything
echo "Cleaning up..."

# Remove immutable flag from resolv.conf before unmounting
chattr -i "$MOUNT_DIR/etc/resolv.conf" 2>/dev/null || true

umount "$MOUNT_DIR/dev/pts" 2>/dev/null || umount -l "$MOUNT_DIR/dev/pts" 2>/dev/null || true
umount "$MOUNT_DIR/dev" 2>/dev/null || umount -l "$MOUNT_DIR/dev" 2>/dev/null || true
umount "$MOUNT_DIR/sys" 2>/dev/null || umount -l "$MOUNT_DIR/sys" 2>/dev/null || true
umount "$MOUNT_DIR/proc" 2>/dev/null || umount -l "$MOUNT_DIR/proc" 2>/dev/null || true

# Final unmount with fallback to lazy unmount
if ! umount "$MOUNT_DIR"; then
    echo "  ⚠ Normal unmount failed, trying lazy unmount..."
    if ! umount -l "$MOUNT_DIR"; then
        echo "  ✗ Failed to unmount $MOUNT_DIR - manual cleanup needed"
        echo "  → Check: lsof | grep $MOUNT_DIR"
        exit 1
    fi
fi

rmdir "$MOUNT_DIR" 2>/dev/null || true

# Clear trap
trap - ERR

echo ""
echo "======================================"
echo "✅ Rootfs customization complete!"
echo "======================================"
echo ""
echo "Rootfs now includes:"
echo "  • Python 3 (via uv)"
echo "  • Node.js (via nvm)"
echo "  • CA certificates for SSL/TLS"
echo "  • Git, vim, nano"
echo "  • Build tools (gcc, make, etc.)"
echo "  • Systemd init system"
echo "  • systemd-networkd (Static IP: 172.20.0.2/24)"
echo "  • Vsock terminal service (port 1024)"
echo "  • Vsock file server (port 8080)"
echo "  • Project drive auto-mount at /mnt/project"
echo ""
echo "Additional setup scripts:"
echo "  • bash setup-pip.sh       - Install Python packages"
echo "  • bash setup-npm.sh       - Install Node.js packages"
echo "  • bash setup-messaging.sh - Update agent bridge"
echo ""
echo "Rootfs size:"
du -h "$ROOTFS_PATH"
echo ""
echo "Ready to use with Firecracker!"
