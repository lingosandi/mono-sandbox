#!/bin/bash
set -euo pipefail

# setup-network.sh - Configure network settings for Firecracker VMs
# This script configures DNS and NAT on host, plus DNS in rootfs

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup-common.sh"

ROOTFS_IMAGE="/opt/firecracker/rootfs/ubuntu.ext4"
MOUNT_DIR="/tmp/rootfs-mount-$$"

# Cleanup function for error handling
cleanup_mount() {
    if mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
        echo "  → Cleaning up: unmounting $MOUNT_DIR"
        umount "$MOUNT_DIR" 2>/dev/null || umount -l "$MOUNT_DIR" 2>/dev/null || true
    fi
    if [ -d "$MOUNT_DIR" ]; then
        rmdir "$MOUNT_DIR" 2>/dev/null || true
    fi
}

# Set trap to cleanup on error
trap cleanup_mount ERR EXIT

echo "=== Firecracker Network Configuration ==="
echo ""

require_root
validate_rootfs "$ROOTFS_IMAGE"

if ! command -v ip >/dev/null 2>&1; then
    echo "ERROR: ip command not found (iproute2 required)"
    exit 1
fi

if ! command -v iptables >/dev/null 2>&1; then
    echo "ERROR: iptables not found"
    exit 1
fi

IP6TABLES_AVAILABLE=true
IP6TABLES_NAT_AVAILABLE=true
if ! command -v ip6tables >/dev/null 2>&1; then
    IP6TABLES_AVAILABLE=false
    IP6TABLES_NAT_AVAILABLE=false
    echo "  ⚠ ip6tables not found - skipping IPv6 NAT/FORWARD rules"
else
    if ! ip6tables -t nat -L >/dev/null 2>&1; then
        IP6TABLES_NAT_AVAILABLE=false
        echo "  ⚠ ip6tables nat table unavailable - skipping IPv6 NAT"
    fi
fi

# Helper function to safely set sysctl (ignore errors in Docker)
safe_sysctl() {
    sysctl -w "$1" 2>/dev/null || echo "  ⚠ Skipping $1 (not available in Docker)"
}

echo "Step 1: Configuring NAT connection tracking..."
echo "-----------------------------------------------"

# Enable IP forwarding (REQUIRED for NAT to work)
safe_sysctl net.ipv4.ip_forward=1
safe_sysctl net.ipv4.conf.all.forwarding=1
safe_sysctl net.ipv4.conf.default.forwarding=1

# Enable IPv6 forwarding
safe_sysctl net.ipv6.conf.all.forwarding=1
safe_sysctl net.ipv6.conf.default.forwarding=1

# Apply conntrack settings immediately
safe_sysctl net.netfilter.nf_conntrack_tcp_timeout_established=3600
safe_sysctl net.netfilter.nf_conntrack_tcp_timeout_time_wait=30
safe_sysctl net.netfilter.nf_conntrack_tcp_timeout_close_wait=30
safe_sysctl net.netfilter.nf_conntrack_tcp_timeout_fin_wait=60
safe_sysctl net.netfilter.nf_conntrack_max=262144

# Apply TCP optimization settings immediately
safe_sysctl net.ipv4.tcp_keepalive_time=60
safe_sysctl net.ipv4.tcp_keepalive_intvl=10
safe_sysctl net.ipv4.tcp_keepalive_probes=3
safe_sysctl net.core.rmem_max=16777216
safe_sysctl net.core.wmem_max=16777216
safe_sysctl net.core.rmem_default=262144
safe_sysctl net.core.wmem_default=262144
safe_sysctl net.ipv4.tcp_rmem="4096 87380 16777216"
safe_sysctl net.ipv4.tcp_wmem="4096 65536 16777216"
safe_sysctl net.ipv4.udp_rmem_min=8192
safe_sysctl net.ipv4.udp_wmem_min=8192
safe_sysctl net.ipv4.ip_local_port_range="10000 65535"
safe_sysctl net.ipv4.tcp_fastopen=3
safe_sysctl net.ipv4.tcp_tw_reuse=1
safe_sysctl net.ipv4.tcp_fin_timeout=15
safe_sysctl net.ipv4.tcp_max_syn_backlog=8192
safe_sysctl net.core.somaxconn=4096
safe_sysctl net.core.netdev_max_backlog=5000
safe_sysctl net.ipv4.tcp_window_scaling=1
safe_sysctl net.ipv4.tcp_timestamps=1
safe_sysctl net.ipv4.tcp_sack=1
safe_sysctl net.ipv4.tcp_no_metrics_save=1
safe_sysctl net.ipv4.tcp_slow_start_after_idle=0
safe_sysctl net.ipv4.tcp_syncookies=1
safe_sysctl net.ipv4.tcp_synack_retries=2
safe_sysctl net.ipv4.tcp_syn_retries=2
safe_sysctl net.ipv4.tcp_abort_on_overflow=1

