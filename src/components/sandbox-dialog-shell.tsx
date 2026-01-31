"use client"

import { ReactNode } from "react"
import {
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog"
import {
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
} from "@/components/ui/alert-dialog"

interface SandboxDialogProps {
    title: ReactNode
    description: ReactNode
    children: ReactNode
    footer: ReactNode
    isAlertDialog?: boolean
}

export function SandboxDialogShell({
    title,
    description,
    children,
    footer,
    isAlertDialog = false
}: SandboxDialogProps) {
    const Header = isAlertDialog ? AlertDialogHeader : DialogHeader
    const Title = isAlertDialog ? AlertDialogTitle : DialogTitle
    const Description = isAlertDialog ? AlertDialogDescription : DialogDescription
    const Footer = isAlertDialog ? AlertDialogFooter : DialogFooter

    return (
        <>
            <Header className={isAlertDialog ? "space-y-4" : "space-y-3"}>
                <Title className="text-3xl font-black tracking-tighter">
                    {title}
                </Title>
                <Description className="text-gray-400 font-medium leading-relaxed">
                    {description}
                </Description>
            </Header>
            <div className={isAlertDialog ? "" : "space-y-6 pt-4"}>
                {children}
            </div>
            <Footer className={`${isAlertDialog ? "pt-8" : "pt-6"} flex gap-3 sm:justify-end`}>
                {footer}
            </Footer>
        </>
    )
}

export const DIALOG_CONTENT_CLASS = "glass-card border-white/5 backdrop-blur-3xl text-white max-w-md"
