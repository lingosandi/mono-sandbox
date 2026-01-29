"use client"

import Link from "next/link"
import {
    ArrowRight,
    Database,
    Users,
    Shield,
    Code
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle
} from "@/components/ui/card"
import { ThemeToggle } from "@/components/theme-toggle"

export default function Home() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-background via-muted/20 to-background">
            <div className="absolute top-4 right-4">
                <ThemeToggle />
            </div>
            <main className="flex w-full max-w-5xl flex-col items-center justify-center gap-12 py-16 px-4 sm:px-8">
                <div className="flex flex-col items-center gap-6 text-center">
                    <div className="rounded-full bg-primary/10 p-4 mb-2">
                        <Database className="h-12 w-12 text-primary" />
                    </div>
                    <h1 className="text-5xl font-bold leading-tight tracking-tight sm:text-6xl bg-linear-to-br from-foreground to-muted-foreground bg-clip-text text-transparent">
                        MonoOS Admin Dashboard
                    </h1>
                    <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
                        A powerful admin dashboard with comprehensive user
                        management, built with modern technologies for seamless
                        data handling and elegant UI.
                    </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-3xl">
                    <Card className="border-2 transition-all hover:shadow-lg hover:border-primary/50">
                        <CardHeader className="pb-3">
                            <div className="rounded-lg bg-primary/10 p-2 w-fit mb-2">
                                <Users className="h-5 w-5 text-primary" />
                            </div>
                            <CardTitle className="text-base">
                                User Management
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <CardDescription>
                                Create, edit, and manage user accounts with
                                role-based access control
                            </CardDescription>
                        </CardContent>
                    </Card>

                    <Card className="border-2 transition-all hover:shadow-lg hover:border-primary/50">
                        <CardHeader className="pb-3">
                            <div className="rounded-lg bg-primary/10 p-2 w-fit mb-2">
                                <Database className="h-5 w-5 text-primary" />
                            </div>
                            <CardTitle className="text-base">
                                SQLite Database
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <CardDescription>
                                Fast, embedded database with better-sqlite3 for
                                reliable data persistence
                            </CardDescription>
                        </CardContent>
                    </Card>

                    <Card className="border-2 transition-all hover:shadow-lg hover:border-primary/50">
                        <CardHeader className="pb-3">
                            <div className="rounded-lg bg-primary/10 p-2 w-fit mb-2">
                                <Shield className="h-5 w-5 text-primary" />
                            </div>
                            <CardTitle className="text-base">
                                Secure & Validated
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <CardDescription>
                                Built-in validation and error handling for data
                                integrity and security
                            </CardDescription>
                        </CardContent>
                    </Card>
                </div>

                <div className="flex flex-col gap-4 text-base font-medium sm:flex-row">
                    <Link href="/admin">
                        <Button
                            size="lg"
                            className="gap-2 shadow-lg hover:shadow-xl transition-all"
                        >
                            Go to Admin Dashboard
                            <ArrowRight className="h-4 w-4" />
                        </Button>
                    </Link>
                    <Link href="/ide">
                        <Button
                            size="lg"
                            variant="outline"
                            className="gap-2 shadow-lg hover:shadow-xl transition-all"
                        >
                            <Code className="h-4 w-4" />
                            Open IDE
                        </Button>
                    </Link>
                </div>

                <div className="text-center text-sm text-muted-foreground">
                    <p>Powered by Next.js 16, React 19, and Tailwind CSS</p>
                </div>
            </main>
        </div>
    )
}
