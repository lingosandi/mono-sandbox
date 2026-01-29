import type { NextConfig } from "next"

const nextConfig: NextConfig = {
    images: {
        remotePatterns: [
            {
                protocol: "http",
                hostname: "localhost"
            }
        ]
    },
    // Externalize native modules like better-sqlite3
    serverExternalPackages: ['better-sqlite3'],
    // Empty turbopack config to silence webpack warning
    turbopack: {}
}

export default nextConfig
