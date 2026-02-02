#!/bin/bash
set -euo pipefail

# TigerVNC + noVNC Setup Script
# Installs browser-ready VNC server with HTML5 client for browser streaming
# Usage: sudo bash setup-vnc.sh [rootfs-path]

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup-common.sh"

ROOTFS_PATH="/opt/firecracker/rootfs/ubuntu.ext4"
MOUNT_DIR="/tmp/fc-vnc-setup"

# Parse arguments
if [[ $# -gt 0 ]]; then
    ROOTFS_PATH="$1"
fi

require_root
validate_rootfs "$ROOTFS_PATH"

echo "====================================="
echo "TigerVNC + noVNC Setup"
echo "====================================="
echo ""
echo "Rootfs: $ROOTFS_PATH"
echo "Mount point: $MOUNT_DIR"
echo ""

# Create mount directory
mkdir -p "$MOUNT_DIR"

# Cleanup function for error handling
cleanup_vnc() {
    echo "Error occurred, cleaning up..."
    cleanup_chroot "$MOUNT_DIR"
}

trap cleanup_vnc ERR

# Mount and setup chroot
mount_rootfs "$ROOTFS_PATH" "$MOUNT_DIR"
setup_chroot_env "$MOUNT_DIR"

echo "[3/3] Installing VNC components..."
echo ""

# Update package lists
echo "  → Updating package lists..."
if ! chroot "$MOUNT_DIR" /bin/bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get -o Acquire::Retries=3 update'; then
    echo "  ✗ Failed to update package lists"
    cleanup_chroot "$MOUNT_DIR"
    exit 1
fi

# Install TigerVNC, noVNC, and minimal window manager
echo "  → Installing TigerVNC, noVNC, websockify, and Openbox..."
if ! chroot "$MOUNT_DIR" /bin/bash -c 'export DEBIAN_FRONTEND=noninteractive; export TZ=Etc/UTC; apt-get -o Acquire::Retries=3 install -y --no-install-recommends tigervnc-standalone-server tigervnc-common novnc websockify openbox xfonts-base xfonts-100dpi xfonts-75dpi xfonts-scalable dbus-x11'; then
    echo "  ✗ Failed to install VNC packages"
    cleanup_chroot "$MOUNT_DIR"
    exit 1
fi
echo "  ✓ VNC packages installed"

# Create VNC password (default: "password" - users should change this)
echo "  → Configuring VNC password..."
if ! chroot "$MOUNT_DIR" /bin/bash -c '
    mkdir -p /root/.vnc
    # Use vncpasswd with stdin (non-interactive)
    echo "password" | vncpasswd -f > /root/.vnc/passwd
    chmod 600 /root/.vnc/passwd
'; then
    echo "  ✗ Failed to set VNC password"
    cleanup_chroot "$MOUNT_DIR"
    exit 1
fi
echo "  ✓ VNC password set (default: 'password')"

# Create VNC xstartup script
echo "  → Creating VNC startup script..."
cat > "$MOUNT_DIR/root/.vnc/xstartup" << 'EOF'
#!/bin/bash
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec openbox-session
EOF
chmod +x "$MOUNT_DIR/root/.vnc/xstartup"
echo "  ✓ VNC startup script created"

# Create TigerVNC systemd service
echo "  → Creating TigerVNC systemd service..."
cat > "$MOUNT_DIR/etc/systemd/system/vncserver.service" << 'EOF'
[Unit]
Description=TigerVNC Server
After=network.target

[Service]
Type=forking
User=root
Environment=PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
ExecStart=/usr/bin/vncserver :1 -geometry 1920x1080 -depth 24 -localhost no
ExecStop=/usr/bin/vncserver -kill :1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Enable the VNC service
mkdir -p "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/vncserver.service "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/vncserver.service"
echo "  ✓ TigerVNC service created and enabled"

# Create noVNC systemd service (HTTP/WebSocket proxy)
echo "  → Creating noVNC systemd service..."
cat > "$MOUNT_DIR/etc/systemd/system/novnc.service" << 'EOF'
[Unit]
Description=noVNC WebSocket Proxy
After=vncserver.service
Requires=vncserver.service

[Service]
Type=simple
ExecStart=/usr/share/novnc/utils/launch.sh --vnc localhost:5901 --listen 6080
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Enable the noVNC service
ln -sf /etc/systemd/system/novnc.service "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/novnc.service"
echo "  ✓ noVNC service created and enabled"

# Create helper script to launch Chrome in the VM
echo "  → Creating Chrome launcher script..."
cat > "$MOUNT_DIR/usr/local/bin/launch-chrome" << 'EOF'
#!/bin/bash
# Launch Chrome in the VNC display
export DISPLAY=:1
export PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# Find chromium binary (Playwright install location)
CHROMIUM_BIN=$(ls /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)
if [ -z "$CHROMIUM_BIN" ] || [ ! -f "$CHROMIUM_BIN" ]; then
    CHROMIUM_BIN="chromium"
fi

# Launch Chrome with proper flags (quoted for safety)
"$CHROMIUM_BIN" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --no-first-run \
    --no-default-browser-check \
    "$@" &
EOF

chmod +x "$MOUNT_DIR/usr/local/bin/launch-chrome"
echo "  ✓ Chrome launcher created: /usr/local/bin/launch-chrome"

# Clean up apt cache
echo "  → Cleaning up..."
chroot "$MOUNT_DIR" /bin/bash -c 'rm -rf /var/lib/apt/lists/*'

# Unmount everything
cleanup_chroot "$MOUNT_DIR"

# Clear trap
trap - ERR

echo ""
echo "======================================"
echo "✅ VNC setup complete!"
echo "======================================"
echo ""
echo "Services:"
echo "  • TigerVNC: Port 5901 (VNC protocol)"
echo "  • noVNC: Port 6080 (HTTP + WebSocket)"
echo ""
echo "Default VNC password: 'password'"
echo ""
echo "To launch Chrome in VM:"
echo "  → launch-chrome [url]"
echo ""
echo "Resource usage:"
echo "  • TigerVNC: ~50-80MB RAM"
echo "  • noVNC: ~20-30MB RAM"
echo "  • Openbox: ~20-30MB RAM"
echo "  • Total: ~90-140MB overhead"
echo ""
echo "Integration in Next.js (super easy):"
echo "  → <iframe src=\"http://vm-ip:6080/vnc.html?autoconnect=true\" />"
echo ""
echo "Or use noVNC as React library:"
echo "  → npm install @novnc/novnc"
echo "  → import RFB from '@novnc/novnc/core/rfb'"
echo ""
