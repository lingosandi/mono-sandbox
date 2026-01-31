import { Button } from "@/components/ui/button"
import {
    ArrowLeft,
    FileCode2,
    Search,
    Settings,
    Menu,
    X
} from "lucide-react"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

interface ActivityBarProps {
    onBackClick: () => void
    onCloseProject: () => void
}

export function ActivityBar({
    onBackClick,
    onCloseProject
}: ActivityBarProps) {
    return (
        <div className="w-14 flex flex-col items-center py-4 border-r border-white/5 bg-transparent shrink-0 z-20">
            <div className="flex flex-col gap-4 w-full px-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 text-zinc-400 hover:text-white hover:bg-white/5 rounded-xl"
                            title="Menu"
                        >
                            <Menu className="h-5 w-5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                        <DropdownMenuItem onClick={onCloseProject}>
                            <X className="mr-2 h-4 w-4" />
                            Close Project
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>

                <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 text-zinc-400 hover:text-white hover:bg-white/5 rounded-xl"
                >
                    <FileCode2 className="h-5 w-5" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 text-zinc-400 hover:text-white hover:bg-white/5 rounded-xl"
                >
                    <Search className="h-5 w-5" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 text-zinc-400 hover:text-white hover:bg-white/5 rounded-xl"
                >
                    <Settings className="h-5 w-5" />
                </Button>
            </div>

            <div className="mt-auto flex flex-col gap-4 w-full px-2">
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-xl"
                    onClick={onBackClick}
                    title="Back to Projects"
                >
                    <ArrowLeft className="h-5 w-5" />
                </Button>
            </div>
        </div>
    )
}
