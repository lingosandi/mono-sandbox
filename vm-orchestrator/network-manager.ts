import { exec } from "child_process"
import { promisify } from "util"
import {
    BRIDGE_NAME,
    BRIDGE_IP,
    BRIDGE_SUBNET,
    BRIDGE_IPV6,
    BRIDGE_IPV6_SUBNET,
    VM_IP_START,
} from "./config"

const execAsync = promisify(exec)

// Network configuration (imported from config.ts)
const TAP_PREFIX = "vmtap"

// Hoisted helper - Allocate IP address for VM (sequential)
function allocateVMIP(tapIndex: number): string {
    // Start IPs from configured start (.2 by default, bridge is .1)
    const baseOctet = 20 // Third octet from BRIDGE_IP (172.20.x.x)
    return `172.${baseOctet}.0.${tapIndex + VM_IP_START}`
}

// Hoisted helper - Generate MAC address for VM
function generateMACAddress(vmId: string): string {
    // Use VM ID hash to generate deterministic MAC
    // Format: 06:00:XX:XX:XX:XX (locally administered unicast)
    const hash = vmId
        .split("")
        .reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const mac = [
        "06",
        "00",
        ((hash >> 24) & 0xff).toString(16).padStart(2, "0"),
        ((hash >> 16) & 0xff).toString(16).padStart(2, "0"),
        ((hash >> 8) & 0xff).toString(16).padStart(2, "0"),
        (hash & 0xff).toString(16).padStart(2, "0")
    ]
    return mac.join(":")
}

// Setup bridge and NAT (run once at startup)
async function setupBridge() {
    try {
        // Check if bridge exists
        const { stdout: existingBridges } = await execAsync(
            "ip link show type bridge"
        )

        if (!existingBridges.includes(BRIDGE_NAME)) {
            console.log("Setting up network bridge...")

            // Create bridge (ignore if already exists)
            try {
                await execAsync(
                    `sudo ip link add name ${BRIDGE_NAME} type bridge`
                )
            } catch (error: unknown) {
                // Ignore "File exists" error, bridge might have been created between checks
                if (
                    !(error instanceof Error) ||
                    !error.message?.includes("File exists")
                ) {
                    throw error
                }
            }

            // Check if IP is already assigned before adding
            try {
                const { stdout: addrInfo } = await execAsync(
                    `ip addr show ${BRIDGE_NAME}`
                )
                if (!addrInfo.includes(`${BRIDGE_IP}/24`)) {
                    await execAsync(
                        `sudo ip addr add ${BRIDGE_IP}/24 dev ${BRIDGE_NAME}`
                    )
                }
            } catch (error: unknown) {
                // If bridge doesn't exist, rethrow; otherwise ignore if IP already assigned
                if (
                    !(error instanceof Error) ||
                    !error.message?.includes("Address already assigned")
                ) {
                    throw error
                }
            }

            await execAsync(`sudo ip link set ${BRIDGE_NAME} up`)

            // Enable IP forwarding (IPv4 and IPv6)
            await execAsync("sudo sysctl -w net.ipv4.ip_forward=1")
            await execAsync("sudo sysctl -w net.ipv6.conf.all.forwarding=1")

            // Assign IPv6 address to bridge
            try {
                const { stdout: addr6Info } = await execAsync(
                    `ip -6 addr show ${BRIDGE_NAME}`
                )
                if (!addr6Info.includes(`${BRIDGE_IPV6}/64`)) {
                    await execAsync(
                        `sudo ip addr add ${BRIDGE_IPV6}/64 dev ${BRIDGE_NAME}`
                    )
                }
            } catch (error: unknown) {
                // Ignore if address already assigned
                if (
                    !(error instanceof Error) ||
                    !error.message?.includes("Address already assigned")
                ) {
                    console.warn(
                        "Warning: Could not assign IPv6 to bridge:",
                        error
                    )
                }
            }

            // Setup NAT (masquerading) for outbound traffic (IPv4)
            try {
                await execAsync(
                    `sudo iptables -t nat -C POSTROUTING -s ${BRIDGE_SUBNET} -j MASQUERADE`
                )
                console.log("✓ IPv4 NAT already configured")
            } catch {
                // Rule doesn't exist, add it
                await execAsync(
                    `sudo iptables -t nat -A POSTROUTING -s ${BRIDGE_SUBNET} -j MASQUERADE`
                )
                console.log("✓ IPv4 NAT configured")
            }

            // Setup IPv6 NAT if IPv6 default route exists
            try {
                const { stdout: ipv6Route } = await execAsync(
                    "ip -6 route show default"
                )
                if (ipv6Route.trim()) {
                    // Parse: "default via fe80::1 dev eth0 proto ra metric 100"
                    // or: "default dev eth0 proto static metric 100"
                    const match = ipv6Route.match(/dev\s+(\S+)/)
                    const defaultIface = match ? match[1] : null

                    if (defaultIface && defaultIface !== "lo") {
                        // Check if interface-based NAT rule already exists
                        try {
                            await execAsync(
                                `sudo ip6tables -t nat -C POSTROUTING -o ${defaultIface} -j MASQUERADE`
                            )
                            console.log(
                                `✓ IPv6 NAT (interface) already configured for ${defaultIface}`
                            )
                        } catch {
                            // Rule doesn't exist, add it
                            await execAsync(
                                `sudo ip6tables -t nat -A POSTROUTING -o ${defaultIface} -j MASQUERADE`
                            )
                            console.log(
                                `✓ IPv6 NAT (interface) configured for ${defaultIface}`
                            )
                        }

                        // Add subnet-based NAT for completeness (matches IPv4 pattern)
                        try {
                            await execAsync(
                                `sudo ip6tables -t nat -C POSTROUTING -s ${BRIDGE_IPV6_SUBNET} -o ${defaultIface} -j MASQUERADE`
                            )
                            console.log(
                                `✓ IPv6 NAT (subnet) already configured`
                            )
                        } catch {
                            await execAsync(
                                `sudo ip6tables -t nat -A POSTROUTING -s ${BRIDGE_IPV6_SUBNET} -o ${defaultIface} -j MASQUERADE`
                            )
                            console.log(`✓ IPv6 NAT (subnet) configured`)
                        }

                        // Add IPv6 forwarding rules for bridge (check for duplicates first)
                        try {
                            await execAsync(
                                `sudo ip6tables -C FORWARD -i ${BRIDGE_NAME} -j ACCEPT`
                            )
                        } catch {
                            // Rule doesn't exist, add it
                            await execAsync(
                                `sudo ip6tables -A FORWARD -i ${BRIDGE_NAME} -j ACCEPT`
                            )
                        }
                        try {
                            await execAsync(
                                `sudo ip6tables -C FORWARD -o ${BRIDGE_NAME} -j ACCEPT`
                            )
                        } catch {
                            // Rule doesn't exist, add it
                            await execAsync(
                                `sudo ip6tables -A FORWARD -o ${BRIDGE_NAME} -j ACCEPT`
                            )
                        }
                    } else {
                        console.log("⚠ No valid IPv6 interface for NAT")
                    }
                } else {
                    console.log(
                        "⚠ IPv6 NAT not configured (no IPv6 default route)"
                    )
                }
            } catch {
                console.log("⚠ IPv6 NAT not configured (no IPv6 support)")
            }

            // Allow forwarding from bridge (check for duplicates first)
            try {
                await execAsync(
                    `sudo iptables -C FORWARD -i ${BRIDGE_NAME} -j ACCEPT`
                )
            } catch {
                // Rule doesn't exist, add it
                await execAsync(
                    `sudo iptables -A FORWARD -i ${BRIDGE_NAME} -j ACCEPT`
                )
            }
            try {
                await execAsync(
                    `sudo iptables -C FORWARD -o ${BRIDGE_NAME} -j ACCEPT`
                )
            } catch {
                // Rule doesn't exist, add it
                await execAsync(
                    `sudo iptables -A FORWARD -o ${BRIDGE_NAME} -j ACCEPT`
                )
            }

            console.log("✓ Network bridge and NAT configured")
        } else {
            console.log("✓ Network bridge already exists")
        }
    } catch (error) {
        console.error("Failed to setup bridge:", error)
        throw error
    }
}

