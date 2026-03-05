import { useState } from "react"
import { cn } from "@/lib/utils"
import { PanelLeft, SquarePen, Settings, User, MessageSquare, MoreHorizontal, Trash2, Loader2 } from "lucide-react"
import { useNavigate, useLocation } from "react-router-dom"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "./sidebar-context"
import { useSessionsContext } from "@/lib/sessions-context"

function formatTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

export function LeftSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { leftOpen, toggleLeft } = useSidebar()
  const { sessions, loading, createSession, deleteSession } = useSessionsContext()
  const [creating, setCreating] = useState(false)

  const handleNewChat = async () => {
    if (creating) return
    setCreating(true)
    try {
      const session = await createSession()
      navigate(`/session/${session.id}`)
    } catch (err) {
      console.error("Failed to create session:", err)
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    try {
      await deleteSession(sessionId)
      // If we're viewing the deleted session, go home
      if (location.pathname === `/session/${sessionId}`) {
        navigate("/")
      }
    } catch (err) {
      console.error("Failed to delete session:", err)
    }
  }

  const currentSessionId = location.pathname.startsWith("/session/")
    ? location.pathname.split("/session/")[1]
    : null

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
                aria-label="Collapse sidebar"
                className="flex size-8 items-center justify-center rounded-lg text-[--sidebar-fg-muted] transition-colors hover:bg-[--sidebar-accent] hover:text-[--sidebar-fg]"
              >
                <PanelLeft className="size-4" />
              </button>
            </div>

            {/* New Chat */}
            <nav className="flex shrink-0 flex-col gap-1 px-3">
              <button
                onClick={handleNewChat}
                disabled={creating}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200",
                  location.pathname === "/" && !creating
                    ? "bg-[--sidebar-accent] font-semibold text-[--sidebar-fg] shadow-sm"
                    : "text-[--sidebar-fg-muted] hover:bg-[--sidebar-accent-hover] hover:text-[--sidebar-fg]"
                )}
              >
                {creating ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <SquarePen className="size-5" />
                )}
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
              <div className="scrollbar-soft mt-1 flex-1 space-y-0.5 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="size-4 animate-spin text-[--sidebar-fg-muted]" />
                  </div>
                ) : sessions.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-[--sidebar-fg-muted]">
                    No sessions yet
                  </div>
                ) : (
                  sessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      isActive={currentSessionId === session.id}
                      onNavigate={() => navigate(`/session/${session.id}`)}
                      onDelete={(e) => handleDeleteSession(e, session.id)}
                    />
                  ))
                )}
              </div>
            </div>

            {/* Bottom: User */}
            <div className="mt-auto shrink-0 p-3">
              <button
                aria-label="User settings"
                className="flex w-full items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[--sidebar-accent]"
              >
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
                aria-label="Expand sidebar"
                className="flex size-9 items-center justify-center rounded-xl bg-[--color-primary] transition-all hover:ring-2 hover:ring-[--sidebar-fg-muted]"
              >
                <span className="text-lg font-bold text-white">U</span>
              </button>
            </div>

            <div className="flex shrink-0 flex-col items-center gap-1 px-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleNewChat}
                    disabled={creating}
                    aria-label="New Chat"
                    className="flex size-10 items-center justify-center rounded-xl text-[--sidebar-fg-muted] transition-colors hover:bg-[--sidebar-accent] hover:text-[--sidebar-fg]"
                  >
                    {creating ? (
                      <Loader2 className="size-5 animate-spin" />
                    ) : (
                      <SquarePen className="size-5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">New Chat</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label="Sessions"
                    onClick={toggleLeft}
                    className={cn(
                      "flex size-10 items-center justify-center rounded-xl transition-colors",
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
              <button
                aria-label="User settings"
                className="flex size-8 items-center justify-center overflow-hidden rounded-lg bg-[--sidebar-accent] transition-all hover:ring-2 hover:ring-[--sidebar-fg-muted]"
              >
                <User className="size-4 text-[--sidebar-fg-muted]" />
              </button>
            </div>
          </>
        )}
      </aside>
    </TooltipProvider>
  )
}

function SessionItem({
  session,
  isActive,
  onNavigate,
  onDelete,
}: {
  session: { id: string; title: string; time: { created: number; updated: number } }
  isActive: boolean
  onNavigate: () => void
  onDelete: (e: React.MouseEvent) => void
}) {
  const title = session.title || `Session ${session.id.slice(0, 8)}`

  return (
    <div
      onClick={onNavigate}
      className={cn(
        "group relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all duration-150 cursor-pointer",
        isActive
          ? "bg-[--sidebar-accent] font-medium text-[--sidebar-fg]"
          : "text-[--sidebar-fg-muted] hover:bg-[--sidebar-accent-hover] hover:text-[--sidebar-fg]"
      )}
    >
      <MessageSquare className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate">{title}</p>
        <p className="truncate text-xs opacity-60">{formatTime(session.time.updated)}</p>
      </div>

      {/* Three-dot menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Session options"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md transition-opacity",
              isActive
                ? "opacity-60 hover:opacity-100"
                : "opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100"
            )}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            onClick={onDelete}
            className="text-[--color-destructive] focus:text-[--color-destructive]"
          >
            <Trash2 className="mr-2 size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
