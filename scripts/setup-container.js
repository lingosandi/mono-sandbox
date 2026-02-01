#!/usr/bin/env bun

import { spawn } from "child_process"

const MAX_ATTEMPTS = 3
const RETRY_DELAY = 5000 // 5 seconds

function pullImage(attempt) {
    return new Promise((resolve, reject) => {
        console.log(`\nAttempt ${attempt}/${MAX_ATTEMPTS}: Pulling image...`)
        
        const proc = spawn("docker", ["pull", "ghcr.io/lingosandi/mono-sandbox:latest"], {
            stdio: "inherit",
            shell: true
        })
        
        proc.on("close", (code) => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`Docker pull failed with code ${code}`))
            }
        })
        
        proc.on("error", (err) => {
            reject(err)
        })
    })
}

async function main() {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await pullImage(attempt)
            console.log("\n✓ Image pulled successfully!")
            process.exit(0)
        } catch (error) {
            if (attempt < MAX_ATTEMPTS) {
                console.log(`\n✗ Pull failed: ${error.message}`)
                console.log(`Retrying in ${RETRY_DELAY / 1000} seconds...`)
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY))
            } else {
                console.error(`\n✗ Failed to pull image after ${MAX_ATTEMPTS} attempts`)
                process.exit(1)
            }
        }
    }
}

main()
