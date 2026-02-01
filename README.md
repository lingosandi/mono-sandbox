# Mono Sandbox

Full-stack sandbox environment with Next.js IDE and Firecracker microVMs.

<p align="center">
  <em>in collaboration with</em>
  <br/>
  <img src="./public/mono-logo.jpg" alt="Mono" height="60">
  <span style="margin: 0 20px;">×</span>
  <img src="./public/agencize-logo.png" alt="Agencize" height="60">
</p>

## Requirements

- **Bun**: Latest version ([install](https://bun.sh))
- **Docker**: 20.10+ with Docker Compose ([install](https://docs.docker.com/get-docker/))

## Quick Start

### 1. Install Dependencies and Build Frontend

```bash
bun install
bun run build
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
bun start
```

### 5. Access

- **IDE**: http://localhost:3002