# TCP memory management (prevent memory exhaustion)
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TCP_MEM_MIN=$((TOTAL_MEM_KB / 128))  # ~1% of RAM
TCP_MEM_DEFAULT=$((TOTAL_MEM_KB / 64))  # ~2% of RAM
TCP_MEM_MAX=$((TOTAL_MEM_KB / 32))  # ~3% of RAM
safe_sysctl net.ipv4.tcp_mem="$TCP_MEM_MIN $TCP_MEM_DEFAULT $TCP_MEM_MAX"

# TCP orphan limits (clean up abandoned connections)
safe_sysctl net.ipv4.tcp_max_orphans=16384

# Netfilter connection tracking hash table size (should be conntrack_max / 4)
safe_sysctl net.netfilter.nf_conntrack_buckets=65536

# Path MTU discovery (better for cloud/varied network paths)
safe_sysctl net.ipv4.ip_no_pmtu_disc=0

# TCP moderate receive buffer (enhanced auto-tuning)
safe_sysctl net.ipv4.tcp_moderate_rcvbuf=1

# ARP cache tuning (for hosting many VMs)
safe_sysctl net.ipv4.neigh.default.gc_thresh1=2048
safe_sysctl net.ipv4.neigh.default.gc_thresh2=4096
safe_sysctl net.ipv4.neigh.default.gc_thresh3=8192

# IPv6 neighbor cache tuning (similar to ARP cache for IPv4)
safe_sysctl net.ipv6.neigh.default.gc_thresh1=2048
safe_sysctl net.ipv6.neigh.default.gc_thresh2=4096
safe_sysctl net.ipv6.neigh.default.gc_thresh3=8192

# Reverse path filtering (security: prevent IP spoofing)
safe_sysctl net.ipv4.conf.all.rp_filter=1
safe_sysctl net.ipv4.conf.default.rp_filter=1

# Security hardening
safe_sysctl net.ipv4.conf.all.accept_redirects=0
safe_sysctl net.ipv4.conf.default.accept_redirects=0
safe_sysctl net.ipv4.conf.all.send_redirects=0
safe_sysctl net.ipv4.conf.default.send_redirects=0
safe_sysctl net.ipv4.conf.all.accept_source_route=0
safe_sysctl net.ipv4.conf.default.accept_source_route=0
safe_sysctl net.ipv4.conf.all.log_martians=1

# IPv6 security hardening (same as IPv4)
safe_sysctl net.ipv6.conf.all.accept_redirects=0
safe_sysctl net.ipv6.conf.default.accept_redirects=0
safe_sysctl net.ipv6.conf.all.accept_source_route=0
safe_sysctl net.ipv6.conf.default.accept_source_route=0

# TCP additional tuning
safe_sysctl net.ipv4.tcp_ecn=1
safe_sysctl net.ipv4.tcp_max_tw_buckets=131072
safe_sysctl net.ipv4.tcp_fin_timeout=15
safe_sysctl net.ipv4.tcp_autocorking=1

# BPF JIT for eBPF performance
safe_sysctl net.core.bpf_jit_enable=1

# File descriptor limits for network services
safe_sysctl fs.file-max=2097152

# Enable BBR congestion control if available
if modprobe tcp_bbr 2>/dev/null; then
    sysctl -w net.core.default_qdisc=fq || true
    sysctl -w net.ipv4.tcp_congestion_control=bbr || true
fi

# MSS clamping to fix TLS handshake failures over NAT (Path MTU Discovery issues)
# This prevents fragmentation issues that cause connection resets during TLS handshakes
echo "  → Setting up MSS clamping for PMTU..."
if ! iptables -t mangle -C FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null; then
    iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
    echo "  ✓ MSS clamping configured (IPv4)"
