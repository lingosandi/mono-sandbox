"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function AdminPage() {
    const router = useRouter()

    useEffect(() => {
        // Redirect to dashboard (no auth required)
        router.push("/admin/dashboard")
    }, [router])

    return (
        <div className="min-h-screen flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
    )
}
