#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# CRITICAL: Accept rootfs path as argument for atomic operations
ROOTFS_PATH="${1:-/opt/firecracker/rootfs/ubuntu.ext4}"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}ERROR: This script must be run as root (use sudo)${NC}"
   exit 1
fi

if [ ! -f "$ROOTFS_PATH" ]; then
    echo -e "${RED}✗ Rootfs not found at $ROOTFS_PATH${NC}"
    echo "  Please run setup-rootfs.sh first"
    exit 1
fi

echo ""
echo "======================================"
echo "  Agent Bridge Setup for Firecracker"
echo "======================================"
echo ""
echo "This script updates the agent bridge messaging system"
echo "Run this script when implementing new messaging features"
echo ""

# Create temporary mount directory
MOUNT_DIR=$(mktemp -d)
trap "umount '$MOUNT_DIR' 2>/dev/null || umount -l '$MOUNT_DIR' 2>/dev/null || true; rmdir '$MOUNT_DIR' 2>/dev/null || true" EXIT ERR

echo "[1/3] Mounting rootfs..."
# Check if already mounted (idempotency)
if mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
    echo "  ⚠ $MOUNT_DIR already mounted, unmounting first..."
    umount "$MOUNT_DIR" 2>/dev/null || umount -l "$MOUNT_DIR" 2>/dev/null || true
fi
if ! mount -o loop "$ROOTFS_PATH" "$MOUNT_DIR"; then
    echo -e "${RED}ERROR: Failed to mount rootfs at $ROOTFS_PATH${NC}"
    echo "  → Check if file exists and is a valid ext4 filesystem"
    echo "  → Check if another process has it mounted"
    exit 1
fi
echo "  ✓ Rootfs mounted at $MOUNT_DIR"

echo ""
echo "[2/3] Installing agent bridge components..."

# Create Python agent bridge module
echo "  → Creating Python agent_bridge module..."
# Install to uv Python 3.11 site-packages
UV_PYTHON_PATH=$(chroot "$MOUNT_DIR" /bin/bash -c 'export PATH=/root/.local/bin:$PATH; uv python find 3.11' 2>/dev/null || true)
if [ -z "$UV_PYTHON_PATH" ]; then
    UV_PYTHON_PATH="/usr/local/bin/python3"
fi
SITE_PACKAGES_PATH=$(chroot "$MOUNT_DIR" /bin/bash -c "${UV_PYTHON_PATH} -c 'import site; print(site.getsitepackages()[0])'" 2>/dev/null || true)
if [ -z "$SITE_PACKAGES_PATH" ]; then
    SITE_PACKAGES_PATH="/root/.local/share/uv/python/cpython-3.11.14-linux-x86_64-gnu/lib/python3.11/site-packages"
fi
mkdir -p "$MOUNT_DIR$SITE_PACKAGES_PATH"
cat > "$MOUNT_DIR$SITE_PACKAGES_PATH/agent_bridge.py" << 'PYEOF'
"""Agent Bridge - Send messages from Python agents to the host terminal."""
import json
import socket

SOCKET_PATH = '/tmp/agent-bridge.sock'

def send(message):
    """Send a message to the host terminal.
    
    Args:
        message: String message to display in the terminal
    """
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(SOCKET_PATH)
        sock.sendall((json.dumps({'message': message}) + '\n').encode('utf-8'))
        sock.close()
        return True
    except Exception as e:
        print(f"[AgentBridge] Failed to send: {e}")
        return False

def show_stream(url):
    """Show an agent stream in the preview panel.
    
    Args:
        url: Stream URL (e.g., https://example.com/stream)
    """
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(SOCKET_PATH)
        sock.sendall((json.dumps({'stream': url}) + '\n').encode('utf-8'))
        sock.close()
        return True
    except Exception as e:
        print(f"[AgentBridge] Failed to show stream: {e}")
        return False

class AgentBridge:
    """Context manager for persistent connection to the agent bridge."""
    
    def __init__(self):
        self.sock = None
    
    def __enter__(self):
        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect(SOCKET_PATH)
        except Exception as e:
            print(f"[AgentBridge] Failed to connect: {e}")
            self.sock = None
        return self
    
    def send(self, message):
        """Send a message to the terminal.
        
        Args:
            message: String message to display in the terminal
        """
        if not self.sock:
            return False
        
        try:
            self.sock.sendall((json.dumps({'message': message}) + '\n').encode('utf-8'))
            return True
        except Exception as e:
            print(f"[AgentBridge] Failed to send: {e}")
            return False
    
    def show_stream(self, url):
        """Show an agent stream in the preview panel.
        
        Args:
            url: Stream URL (e.g., https://example.com/stream)
        """
        if not self.sock:
            return False
        
        try:
            self.sock.sendall((json.dumps({'stream': url}) + '\n').encode('utf-8'))
            return True
        except Exception as e:
            print(f"[AgentBridge] Failed to show stream: {e}")
            return False
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.sock:
            self.sock.close()
            self.sock = None
