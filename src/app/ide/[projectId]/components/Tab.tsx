import { X, LucideIcon } from "lucide-react"
import { ReactNode } from "react"

interface TabProps {
    label: string | ReactNode
    icon?: LucideIcon
    isActive: boolean
    onClick: () => void
    closable?: boolean
    onClose?: () => void
    isDirty?: boolean
}

export function Tab({
    label,
    icon: Icon,
    isActive,
    onClick,
    closable = false,
    onClose,
    isDirty = false
}: TabProps) {
    return (
        <div
            onClick={onClick}
            className={`
                ${
                    closable ? "group" : ""
                } flex items-center gap-2 px-3 py-1 rounded-sm text-sm cursor-pointer transition-all select-none border border-transparent
                ${
                    isActive
                        ? "bg-white/10 text-white border-white/5"
                        : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
                }
            `}
        >
            {Icon && <Icon className="h-3.5 w-3.5 opacity-70" />}
            <span className="max-w-30 truncate">{label}</span>
            {isDirty && <span className="h-2 w-2 rounded-full bg-blue-500" />}
            {closable && onClose && (
                <span
                    className={`opacity-0 group-hover:opacity-100 hover:bg-white/20 rounded p-0.5 ${
                        isActive ? "opacity-100" : ""
                    }`}
                    onClick={(e) => {
                        e.stopPropagation()
                        onClose()
                    }}
                >
                    <X className="h-3 w-3" />
                </span>
            )}
        </div>
    )
}
