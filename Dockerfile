# syntax=docker/dockerfile:1.5
# Dockerfile for VM Orchestrator
# Runs Firecracker microVMs with full networking isolation

FROM ubuntu:22.04

# Prevent interactive prompts during build
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y \
        curl \
        wget \
        sudo \
        iproute2 \
        iptables \
        dnsmasq \
        kmod \
        socat \
        net-tools \
        build-essential \
        e2fsprogs \
        zstd \
        jq \
        unzip \
        debootstrap \
        busybox-static \
        cpio \
    && rm -rf /var/lib/apt/lists/*

# Install bun (cached installer with integrity check)
RUN --mount=type=cache,target=/opt/firecracker/cache \
        --mount=type=cache,target=/root/.bun/install/cache \
        BUN_INSTALLER=/opt/firecracker/cache/bun-install.sh \
        && BUN_INSTALLER_SHA=${BUN_INSTALLER}.sha256 \
        && if [ -f "$BUN_INSTALLER" ] && [ -f "$BUN_INSTALLER_SHA" ]; then \
                 STORED_SHA=$(cat "$BUN_INSTALLER_SHA"); \
                 CURRENT_SHA=$(sha256sum "$BUN_INSTALLER" | cut -d' ' -f1); \
                 if [ "$STORED_SHA" != "$CURRENT_SHA" ]; then \
                     rm -f "$BUN_INSTALLER" "$BUN_INSTALLER_SHA"; \
                 fi; \
             fi \
        && if [ ! -f "$BUN_INSTALLER" ]; then \
                 curl -fsSL --retry 3 --retry-all-errors --max-time 120 https://bun.sh/install -o "$BUN_INSTALLER"; \
                 sha256sum "$BUN_INSTALLER" | cut -d' ' -f1 > "$BUN_INSTALLER_SHA"; \
             fi \
        && if [ ! -f "$BUN_INSTALLER_SHA" ]; then \
                 sha256sum "$BUN_INSTALLER" | cut -d' ' -f1 > "$BUN_INSTALLER_SHA"; \
             fi \
        && export BUN_INSTALL=/root/.bun \
        && bash "$BUN_INSTALLER" \
        && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
        && bun --version

# Install Firecracker
WORKDIR /opt/firecracker
RUN --mount=type=cache,target=/opt/firecracker/cache \
        FIRECRACKER_TGZ=/opt/firecracker/cache/firecracker-v1.7.0-x86_64.tgz \
        FIRECRACKER_SHA=${FIRECRACKER_TGZ}.sha256 \
        && if [ -f "$FIRECRACKER_TGZ" ] && [ -f "$FIRECRACKER_SHA" ]; then \
                 STORED_SHA=$(cat "$FIRECRACKER_SHA"); \
                 CURRENT_SHA=$(sha256sum "$FIRECRACKER_TGZ" | cut -d' ' -f1); \
                 if [ "$STORED_SHA" != "$CURRENT_SHA" ]; then \
                     rm -f "$FIRECRACKER_TGZ" "$FIRECRACKER_SHA"; \
                 fi; \
             fi \
        && if [ ! -f "$FIRECRACKER_TGZ" ]; then \
                 wget --progress=bar:force --timeout=60 --tries=3 \
                     https://github.com/firecracker-microvm/firecracker/releases/download/v1.7.0/firecracker-v1.7.0-x86_64.tgz \
                     -O "$FIRECRACKER_TGZ"; \
                 sha256sum "$FIRECRACKER_TGZ" | cut -d' ' -f1 > "$FIRECRACKER_SHA"; \
             fi \
        && if [ ! -f "$FIRECRACKER_SHA" ]; then \
                 sha256sum "$FIRECRACKER_TGZ" | cut -d' ' -f1 > "$FIRECRACKER_SHA"; \
             fi \
        && tar -xzvf "$FIRECRACKER_TGZ" \
    && mv release-v1.7.0-x86_64/firecracker-v1.7.0-x86_64 /usr/local/bin/firecracker \
    && chmod +x /usr/local/bin/firecracker \
    && rm -rf release-v1.7.0-x86_64 \
    && firecracker --version

# Create Firecracker directories
RUN mkdir -p /opt/firecracker/{kernel,rootfs,projects,cache} \
    && mkdir -p /var/log/firecracker \
    && mkdir -p /sandboxes

# Download Kata Containers kernel (1.5GB - cached separately from extraction)
RUN --mount=type=cache,target=/opt/firecracker/cache \
        mkdir -p /opt/firecracker/cache \
        && cd /tmp \
        && KATA_URL="https://github.com/kata-containers/kata-containers/releases/download/3.24.0/kata-static-3.24.0-amd64.tar.zst" \
        && KATA_ARCHIVE=/opt/firecracker/cache/kata-static-3.24.0-amd64.tar.zst \
        && KATA_SHA=${KATA_ARCHIVE}.sha256 \
        && echo "Downloading from: $KATA_URL" \
        && if [ -f "$KATA_ARCHIVE" ] && [ -f "$KATA_SHA" ]; then \
                 STORED_SHA=$(cat "$KATA_SHA"); \
                 CURRENT_SHA=$(sha256sum "$KATA_ARCHIVE" | cut -d' ' -f1); \
                 if [ "$STORED_SHA" != "$CURRENT_SHA" ]; then \
                     rm -f "$KATA_ARCHIVE" "$KATA_SHA"; \
                 fi; \
             fi \
        && if [ ! -f "$KATA_ARCHIVE" ]; then \
                 wget --progress=bar:force --timeout=60 --tries=3 \
                     "$KATA_URL" -O "$KATA_ARCHIVE"; \
                 sha256sum "$KATA_ARCHIVE" | cut -d' ' -f1 > "$KATA_SHA"; \
             fi \
        && if [ ! -f "$KATA_SHA" ]; then \
                 sha256sum "$KATA_ARCHIVE" | cut -d' ' -f1 > "$KATA_SHA"; \
             fi \
        && ls -lh "$KATA_ARCHIVE"

# Extract kernel from archive (separate step so download is cached)
RUN --mount=type=cache,target=/opt/firecracker/cache \
    cd /tmp \
    && cp /opt/firecracker/cache/kata-static-3.24.0-amd64.tar.zst . \
    && echo "Extracting kernel from archive..." \
    && tar --zstd --wildcards -xvf kata-static-3.24.0-amd64.tar.zst "./opt/kata/share/kata-containers/vmlinux-*" \
    && echo "Finding kernel file..." \
    && KATA_KERNEL=$(find opt/kata/share/kata-containers/ -name "vmlinux-6.*.47-173" -type f | head -1) \
    && echo "Found: $KATA_KERNEL" \
    && test -n "$KATA_KERNEL" || (echo "ERROR: Kernel not found in archive" && exit 1) \
    && mkdir -p /opt/firecracker/kernel \
    && cp -v "$KATA_KERNEL" /opt/firecracker/kernel/vmlinux-6.12 \
    && rm -rf kata-static-3.24.0-amd64.tar.zst opt \
    && chmod 644 /opt/firecracker/kernel/vmlinux-6.12 \
    && ls -lh /opt/firecracker/kernel/vmlinux-6.12

# Set working directory
WORKDIR /app

# Copy vm-orchestrator package file (separate layer for better caching)
COPY vm-orchestrator/package.json ./vm-orchestrator/package.json

# Install vm-orchestrator dependencies only
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --cwd /app/vm-orchestrator --verbose --force

# Copy TypeScript config
COPY tsconfig.json ./

# Copy VM orchestrator code
COPY vm-orchestrator ./vm-orchestrator

# Copy setup scripts, common library, and entrypoint
COPY *.sh ./

# Convert Windows line endings to Unix (CRLF -> LF) for all shell scripts
RUN find . -maxdepth 1 -name "*.sh" -type f -exec sed -i 's/\r$//' {} \; \
    && chmod +x docker-entrypoint.sh \
    && mv docker-entrypoint.sh /docker-entrypoint.sh

# Create rootfs directory structure
RUN mkdir -p /opt/firecracker/rootfs

# Download pre-built rootfs artifact (optional, speeds up first startup)
# To build artifact: bash scripts/build-rootfs-artifact.sh
# Then upload to GitHub releases and set ROOTFS_ARTIFACT_URL build arg
ARG ROOTFS_ARTIFACT_URL=""
RUN if [ -n "$ROOTFS_ARTIFACT_URL" ]; then \
        echo "==========================================="; \
        echo "Downloading pre-built rootfs artifact..."; \
        echo "URL: $ROOTFS_ARTIFACT_URL"; \
        echo "==========================================="; \
        cd /opt/firecracker/rootfs && \
        wget --verbose --show-progress --progress=bar:force --timeout=300 --tries=3 "$ROOTFS_ARTIFACT_URL" -O ubuntu.ext4.zst && \
        echo ""; \
        echo "==========================================="; \
        echo "Extracting rootfs (this may take 2-3 minutes)..."; \
        echo "==========================================="; \
        zstd -d -v ubuntu.ext4.zst -o ubuntu.ext4 && \
        rm ubuntu.ext4.zst && \
        echo ""; \
        echo "✓ Pre-built rootfs installed: $(ls -lh ubuntu.ext4 | awk '{print $5}')"; \
    else \
        echo "ℹ No ROOTFS_ARTIFACT_URL provided"; \
        echo "Rootfs will be built on first container startup (~5-10 minutes)"; \
    fi

# Note: If no pre-built rootfs is provided, creation happens at container startup (docker-entrypoint.sh)
# because loop device mounting is not allowed during Docker build.
# All setup-*.sh scripts run during first container startup.

# Expose VM orchestrator port and file server port range
EXPOSE 3003
EXPOSE 10000-60000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3003/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
WORKDIR /app/vm-orchestrator
CMD ["bun", "--watch", "--watch-path", ".", "run", "index.ts"]
