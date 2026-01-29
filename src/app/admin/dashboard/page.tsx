"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function AdminDashboard() {
    return (
        <div className="min-h-screen p-8 bg-background">
            <div className="max-w-4xl mx-auto">
                <Card>
                    <CardHeader>
                        <CardTitle>Admin Dashboard</CardTitle>
                        <CardDescription>
                            User management has been removed. This is now a single-user system.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                                Authentication has been removed from this application. 
                                All features are now accessible without login.
                            </p>
                            <div className="flex gap-4">
                                <Link href="/">
                                    <Button>Go to Home</Button>
                                </Link>
                                <Link href="/ide">
                                    <Button variant="outline">Go to IDE</Button>
                                </Link>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
