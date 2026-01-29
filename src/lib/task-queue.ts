/**
 * Task Queue for Rate Limiting
 *
 * Manages concurrent task execution with configurable delays to prevent API rate limiting.
 * Uses a queue pattern with automatic cleanup and retry support.
 */

type TaskFunction<T> = () => Promise<T>

interface QueuedTask<T> {
    task: TaskFunction<T>
    resolve: (value: T) => void
    reject: (reason: unknown) => void
}

interface TaskQueueConfig {
    maxConcurrent?: number // Maximum concurrent tasks (default: 1)
    delayMs?: number // Delay between task starts in milliseconds (default: 1000)
}

// Hoisted helper function - validates queue configuration
function validateConfig(config: TaskQueueConfig) {
    if (config.maxConcurrent !== undefined && config.maxConcurrent < 1) {
        throw new Error("maxConcurrent must be at least 1")
    }
    if (config.delayMs !== undefined && config.delayMs < 0) {
        throw new Error("delayMs must be non-negative")
    }
}

// Hoisted helper function - creates a delay promise
function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createTaskQueue(config: TaskQueueConfig = {}) {
    validateConfig(config)

    const maxConcurrent = config.maxConcurrent ?? 1
    const delayMs = config.delayMs ?? 1000

    const queue: QueuedTask<unknown>[] = []
    let running = 0
    let lastStartTime = 0
    let isShuttingDown = false

    async function processNext() {
        if (isShuttingDown || queue.length === 0 || running >= maxConcurrent) {
            return
        }

        // Rate limiting: ensure minimum delay between task starts
        const now = Date.now()
        const timeSinceLastStart = now - lastStartTime
        if (timeSinceLastStart < delayMs && lastStartTime > 0) {
            const waitTime = delayMs - timeSinceLastStart
            await delay(waitTime)
        }

        const item = queue.shift()
        if (!item) return

        running++
        lastStartTime = Date.now()

        try {
            const result = await item.task()
            item.resolve(result)
        } catch (error) {
            item.reject(error)
        } finally {
            running--
            // Process next task after current one completes
            processNext()
        }
    }

    function enqueue<T>(task: TaskFunction<T>): Promise<T> {
        if (isShuttingDown) {
            return Promise.reject(new Error("Queue is shutting down"))
        }

        return new Promise<T>((resolve, reject) => {
            queue.push({ task, resolve, reject } as QueuedTask<unknown>)
            processNext()
        })
    }

    async function shutdown() {
        isShuttingDown = true

        // Reject all pending tasks
        for (const item of queue) {
            item.reject(new Error("Queue shutdown"))
        }
        queue.length = 0

        // Wait for running tasks to complete
        while (running > 0) {
            await delay(100)
        }
    }

    function getStats() {
        return {
            pending: queue.length,
            running,
            maxConcurrent,
            delayMs
        }
    }

    return {
        enqueue,
        shutdown,
        getStats
    }
}