else
    echo "  ✓ MSS clamping already configured (IPv4)"
fi

# IPv6 MSS clamping (same reason - Path MTU issues with IPv6)
if [ "$IP6TABLES_AVAILABLE" = true ]; then
    if ! ip6tables -t mangle -C FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null; then
        ip6tables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
        echo "  ✓ MSS clamping configured (IPv6)"
    else
        echo "  ✓ MSS clamping already configured (IPv6)"
    fi
fi

# IPv4 NAT for VM outbound connectivity
echo "  → Setting up IPv4 NAT..."

# Detect default interface for IPv4
DEFAULT_IFACE_V4=$(ip route | grep default | awk '{print $5}' | head -n1)

if [ -z "$DEFAULT_IFACE_V4" ] || [ "$DEFAULT_IFACE_V4" = "lo" ]; then
    echo "  ⚠ No IPv4 default route found - skipping IPv4 NAT"
else
    echo "  → Default IPv4 interface: $DEFAULT_IFACE_V4"
    
    # Add IPv4 NAT rule (subnet-based)
    if ! iptables -t nat -C POSTROUTING -s 172.20.0.0/24 -o "$DEFAULT_IFACE_V4" -j MASQUERADE 2>/dev/null; then
        iptables -t nat -A POSTROUTING -s 172.20.0.0/24 -o "$DEFAULT_IFACE_V4" -j MASQUERADE
        echo "  ✓ IPv4 NAT configured for $DEFAULT_IFACE_V4"
    else
        echo "  ✓ IPv4 NAT already configured"
    fi
fi

# Ensure bridge exists before any br0-referencing rules
if ! ip link show br0 >/dev/null 2>&1; then
    echo "  → Bridge br0 does not exist, creating it..."
    ip link add name br0 type bridge
    ip link set br0 up
    echo "  ✓ Bridge br0 created"
fi

# IPv6 NAT (NAT66) for VM outbound connectivity
echo "  → Setting up IPv6 NAT (NAT66)..."

# Detect default interface for IPv6 (don't hardcode eth0)
# Parse route format: "default via fe80::1 dev eth0" or "default dev eth0"
DEFAULT_IFACE=$(ip -6 route show default 2>/dev/null | awk '/default/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')

# Always configure IPv6 FORWARD rules for VM-to-VM and VM-to-host traffic
if [ "$IP6TABLES_AVAILABLE" = true ]; then
    if ! ip6tables -C FORWARD -i br0 -j ACCEPT 2>/dev/null; then
        ip6tables -A FORWARD -i br0 -j ACCEPT
        echo "  ✓ IPv6 FORWARD (inbound) configured"
    else
        echo "  ✓ IPv6 FORWARD (inbound) already configured"
    fi
    if ! ip6tables -C FORWARD -o br0 -j ACCEPT 2>/dev/null; then
        ip6tables -A FORWARD -o br0 -j ACCEPT
        echo "  ✓ IPv6 FORWARD (outbound) configured"
    else
        echo "  ✓ IPv6 FORWARD (outbound) already configured"
    fi
fi

# Only configure IPv6 NAT if there's internet IPv6 connectivity
if [ "$IP6TABLES_AVAILABLE" = false ] || [ "$IP6TABLES_NAT_AVAILABLE" = false ]; then
    echo "  ⚠ Skipping IPv6 NAT (ip6tables NAT unavailable)"
elif [ -z "$DEFAULT_IFACE" ] || [ "$DEFAULT_IFACE" = "lo" ]; then
    echo "  ⚠ No IPv6 default route found - skipping IPv6 NAT (internet)"
    echo "    (IPv6 will work for VM-to-host and VM-to-VM, but not external IPv6)"
else
    echo "  → Default IPv6 interface: $DEFAULT_IFACE"
    
    # Add IPv6 NAT rule (interface-based)
    if ! ip6tables -t nat -C POSTROUTING -o "$DEFAULT_IFACE" -j MASQUERADE 2>/dev/null; then
        ip6tables -t nat -A POSTROUTING -o "$DEFAULT_IFACE" -j MASQUERADE
        echo "  ✓ IPv6 NAT (interface) configured for $DEFAULT_IFACE"
    else
        echo "  ✓ IPv6 NAT (interface) already configured"
    fi
    
    # Add subnet-based NAT for fd00:172:20::/64 (matches IPv4 pattern)
    if ! ip6tables -t nat -C POSTROUTING -s fd00:172:20::/64 -o "$DEFAULT_IFACE" -j MASQUERADE 2>/dev/null; then
        ip6tables -t nat -A POSTROUTING -s fd00:172:20::/64 -o "$DEFAULT_IFACE" -j MASQUERADE
        echo "  ✓ IPv6 NAT (subnet) configured for fd00:172:20::/64"
    else
        echo "  ✓ IPv6 NAT (subnet) already configured"
    fi
