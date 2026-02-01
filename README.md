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

### 2. Setup Container (First Time Only)

```bash
bun setup-container
```

### 3. Start Container (VM Orchestrator)

```bash
bun start-container
```

### 4. Start Frontend (Next.js)

```bash
bun build
bun start
```

### 5. Access

- **IDE**: http://localhost:3002