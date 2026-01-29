/**
 * Request Queue - Semaphore-based Concurrency Limiter
 *
 * A lightweight rate limiting utility using a semaphore pattern to control
 * concurrent operations. Perfect for limiting API calls, file operations,
 * or any resource-intensive async tasks.
 *
 * Features:
 * - Semaphore-based concurrency control
 * - FIFO queue for pending requests
 * - Stats tracking (active, pending, total)
 * - Clean shutdown support
 * - Memory leak prevention
 *
 * Usage Example:
 * ```typescript
 * const queue = createRequestQueue(5) // Max 5 concurrent operations
 *
 * async function processItem(item) {
 *   await queue.acquire()
 *   try {
 *     // Do work...
 *   } finally {
 *     queue.release()
 *   }
 * }
 * ```
 */

export interface RequestQueue {
    /**
     * Acquire a slot in the queue
     * Resolves immediately if slots available, otherwise waits
     */
    acquire: () => Promise<void>

    /**
     * Release a slot back to the queue
     * Automatically grants slot to next pending request
     */
    release: () => void

    /**
     * Get current queue statistics
     */
    getStats: () => { active: number; pending: number; total: number }

    /**
     * Clear all pending requests
     * Resolves all pending promises to prevent memory leaks
     */
    clear: () => void
}

/**
 * Create a request queue with semaphore-based concurrency limiting
 *
 * @param maxConcurrent - Maximum number of concurrent operations allowed
 * @returns RequestQueue instance with acquire/release/getStats/clear methods
 *
 * @example
 * ```typescript
 * // Limit to 10 concurrent LLM requests
 * const llmQueue = createRequestQueue(10)
 *
 * async function callLLM() {
 *   await llmQueue.acquire()
 *   try {
 *     const result = await llm.invoke(messages)
 *     return result
 *   } finally {
 *     llmQueue.release()
 *   }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Limit concurrent file deletions
 * const fileQueue = createRequestQueue(20)
 *
 * const deletePromises = files.map(async (file) => {
 *   await fileQueue.acquire()
 *   try {
 *     await unlink(file)
 *   } finally {
 *     fileQueue.release()
 *   }
 * })
 *
 * await Promise.all(deletePromises)
 * ```
 */
export function createRequestQueue(maxConcurrent: number): RequestQueue {
    const pending: Array<() => void> = []
    let active = 0

    return {
        acquire: async (): Promise<void> => {
            if (active < maxConcurrent) {
                active++
                return
            }

            return new Promise((resolve) => {
                pending.push(resolve)
            })
        },

        release: (): void => {
            active--
            const next = pending.shift()
            if (next) {
                active++
                next()
            }
        },

        getStats: () => ({
            active,
            pending: pending.length,
            total: active + pending.length
        }),

        /**
         * Clear all pending requests (for cleanup/shutdown)
         * Resolves all pending promises to prevent memory leaks
         */
        clear: (): void => {
            while (pending.length > 0) {
                const next = pending.shift()
                if (next) {
                    next()
                }
            }
            active = 0
        }
    }
}