fi

# IPv4 FORWARD rules for bridge (should match IPv6)
echo "  → Setting up IPv4 forwarding rules..."
if ! iptables -C FORWARD -i br0 -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -i br0 -j ACCEPT
    echo "  ✓ IPv4 FORWARD (inbound) configured"
else
    echo "  ✓ IPv4 FORWARD (inbound) already configured"
fi
if ! iptables -C FORWARD -o br0 -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -o br0 -j ACCEPT
    echo "  ✓ IPv4 FORWARD (outbound) configured"
else
    echo "  ✓ IPv4 FORWARD (outbound) already configured"
fi

# Assign IPv6 address to br0 (ULA range for VM network)
echo "  → Configuring IPv6 on br0..."

# Assign IPv4 if not already assigned
if ! ip -4 addr show dev br0 | grep -q "172.20.0.1"; then
    ip addr add 172.20.0.1/24 dev br0
    echo "  ✓ IPv4 address assigned to br0: 172.20.0.1/24"
else
    echo "  ✓ IPv4 already configured on br0"
fi

# Assign IPv6 if not already assigned
if ! ip -6 addr show dev br0 | grep -q "fd00:172:20::1"; then
    ip addr add fd00:172:20::1/64 dev br0
    echo "  ✓ IPv6 address assigned to br0: fd00:172:20::1/64"
else
    echo "  ✓ IPv6 already configured on br0"
fi

# Persist all settings
SYSCTL_CONF="/etc/sysctl.d/99-firecracker-nat.conf"
cat > "$SYSCTL_CONF" << 'EOF'
# Firecracker VM Network Tuning for Agentic Sandboxes
# Based on industry best practices from CodeSandbox, Replit, Manus, E2B, Modal, Fly.io

# === IP Forwarding (REQUIRED for NAT) ===
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1
net.ipv4.conf.default.forwarding = 1

# IPv6 forwarding (for dual-stack support)
net.ipv6.conf.all.forwarding = 1
net.ipv6.conf.default.forwarding = 1

# === Connection Tracking ===
# Increase conntrack table size to prevent "table full" errors with many concurrent connections
net.netfilter.nf_conntrack_max = 262144

# TCP established timeout: 1 hour (supports long API calls, WebSockets, SSE, large transfers)
net.netfilter.nf_conntrack_tcp_timeout_established = 3600

# TCP time_wait timeout: 30 seconds (quick cleanup of closed connections)
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30

# TCP close_wait timeout: 30 seconds
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 30

# TCP fin_wait timeout: 60 seconds
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 60

# === TCP Keepalive ===
# Keep long-running connections alive (WebSockets, SSE, long-polling)
# Send first keepalive probe after 60 seconds of idle time
net.ipv4.tcp_keepalive_time = 60

# Send probes every 10 seconds after initial probe
net.ipv4.tcp_keepalive_intvl = 10

# Close connection after 3 failed probes (total: 60s + 3*10s = 90s)
net.ipv4.tcp_keepalive_probes = 3

# === Socket Buffers ===
# Increase max buffer sizes for better throughput on large transfers
# 16MB max (4x default) - improves API responses, file transfers, streaming
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 262144
net.core.wmem_default = 262144

# TCP auto-tuning buffers (min, default, max)
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# UDP buffer sizes for DNS and real-time protocols
net.ipv4.udp_rmem_min = 8192
net.ipv4.udp_wmem_min = 8192

# === Port Range and Reuse ===
# Expand ephemeral port range for many concurrent outbound connections
# Agents make numerous API calls, database connections, HTTP requests
net.ipv4.ip_local_port_range = 10000 65535

# TIME_WAIT socket reuse - CRITICAL for sandboxes with rapid connection cycling
# Prevents port exhaustion when dev servers restart frequently
net.ipv4.tcp_tw_reuse = 1

