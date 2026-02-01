#!/bin/bash
set -euo pipefail

# Rootfs Artifact Builder
# Builds a complete rootfs by running docker compose build + up, then extracts and compresses it
# Usage: bash scripts/build-rootfs-artifact.sh [output-dir]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-$PROJECT_ROOT/rootfs-artifacts}"
CONTAINER_NAME="mono-sandbox-vm-orchestrator-1"

echo "==================================================="
echo "Rootfs Artifact Builder"
echo "==================================================="
echo ""
echo "Project root: $PROJECT_ROOT"
echo "Output directory: $OUTPUT_DIR"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"

cd "$PROJECT_ROOT"

# Step 1: Build the Docker image
echo "[1/6] Building Docker image..."
if ! docker compose build; then
    echo "ERROR: Docker compose build failed"
    exit 1
fi
echo "✓ Image built"
echo ""

# Step 2: Start container to trigger rootfs creation
echo "[2/6] Starting container (this will build the rootfs, ~5-10 minutes)..."
echo "Note: Container will build rootfs on first startup"
echo "Streaming logs from container..."
echo "=========================================="
if ! docker compose up -d; then
    echo "ERROR: Failed to start container"
    exit 1
fi

# Step 3: Monitor logs and wait for completion
echo ""
echo "[3/6] Building rootfs (monitoring logs)..."
echo "=========================================="

# Wait up to 30 minutes for rootfs creation
TIMEOUT=1800
ELAPSED=0
INTERVAL=3
LAST_LOG_LINE=""
ROOTFS_READY=false
SERVICE_STARTED=false

while [ $ELAPSED -lt $TIMEOUT ]; do
    # Get all logs to check for completion signals
    CURRENT_LOGS=$(docker compose logs vm-orchestrator 2>&1)
    
    # Show recent changes (last 10 lines) if they changed
    CURRENT_TAIL=$(echo "$CURRENT_LOGS" | tail -10)
    if [ "$CURRENT_TAIL" != "$LAST_LOG_LINE" ]; then
        echo "$CURRENT_TAIL" | tail -5  # Show last 5 lines only
        LAST_LOG_LINE="$CURRENT_TAIL"
    fi
    
    # Check if rootfs already existed (docker-entrypoint.sh prints this)
    if echo "$CURRENT_LOGS" | grep -q "✓ Rootfs already exists:"; then
        if [ "$ROOTFS_READY" = false ]; then
            echo "→ Rootfs already exists (from previous run)!"
            ROOTFS_READY=true
        fi
    fi
    
    # Check if rootfs was just created (docker-entrypoint.sh prints this)
    if echo "$CURRENT_LOGS" | grep -q "✓ Rootfs ready:"; then
        if [ "$ROOTFS_READY" = false ]; then
            echo "→ Rootfs creation completed!"
            ROOTFS_READY=true
        fi
    fi
    
    # Check if service started
    if echo "$CURRENT_LOGS" | grep -q "Service started successfully"; then
        if [ "$SERVICE_STARTED" = false ]; then
            echo "→ Service startup detected..."
            SERVICE_STARTED=true
        fi
    fi
    
    # Both conditions met - we're done!
    if [ "$SERVICE_STARTED" = true ] && [ "$ROOTFS_READY" = true ]; then
        echo ""
        echo "=========================================="
        echo "✓ VM Orchestrator started successfully!"
        echo "✓ Rootfs is ready!"
        break
    fi
    
    # Show debug info occasionally
    if [ $((ELAPSED % 15)) -eq 0 ]; then
        if [ "$ROOTFS_READY" = false ]; then
            echo "→ Waiting for rootfs... (${ELAPSED}s elapsed)"
        elif [ "$SERVICE_STARTED" = false ]; then
            echo "→ Waiting for service to start... (${ELAPSED}s elapsed)"
        fi
    fi
    
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
done

if [ $ELAPSED -ge $TIMEOUT ]; then
    echo ""
    echo "ERROR: Rootfs creation timed out after ${TIMEOUT}s"
    echo "Debug: SERVICE_STARTED=$SERVICE_STARTED, ROOTFS_READY=$ROOTFS_READY"
    exit 1
fi
echo ""

# Step 4: Extract rootfs from container
echo "[4/6] Extracting rootfs from container..."
TEMP_ROOTFS="$OUTPUT_DIR/ubuntu.ext4"

# Get container rootfs size first to show progress context
CONTAINER_SIZE=$(docker compose exec -T vm-orchestrator du -h /opt/firecracker/rootfs/ubuntu.ext4 2>/dev/null | cut -f1 || echo "~4GB")
echo "Extracting $CONTAINER_SIZE file..."
echo ""

# Use docker cp directly (tar method has issues on Windows/Git Bash)
if ! docker compose cp vm-orchestrator:/opt/firecracker/rootfs/ubuntu.ext4 "$TEMP_ROOTFS"; then
    echo "ERROR: Failed to extract rootfs from container"
    exit 1
fi

ROOTFS_SIZE=$(du -h "$TEMP_ROOTFS" | cut -f1)
echo ""
echo "✓ Extracted rootfs: $ROOTFS_SIZE"
echo ""

# Step 5: Compress rootfs
echo "[5/6] Compressing rootfs with zstd (high compression)..."
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
VERSION="v1.0.0"
OUTPUT_FILE="$OUTPUT_DIR/ubuntu-rootfs-${VERSION}-${TIMESTAMP}.ext4.zst"


# Check if zstd is installed
if ! command -v zstd >/dev/null 2>&1; then
    echo ""
    echo "ERROR: zstd is not installed!"
    echo ""
    echo "Please install zstd:"
    echo "  Windows (with Chocolatey): choco install zstandard"
    echo "  Windows (with Scoop): scoop install zstd"
    echo "  macOS: brew install zstd"
    echo "  Linux: apt install zstd  or  yum install zstd"
    echo ""
    echo "Or download from: https://github.com/facebook/zstd/releases"
    exit 1
fi

echo "Source: $TEMP_ROOTFS"
echo "Output: $(basename "$OUTPUT_FILE")"
echo "Compression level: 19 (maximum)"
echo ""

if ! zstd -19 -v --rm "$TEMP_ROOTFS" -o "$OUTPUT_FILE"; then
    echo "ERROR: Failed to compress rootfs"
    rm -f "$TEMP_ROOTFS"
    exit 1
fi

COMPRESSED_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo ""
echo "✓ Compressed: $COMPRESSED_SIZE"
echo ""

# Step 6: Generate checksums
echo "[6/6] Generating checksums..."
cd "$OUTPUT_DIR"
CHECKSUM_FILE="$(basename "$OUTPUT_FILE")"
echo "Calculating SHA256 for: $CHECKSUM_FILE"
echo "This may take a minute for large files..."
echo ""

sha256sum "$CHECKSUM_FILE" | tee "${CHECKSUM_FILE}.sha256"
echo ""
echo "✓ Checksum saved to: ${CHECKSUM_FILE}.sha256"
echo ""

# Stop container
echo "Stopping and removing containers..."
docker compose down -v

echo "==================================================="
echo "✓ Rootfs artifact created successfully!"
echo "==================================================="
echo ""
echo "Output files:"
echo "  → Compressed: $OUTPUT_FILE ($COMPRESSED_SIZE)"
echo "  → Checksum: $OUTPUT_FILE.sha256"
echo ""
echo "Next steps:"
echo "1. Upload these files to GitHub Releases"
echo "2. Update Dockerfile with the release URL"
echo "3. Users can now 'docker compose up' without waiting for rootfs build!"
echo ""