// Factory function for network manager (proper encapsulation)
function createNetworkManager() {
    // Track allocated TAP devices per VM (encapsulated state)
    const tapDevices = new Map<string, string>()
    // Track freed TAP indices for reuse (prevents IP exhaustion)
    const freedTapIndices: number[] = []
    let nextTapIndex = 0

    async function createTapDevice(
        vmId: string
    ): Promise<{ tapName: string; vmIP: string }> {
        // Reuse freed TAP index if available (prevents IP exhaustion)
        let tapIndex: number
        if (freedTapIndices.length > 0) {
            tapIndex = freedTapIndices.pop()!
        } else {
            tapIndex = nextTapIndex++
        }
        
        const tapName = `${TAP_PREFIX}${tapIndex}`
        const vmIP = allocateVMIP(tapIndex)

        try {
            // Check if TAP device already exists and delete it
            try {
                const { stdout } = await execAsync(`ip link show ${tapName}`)
                if (stdout.includes(tapName)) {
                    console.log(`  → Removing existing TAP device ${tapName}`)
                    await execAsync(`sudo ip link delete ${tapName}`)
                }
            } catch {
                // Device doesn't exist, that's fine
            }

            // Create TAP device
            await execAsync(`sudo ip tuntap add ${tapName} mode tap`)

            // Attach to bridge
            await execAsync(`sudo ip link set ${tapName} master ${BRIDGE_NAME}`)

            // Bring up TAP device
            await execAsync(`sudo ip link set ${tapName} up`)

            tapDevices.set(vmId, tapName)

            console.log(
                `✓ Created TAP device ${tapName} for VM ${vmId} (IP: ${vmIP})`
            )

            return { tapName, vmIP }
        } catch (error) {
            console.error(`Failed to create TAP device for ${vmId}:`, error)
            throw error
        }
    }

    async function removeTapDevice(vmId: string) {
        const tapName = tapDevices.get(vmId)

        if (!tapName) {
            return
        }

        try {
            await execAsync(`sudo ip link delete ${tapName}`)
            tapDevices.delete(vmId)
            
            // Extract tap index and return to pool for reuse
            const tapIndex = parseInt(tapName.replace(TAP_PREFIX, ""))
            if (!isNaN(tapIndex)) {
                freedTapIndices.push(tapIndex)
            }
            
            console.log(`✓ Removed TAP device ${tapName} for VM ${vmId}`)
        } catch (error) {
            console.error(`Failed to remove TAP device ${tapName}:`, error)
        }
    }

    async function cleanupAllTapDevices() {
        const cleanupPromises = []
        for (const vmId of tapDevices.keys()) {
            cleanupPromises.push(removeTapDevice(vmId))
        }
        await Promise.allSettled(cleanupPromises)
        tapDevices.clear()
    }

    return {
        createTapDevice,
        removeTapDevice,
        cleanupAllTapDevices
    }
}

// Singleton instance for the application
const networkManager = createNetworkManager()

export {
    setupBridge,
    networkManager,
    generateMACAddress,
    BRIDGE_IP,
    BRIDGE_SUBNET,
    BRIDGE_IPV6,
    BRIDGE_IPV6_SUBNET
}