# Reduce FIN_TIMEOUT for faster port recycling (default: 60s)
net.ipv4.tcp_fin_timeout = 15

# === Connection Backlog ===
# Increase SYN backlog to handle connection bursts (dev server hot reload, parallel requests)
net.ipv4.tcp_max_syn_backlog = 8192

# Maximum socket listen() backlog
net.core.somaxconn = 4096

# Network device backlog queue length
net.core.netdev_max_backlog = 5000

# === TCP Performance Features ===
# TCP window scaling: essential for high-bandwidth connections
net.ipv4.tcp_window_scaling = 1

# TCP timestamps: better RTT estimation and PAWS protection
net.ipv4.tcp_timestamps = 1

# Selective ACK: faster recovery from packet loss
net.ipv4.tcp_sack = 1

# Don't cache TCP metrics (better for sandboxes with changing network conditions)
net.ipv4.tcp_no_metrics_save = 1

# Disable slow start after idle: better for interactive sessions (terminals, dev tools)
net.ipv4.tcp_slow_start_after_idle = 0

# TCP Fast Open: reduce latency for repeated connections (3 = enable for client+server)
net.ipv4.tcp_fastopen = 3

# === Security ===
# Reverse path filtering (prevent IP spoofing)
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Security hardening: disable redirects and source routing
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0

# Log martian packets (impossible addresses) for debugging
net.ipv4.conf.all.log_martians = 1

# SYN cookies: protection against SYN flood attacks
net.ipv4.tcp_syncookies = 1

# Reduce SYN-ACK retries for faster timeout on bad connections (default: 5)
net.ipv4.tcp_synack_retries = 2

# Reduce SYN retries for faster failure detection (default: 6)
net.ipv4.tcp_syn_retries = 2

# Abort connection on overflow instead of silently dropping
net.ipv4.tcp_abort_on_overflow = 1

# === TCP Advanced Features ===
# TCP ECN (Explicit Congestion Notification) - modern congestion management
# Used by Google, Cloudflare - better than packet loss for signaling
net.ipv4.tcp_ecn = 1

# TCP autocorking - better packet coalescing (reduces small packets)
net.ipv4.tcp_autocorking = 1

# Maximum TIME_WAIT buckets - prevents TIME_WAIT table overflow
net.ipv4.tcp_max_tw_buckets = 131072

# === Memory Management ===
# TCP memory limits (min, default, max in pages) - prevents memory exhaustion
# Values computed based on system RAM: ~1%, ~2%, ~3%
net.ipv4.tcp_mem = 98304 196608 393216

# TCP orphan socket limit (half-closed/abandoned connections)
net.ipv4.tcp_max_orphans = 16384

# === Connection Tracking Hash ===
# Hash table buckets (should be conntrack_max / 4 for optimal performance)
net.netfilter.nf_conntrack_buckets = 65536

# === Network Path Optimization ===
# Enable Path MTU Discovery (better for cloud/varied network paths)
net.ipv4.ip_no_pmtu_disc = 0

# TCP moderate receive buffer (enhanced auto-tuning)
net.ipv4.tcp_moderate_rcvbuf = 1

# === ARP Cache (for multi-VM hosts) ===
# Increase ARP cache thresholds to handle many VMs
net.ipv4.neigh.default.gc_thresh1 = 2048
net.ipv4.neigh.default.gc_thresh2 = 4096
net.ipv4.neigh.default.gc_thresh3 = 8192

# === Connection Tracking Hash ===
# Hash table buckets (should be conntrack_max / 4 for optimal performance)
net.netfilter.nf_conntrack_buckets = 65536

# === Network Path Optimization ===
# Enable Path MTU Discovery (better for cloud/varied network paths)
net.ipv4.ip_no_pmtu_disc = 0

# TCP moderate receive buffer (enhanced auto-tuning)
net.ipv4.tcp_moderate_rcvbuf = 1

# === ARP Cache (for multi-VM hosts) ===
# Increase ARP cache thresholds to handle many VMs
net.ipv4.neigh.default.gc_thresh1 = 2048
net.ipv4.neigh.default.gc_thresh2 = 4096
net.ipv4.neigh.default.gc_thresh3 = 8192

# === System Limits ===
# File descriptor limit (critical for high-connection workloads)
fs.file-max = 2097152

# BPF JIT compiler (performance for eBPF-based networking)
net.core.bpf_jit_enable = 1

