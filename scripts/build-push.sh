#!/bin/bash
# Build and push Docker image with pre-built rootfs
# Usage: bash docker-build-push.sh
# Prerequisites: docker login ghcr.io -u lingosandi

set -e  # Exit on error

MAX_RETRIES=3
RETRY_DELAY=5

# Disable proxy for GHCR to avoid EOF errors
export HTTP_PROXY=""
export HTTPS_PROXY=""
export http_proxy=""
export https_proxy=""

retry_command() {
    local command_name=$1
    shift
    local attempt=1
    
    while [ $attempt -le $MAX_RETRIES ]; do
        echo "[$command_name] Attempt $attempt/$MAX_RETRIES..."
        
        if "$@"; then
            echo "[$command_name] ✓ Success"
            return 0
        fi
        
        if [ $attempt -lt $MAX_RETRIES ]; then
            echo "[$command_name] ✗ Failed, retrying in ${RETRY_DELAY}s..."
            sleep $RETRY_DELAY
        else
            echo "[$command_name] ✗ Failed after $MAX_RETRIES attempts"
            return 1
        fi
        
        attempt=$((attempt + 1))
    done
}

echo "Building Docker image with pre-built rootfs..."

retry_command "Docker Build" docker build \
  --build-arg ROOTFS_ARTIFACT_URL="https://github.com/lingosandi/mono-sandbox/releases/download/1.0.3/ubuntu-rootfs.ext4.zst" \
  -t ghcr.io/lingosandi/mono-sandbox:1.0.3 \
  -t ghcr.io/lingosandi/mono-sandbox:latest \
  .

echo ""
echo "Pushing to GitHub Container Registry..."

retry_command "Push 1.0.3" docker push ghcr.io/lingosandi/mono-sandbox:1.0.3
retry_command "Push latest" docker push ghcr.io/lingosandi/mono-sandbox:latest

echo ""
echo "✓ Done! Images pushed successfully."