import { ReactNode } from "react"

interface SectionBarProps {
    title: string
    actions?: ReactNode
}

export function SectionBar({ title, actions }: SectionBarProps) {
    return (
        <div className="h-10 border-b border-white/5 flex items-center px-4 bg-transparent">
            <div className="flex items-center justify-between w-full">
                <span className="text-xs text-zinc-400 uppercase tracking-wider">
                    {title}
                </span>
                {actions && <div className="flex items-center">{actions}</div>}
            </div>
        </div>
    )
}