# === BBR Congestion Control ===
# Google's BBR algorithm optimized for cloud/VM environments
# Better performance under varying network conditions than cubic
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# === IPv6 Optimization ===
# Accept Router Advertisements on external interfaces (for global IPv6)
net.ipv6.conf.default.accept_ra = 1

# IPv6 neighbor cache tuning (similar to ARP cache for IPv4)
net.ipv6.neigh.default.gc_thresh1 = 2048
net.ipv6.neigh.default.gc_thresh2 = 4096
net.ipv6.neigh.default.gc_thresh3 = 8192
EOF

echo "  ✓ Network tuning configured (production sandbox-grade):"
echo "    - IP forwarding: enabled (IPv4 + IPv6 NAT)"
echo "    - Connection tracking: 262K max, 65K hash buckets, 1h established"
echo "    - TCP memory: dynamic (1-3% RAM), 16K orphan, 131K TW buckets"
echo "    - TCP keepalive: 60s idle, 10s interval, 3 probes"
echo "    - Socket buffers: 16MB max, auto-tuning, moderate rcvbuf"
echo "    - UDP buffers: 8KB min"
echo "    - Ephemeral ports: 10000-65535, TIME_WAIT reuse, 15s FIN"
echo "    - Connection backlog: 8K SYN, 4K listen, 5K device"
echo "    - TCP features: ECN, autocorking, PMTU, scaling, timestamps, SACK"
echo "    - Security: rp_filter, no redirects/source routing, martian logging"
echo "    - ARP/IPv6 neighbor cache: 2K-8K entries"
echo "    - File descriptors: 2M max"
echo "    - BPF JIT: enabled"
echo "    - Congestion control: BBR"
echo ""
echo "  ⚠ IPv6 NAT rules need persistence:"
echo "    Install iptables-persistent: apt-get install iptables-persistent"
echo "    Save rules: ip6tables-save > /etc/iptables/rules.v6"

echo ""
echo "Step 2: Configuring DNS proxy..."
echo "-----------------------------------------------"

# Check if running in Docker
if [ -f /.dockerenv ] || grep -q docker /proc/1/cgroup 2>/dev/null; then
    echo "  ℹ  Detected Docker environment - using iptables DNS forwarding to public DNS"
    
    # Docker's embedded DNS (127.0.0.11) doesn't listen on a socket that iptables can forward to
    # It's integrated into Docker's network stack and only works for container processes
    # Solution: Forward DNS directly to public DNS servers (Google DNS)
    PUBLIC_DNS="8.8.8.8"
    
    echo "  → Forwarding DNS to: $PUBLIC_DNS"
    
    # Forward DNS queries from br0 (172.20.0.1:53) to public DNS
    # This allows VMs to use 172.20.0.1 as their DNS server
    
    # UDP DNS (port 53) - idempotent
    if ! iptables -t nat -C PREROUTING -i br0 -p udp --dport 53 -j DNAT --to-destination ${PUBLIC_DNS}:53 2>/dev/null; then
        iptables -t nat -A PREROUTING -i br0 -p udp --dport 53 -j DNAT --to-destination ${PUBLIC_DNS}:53
    fi
    
    # TCP DNS (port 53) - idempotent
    if ! iptables -t nat -C PREROUTING -i br0 -p tcp --dport 53 -j DNAT --to-destination ${PUBLIC_DNS}:53 2>/dev/null; then
        iptables -t nat -A PREROUTING -i br0 -p tcp --dport 53 -j DNAT --to-destination ${PUBLIC_DNS}:53
    fi
    
    # Allow DNS traffic through FORWARD chain - idempotent
    if ! iptables -C FORWARD -i br0 -p udp --dport 53 -j ACCEPT 2>/dev/null; then
        iptables -A FORWARD -i br0 -p udp --dport 53 -j ACCEPT
    fi
    if ! iptables -C FORWARD -i br0 -p tcp --dport 53 -j ACCEPT 2>/dev/null; then
        iptables -A FORWARD -i br0 -p tcp --dport 53 -j ACCEPT
    fi
    
    echo "  ✓ DNS forwarding configured (br0 → ${PUBLIC_DNS})"
    echo "  ✓ VMs can use 172.20.0.1 as DNS server"
    
    # Skip dnsmasq configuration in Docker
    SKIP_DNSMASQ=1
