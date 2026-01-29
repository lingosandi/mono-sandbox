import { Registry, Counter, Gauge, Histogram } from "prom-client"

// Prometheus metrics registry
export const metricsRegistry = new Registry()

// Counters - Total events over time
const vmCreatedTotal = new Counter({
    name: "vm_created_total",
    help: "Total number of VMs created since startup",
    registers: [metricsRegistry]
})

const vmDestroyedTotal = new Counter({
    name: "vm_destroyed_total",
    help: "Total number of VMs destroyed since startup",
    registers: [metricsRegistry]
})

const vmCreationFailuresTotal = new Counter({
    name: "vm_creation_failures_total",
    help: "Total number of VM creation failures",
    registers: [metricsRegistry]
})

const wsConnectionsTotal = new Counter({
    name: "websocket_connections_total",
    help: "Total number of WebSocket connections",
    registers: [metricsRegistry]
})

const fileOperationsTotal = new Counter({
    name: "file_operations_total",
    help: "Total number of file operations",
    labelNames: ["operation"], // read, write, delete, etc.
    registers: [metricsRegistry]
})

// Gauges - Current state
const vmActiveCount = new Gauge({
    name: "vm_active_count",
    help: "Current number of active VMs",
    registers: [metricsRegistry]
})

const memoryUsageBytes = new Gauge({
    name: "orchestrator_memory_bytes",
    help: "Memory usage of VM orchestrator process in bytes",
    registers: [metricsRegistry]
})

const cpuUsagePercent = new Gauge({
    name: "orchestrator_cpu_usage_percent",
    help: "CPU usage of VM orchestrator process as percentage (0-100)",
    registers: [metricsRegistry]
})

const uptimeSeconds = new Gauge({
    name: "orchestrator_uptime_seconds",
    help: "Uptime of VM orchestrator in seconds",
    registers: [metricsRegistry]
})

// Histograms - Distribution of durations
const vmCreationDuration = new Histogram({
    name: "vm_creation_duration_seconds",
    help: "Time taken to create a VM in seconds",
    buckets: [0.5, 1, 2, 5, 10, 30, 60], // Buckets for different durations
    registers: [metricsRegistry]
})

const vmLifetimeDuration = new Histogram({
    name: "vm_lifetime_duration_seconds",
    help: "Lifetime of VMs from creation to destruction in seconds",
    buckets: [60, 300, 600, 1800, 3600, 7200, 14400], // 1min to 4hrs
    registers: [metricsRegistry]
})

// Track VM creation times for lifetime calculation
const vmCreationTimes = new Map<string, number>()

// Track process start time for CPU calculation
let lastCpuUsage = process.cpuUsage()
let lastCpuTime = Date.now()

// Update resource metrics
export function updateResourceMetrics() {
    const memUsage = process.memoryUsage()
    memoryUsageBytes.set(memUsage.heapUsed)
    
    // Calculate CPU percentage correctly
    const currentCpuUsage = process.cpuUsage(lastCpuUsage)
    const currentTime = Date.now()
    const elapsedMs = currentTime - lastCpuTime
    
    // CPU time is in microseconds, convert to percentage
    // (user + system) microseconds / elapsed milliseconds / 10 = percentage
    const cpuPercent = ((currentCpuUsage.user + currentCpuUsage.system) / 1000) / elapsedMs * 100
    cpuUsagePercent.set(Math.min(cpuPercent, 100)) // Cap at 100%
    
    lastCpuUsage = process.cpuUsage()
    lastCpuTime = currentTime
    
    uptimeSeconds.set(process.uptime())
}

// Exported metrics helpers
export const metrics = {
    vmCreated: () => {
        vmCreatedTotal.inc()
    },
    vmDestroyed: (vmId: string) => {
        vmDestroyedTotal.inc()
        
        // Calculate lifetime if we tracked creation
        const createdAt = vmCreationTimes.get(vmId)
        if (createdAt) {
            const lifetimeSeconds = (Date.now() - createdAt) / 1000
            vmLifetimeDuration.observe(lifetimeSeconds)
            vmCreationTimes.delete(vmId)
        }
    },
    vmCreationFailed: () => {
        vmCreationFailuresTotal.inc()
    },
    vmCreationStarted: (vmId: string) => {
        vmCreationTimes.set(vmId, Date.now())
        return vmCreationDuration.startTimer()
    },
    vmActiveCountUpdate: (count: number) => {
        vmActiveCount.set(count)
    },
    wsConnection: () => {
        wsConnectionsTotal.inc()
    },
    fileOperation: (operation: string) => {
        fileOperationsTotal.inc({ operation })
    }
}

export type MetricsType = typeof metrics