PYEOF

echo "  ✓ Python agent_bridge module created"

# Create vsock-send helper binary
echo "  ✓ (vsock-send removed - using PTY direct write instead)"

# Create agent bridge Node.js service
echo "  → Creating agent bridge Node.js service..."
mkdir -p "$MOUNT_DIR/opt"
cat > "$MOUNT_DIR/opt/agent-bridge.js" << 'JSEOF'
#!/usr/bin/env bun
const net = require('net');
const fs = require('fs');

const SOCKET_PATH = '/tmp/agent-bridge.sock';

// Remove existing socket
if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
}

// Create Unix socket server
const server = net.createServer((client) => {
    let buffer = '';
    
    client.on('data', (data) => {
        buffer += data.toString();
        
        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer
        
        for (const line of lines) {
            if (line.trim()) {
                try {
                    // Validate JSON
                    const msg = JSON.parse(line);
                    
                    let payload;
                    
                    // Handle different message types
                    if (msg.message) {
                        // Toast message
                        payload = JSON.stringify({
                            type: 'toast',
                            data: {
                                message: msg.message
                            }
                        });
                    } else if (msg.stream) {
                        // Stream message
                        payload = JSON.stringify({
                            type: 'stream',
                            data: {
                                url: msg.stream
                            }
                        });
                    }
                    
                    if (payload) {
                        // Write OSC sequence to PTY devices
                        // OSC 99 is a custom code we'll use for our messages
                        // Format: \x1b]99;<json>\x07
                        const osc = `\x1b]99;${payload}\x07`;
                        
                        // Try common PTY paths (user terminals)
                        const ptyPaths = ['/dev/pts/0', '/dev/pts/1', '/dev/pts/2'];
                        
                        for (const ptyPath of ptyPaths) {
                            try {
                                if (fs.existsSync(ptyPath)) {
                                    fs.writeFileSync(ptyPath, osc, { flag: 'a' });
                                }
                            } catch (e) {
                                // Permission denied or write failed, try next PTY
                            }
                        }
                    }
                    
                } catch (e) {
                    // Invalid JSON, ignore
                }
            }
        }
    });
});

server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o666); // World-writable
});
JSEOF

chmod +x "$MOUNT_DIR/opt/agent-bridge.js"
echo "  ✓ Agent bridge Node.js service created"

echo ""
echo "[3/3] Configuring systemd service..."

# Create systemd service
cat > "$MOUNT_DIR/etc/systemd/system/agent-bridge.service" << 'EOF'
[Unit]
Description=Agent Bridge Service (Unix Socket to Terminal)
After=network.target vsock-terminal.service
Requires=vsock-terminal.service

[Service]
ExecStart=/root/.bun/bin/bun /opt/agent-bridge.js
Restart=always
RestartSec=1
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
Environment=IN_FIRECRACKER_VM=1
Environment=VOLTA_HOME=/root/.volta
Environment=PATH=/root/.bun/bin:/root/.volta/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF
echo "  ✓ Systemd service file created"

# Enable the service
mkdir -p "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/agent-bridge.service "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/agent-bridge.service"
echo "  ✓ Agent bridge service enabled"

SERVICE_FILE="$MOUNT_DIR/etc/systemd/system/agent-bridge.service"
if [ -f "$SERVICE_FILE" ]; then
    sed -i 's/\r$//' "$SERVICE_FILE"
    sed -i 's#^ExecStart=.*#ExecStart=/root/.bun/bin/bun /opt/agent-bridge.js#' "$SERVICE_FILE"
fi

WANTS_FILE="$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/agent-bridge.service"
if [ -f "$WANTS_FILE" ]; then
    sed -i 's/\r$//' "$WANTS_FILE"
    sed -i 's#^ExecStart=.*#ExecStart=/root/.bun/bin/bun /opt/agent-bridge.js#' "$WANTS_FILE"
fi

# Cleanup
if ! umount "$MOUNT_DIR"; then
    echo "  ⚠ Normal unmount failed, trying lazy unmount..."
    if ! umount -l "$MOUNT_DIR"; then
        echo "  ✗ Failed to unmount $MOUNT_DIR - manual cleanup needed"
        exit 1
    fi
fi
rmdir "$MOUNT_DIR" 2>/dev/null || true
trap - EXIT

echo ""
echo "======================================"
echo -e "${GREEN}✓ Agent bridge setup complete!${NC}"
echo "======================================"
echo ""
echo "The agent bridge is now installed and configured."
echo ""
echo "Python agents can use the bridge:"
echo "  import agent_bridge"
echo "  agent_bridge.send('Hello from agent!')"
echo ""
echo "Restart running VMs to activate the changes."
echo ""