else
    echo "  ℹ  Native environment - configuring dnsmasq"
    SKIP_DNSMASQ=0
fi

if [ "$SKIP_DNSMASQ" = "0" ]; then
    # Update dnsmasq configuration (enable DNS proxy on port 53)
    cat > /etc/dnsmasq.d/firecracker-vms.conf << 'EOF'
# DHCP configuration for Firecracker VMs
# Only listen on br0 interface
interface=br0
bind-interfaces
except-interface=lo

# Listen on both IPv4 and IPv6
listen-address=172.20.0.1
listen-address=fd00:172:20::1
listen-address=::1

# Don't read /etc/resolv.conf or /etc/hosts
no-resolv
no-hosts

# DHCP settings for VM network (172.20.0.0/24)
dhcp-range=172.20.0.2,172.20.0.254,12h
dhcp-option=3,172.20.0.1
dhcp-option=6,8.8.8.8,8.8.4.4

# IPv6 DHCP and Router Advertisement
enable-ra
dhcp-range=fd00:172:20::2,fd00:172:20::254,64,12h

# DNS proxy configuration
# Listen on port 53 and forward to upstream DNS (IPv4 and IPv6)
server=8.8.8.8
server=8.8.4.4
server=1.1.1.1
server=2001:4860:4860::8888
server=2001:4860:4860::8844
cache-size=1000
EOF

    echo "  ✓ dnsmasq configuration updated"

    # Check if dnsmasq is installed
    if ! command -v dnsmasq &> /dev/null; then
        echo "  ✗ dnsmasq not found - run setup-firecracker.sh first"
        exit 1
    fi

    # Restart dnsmasq
    if systemctl restart dnsmasq 2>/dev/null; then
        echo "  ✓ dnsmasq restarted successfully"
    else
        echo "  ✗ Failed to restart dnsmasq (check: systemctl status dnsmasq)"
        exit 1
    fi

    # Verify dnsmasq is running
    if systemctl is-active --quiet dnsmasq; then
        echo "  ✓ dnsmasq DNS proxy active on br0 (172.20.0.1:53)"
    else
        echo "  ⚠ dnsmasq is not running"
    fi
fi

echo ""
echo "Step 3: Configuring DNS in VM rootfs..."
echo "-----------------------------------------------"

# Create temporary mount directory
mkdir -p "$MOUNT_DIR"

# Check if already mounted (idempotency)
if mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
    echo "  ⚠ $MOUNT_DIR already mounted, unmounting first..."
    umount "$MOUNT_DIR" || umount -l "$MOUNT_DIR" || true
fi

# Mount the rootfs image
if ! mount -o loop "$ROOTFS_IMAGE" "$MOUNT_DIR"; then
    echo "  ✗ Failed to mount rootfs (is it already mounted elsewhere?)"
    echo "  → Check: lsblk | grep ubuntu.ext4"
    exit 1
fi

echo "  ✓ Rootfs mounted at $MOUNT_DIR"

# Update systemd-networkd configuration
cat > "$MOUNT_DIR/etc/systemd/network/50-eth0.network" << 'EOF'
[Match]
Name=eth0

[Network]
# IP is configured via kernel boot parameter (ip= in firecracker-config.ts)
# KeepConfiguration preserves the kernel-configured IP address
KeepConfiguration=static

# Gateway is always the bridge IP (static)
Gateway=172.20.0.1

# DNS configuration (dnsmasq on br0)
DNS=172.20.0.1
DNS=fd00:172:20::1

# Enable IPv6 Router Advertisement and link-local addressing
IPv6AcceptRA=yes
LinkLocalAddressing=yes

[Link]
# Ensure interface comes up
RequiredForOnline=yes
EOF

echo "  ✓ Updated /etc/systemd/network/50-eth0.network (kernel IP + explicit gateway + dual-stack DNS)"

# Update resolv.conf
# Remove immutable flag if set
chattr -i "$MOUNT_DIR/etc/resolv.conf" 2>/dev/null || true
rm -f "$MOUNT_DIR/etc/resolv.conf"

