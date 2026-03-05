import { cn } from "@/lib/utils"
import { PanelLeft, SquarePen, Settings, User, MessageSquare } from "lucide-react"
import { useNavigate, useLocation } from "react-router-dom"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useSidebar } from "./sidebar-context"

export function LeftSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { leftOpen, toggleLeft } = useSidebar()

  const handleNewChat = () => {
    navigate("/")
  }

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col bg-[--sidebar-bg] transition-all duration-300",
          leftOpen ? "w-72" : "w-14"
        )}
      >
        {leftOpen ? (
          <>
            {/* Expanded: Logo + Toggle */}
            <div className="flex shrink-0 items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-2.5">
                <div className="flex size-9 items-center justify-center rounded-xl bg-[--color-primary]">
                  <span className="text-lg font-bold text-white">U</span>
                </div>
                <span className="font-mono text-lg font-medium tracking-wide text-[--sidebar-fg]">
                  Ultrawork
                </span>
              </div>
              <button
                onClick={toggleLeft}
                className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-[--sidebar-fg-muted] transition-colors hover:bg-[--sidebar-accent] hover:text-[--sidebar-fg]"
              >
                <PanelLeft className="size-4" />
              </button>
            </div>

            {/* Navigation */}
            <nav className="flex shrink-0 flex-col gap-1 px-3">
              <button
                onClick={handleNewChat}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200",
                  location.pathname === "/"
                    ? "bg-[--sidebar-accent] font-semibold text-[--sidebar-fg] shadow-sm"
                    : "text-[--sidebar-fg-muted] hover:bg-[--sidebar-accent-hover] hover:text-[--sidebar-fg]"
                )}
              >
                <SquarePen className="size-5" />
                <span className="flex-1 text-left">New Chat</span>
              </button>
            </nav>

            {/* Sessions Section */}
            <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden px-3">
              <div className="flex shrink-0 items-center justify-between px-2 py-1.5">
                <span className="text-xs font-medium tracking-wider text-[--sidebar-fg-muted]">
                  SESSIONS
                </span>
              </div>
              <div className="mt-1 flex-1 space-y-0.5 overflow-y-auto">
                {/* Session list will be populated in Iteration 2.2 */}
                <div className="px-2 py-4 text-center text-xs text-[--sidebar-fg-muted]">
                  No sessions yet
                </div>
              </div>
            </div>

            {/* Bottom: User */}
            <div className="mt-auto shrink-0 p-3">
              <button className="flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[--sidebar-accent]">
                <div className="flex size-9 items-center justify-center overflow-hidden rounded-lg bg-[--sidebar-accent]">
                  <User className="size-5 text-[--sidebar-fg-muted]" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-[--sidebar-fg]">User</p>
                </div>
                <Settings className="size-4 text-[--sidebar-fg-muted]" />
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Collapsed: Icon-only */}
            <div className="flex shrink-0 items-center justify-center p-3">
              <button
                onClick={toggleLeft}
                className="flex size-9 cursor-pointer items-center justify-center rounded-xl bg-[--color-primary] transition-all hover:ring-2 hover:ring-[--sidebar-fg-muted]"
              >
                <span className="text-lg font-bold text-white">U</span>
              </button>
            </div>

            <div className="flex shrink-0 flex-col items-center gap-1 px-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleNewChat}
                    className="flex size-10 cursor-pointer items-center justify-center rounded-xl text-[--sidebar-fg-muted] transition-colors hover:bg-[--sidebar-accent] hover:text-[--sidebar-fg]"
                  >
                    <SquarePen className="size-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">New Chat</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      "flex size-10 cursor-pointer items-center justify-center rounded-xl transition-colors",
                      location.pathname.startsWith("/session")
                        ? "bg-[--sidebar-accent] text-[--sidebar-fg]"
                        : "text-[--sidebar-fg-muted] hover:bg-[--sidebar-accent] hover:text-[--sidebar-fg]"
                    )}
                  >
                    <MessageSquare className="size-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Sessions</TooltipContent>
              </Tooltip>
            </div>

            <div className="flex-1" />

            <div className="flex shrink-0 flex-col items-center gap-1 px-2 pb-6">
              <button className="flex size-8 cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-[--sidebar-accent] transition-all hover:ring-2 hover:ring-[--sidebar-fg-muted]">
                <User className="size-4 text-[--sidebar-fg-muted]" />
              </button>
            </div>
          </>
        )}
      </aside>
    </TooltipProvider>
  )
}
