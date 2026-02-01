# Mono Sandbox

Full-stack sandbox environment with Next.js IDE and Firecracker microVMs.

## Requirements

- **Bun**: Latest version ([install](https://bun.sh))
- **Docker**: 20.10+ with Docker Compose ([install](https://docs.docker.com/get-docker/))

## Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Start Backend (VM Orchestrator)

```bash
docker pull ghcr.io/lingosandi/mono-sandbox:latest
docker compose -f docker-compose.prod.yml up -d
```

### 3. Start Frontend (Next.js)

```bash
bun build
bun start
```

### 4. Access

- **IDE**: http://localhost:3002