# Detect if running in Docker (check for /.dockerenv or Docker cgroup)
DOCKER_DNS=""
if [ -f /.dockerenv ] || grep -q docker /proc/1/cgroup 2>/dev/null; then
    # Running in Docker - use Docker's DNS resolver
    DOCKER_DNS=$(grep "^nameserver" /etc/resolv.conf | head -1 | awk '{print $2}')
    if [ -z "$DOCKER_DNS" ]; then
        DOCKER_DNS="127.0.0.11"  # Docker's default DNS
    fi
    echo "  ℹ  Detected Docker environment - using Docker DNS: $DOCKER_DNS"
fi

if [ -n "$DOCKER_DNS" ]; then
    # Docker environment - forward to public DNS (Docker's 127.0.0.11 doesn't accept forwarded packets)
    cat > "$MOUNT_DIR/etc/resolv.conf" << EOF
# DNS configuration for Firecracker VM (Docker environment)
# DNS forwarded from 172.20.0.1 to public DNS (8.8.8.8)
nameserver 172.20.0.1
# Fallback to public DNS
nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1
EOF
else
    # Native environment (WSL/Ubuntu) - use dnsmasq on br0
    cat > "$MOUNT_DIR/etc/resolv.conf" << 'EOF'
# Static DNS configuration for Firecracker VM
# Use dnsmasq on br0 as DNS proxy (IPv4 primary, IPv6 fallback)
nameserver 172.20.0.1
nameserver fd00:172:20::1
EOF
fi

# Make it immutable so systemd-networkd doesn't overwrite it
chattr +i "$MOUNT_DIR/etc/resolv.conf" 2>/dev/null || true

echo "  ✓ Updated /etc/resolv.conf"

# IPv6 configuration for VM
cat > "$MOUNT_DIR/etc/sysctl.d/99-vm-network.conf" << 'EOF'
# Enable IPv6 (dual-stack configuration)
net.ipv6.conf.all.disable_ipv6 = 0
net.ipv6.conf.default.disable_ipv6 = 0
net.ipv6.conf.eth0.disable_ipv6 = 0

# IPv6 privacy extensions (optional - improves privacy for outbound connections)
net.ipv6.conf.eth0.use_tempaddr = 2
EOF

echo "  ✓ IPv6 enabled in VM (dual-stack)"

# Unmount rootfs
if ! umount "$MOUNT_DIR"; then
    echo "  ⚠ Failed to unmount rootfs, trying lazy unmount..."
    if ! umount -l "$MOUNT_DIR"; then
        echo "  ✗ Lazy unmount also failed - manual intervention needed"
        echo "  → Check: lsof | grep $MOUNT_DIR"
        exit 1
    fi
fi

rmdir "$MOUNT_DIR" 2>/dev/null || true

echo "  ✓ Rootfs unmounted"

# Disable trap since we're done
trap - ERR EXIT

echo ""
echo "=== DNS Configuration Complete ==="
echo ""
echo "Configuration summary:"
echo "  • IP forwarding: enabled (IPv4 + IPv6 NAT)"
echo "  • Connection tracking: 262K max, 65K hash, 1h established, 131K TW"
echo "  • TCP memory: 1-3% RAM, 16K orphan limit"
echo "  • TCP keepalive: 60s idle, 10s interval, 3 probes"
echo "  • Socket buffers: 16MB max, auto-tuning, moderate rcvbuf"
echo "  • Ephemeral ports: 10000-65535, TIME_WAIT reuse, 15s FIN"
echo "  • Connection backlog: 8K SYN, 4K listen, 5K device"
echo "  • TCP features: ECN, autocorking, PMTU, scaling, timestamps, SACK"
echo "  • Security: rp_filter, no redirects, martian logging, SYN cookies"
echo "  • ARP cache: 2K-8K, File descriptors: 2M, BPF JIT: on"
echo "  • Congestion: BBR"
echo "  • Host IPv4: br0 (172.20.0.1/24)"
echo "  • Host IPv6: br0 (fd00:172:20::1/64)"
echo "  • VM IPv4: eth0 (172.20.0.2/24)"
echo "  • VM IPv6: eth0 (fd00:172:20::2/64)"
echo "  • DNS: dnsmasq (IPv4: 172.20.0.1, IPv6: fd00:172:20::1)"
echo "  • Upstream DNS: 8.8.8.8, 8.8.4.4, 1.1.1.1, 2001:4860:4860::8888"
echo ""
echo "Next steps:"
echo "  1. Restart any running VMs to pick up the new configuration"
echo "  2. Test inside VM: curl -v https://www.google.com"
echo ""
