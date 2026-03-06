import { useState, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import { PanelLeft, SquarePen, Settings, MessageSquare, MoreHorizontal, Trash2, Loader2, Pencil, Check, X, Search, Star } from "lucide-react"
import { useNavigate, useLocation } from "react-router-dom"
import type { Session } from "@agent/api-client"
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
import { SettingsDialog, ConnectionStatus } from "@/components/settings"
import { useFavorites } from "@/lib/use-favorites"

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

interface SessionGroup {
  label: string
  sessions: Session[]
}

function groupSessionsByDate(sessions: Session[]): SessionGroup[] {
  const now = Date.now()
  const oneDayMs = 24 * 60 * 60 * 1000
  const oneWeekMs = 7 * oneDayMs

  const today: Session[] = []
  const yesterday: Session[] = []
  const thisWeek: Session[] = []
  const earlier: Session[] = []

  sessions.forEach((session) => {
    const diff = now - session.time.created
    if (diff < oneDayMs) {
      today.push(session)
    } else if (diff < 2 * oneDayMs) {
      yesterday.push(session)
    } else if (diff < oneWeekMs) {
      thisWeek.push(session)
    } else {
      earlier.push(session)
    }
  })

  const groups: SessionGroup[] = []
  if (today.length > 0) groups.push({ label: "Today", sessions: today })
  if (yesterday.length > 0) groups.push({ label: "Yesterday", sessions: yesterday })
  if (thisWeek.length > 0) groups.push({ label: "This Week", sessions: thisWeek })
  if (earlier.length > 0) groups.push({ label: "Earlier", sessions: earlier })

  return groups
}

export function LeftSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { leftOpen, toggleLeft } = useSidebar()
  const { sessions, loading, createSession, deleteSession, renameSession } = useSessionsContext()
  const [creating, setCreating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const { toggleFavorite, isFavorite } = useFavorites()

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

  const handleRenameSession = async (sessionId: string, newTitle: string) => {
    try {
      await renameSession(sessionId, newTitle)
    } catch (err) {
      console.error("Failed to rename session:", err)
    }
  }

  const currentSessionId = location.pathname.startsWith("/session/")
    ? location.pathname.split("/session/")[1]
    : null

  // Filter sessions by search query
  const filteredSessions = sessions.filter((session) =>
    session.title.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const sessionGroups = groupSessionsByDate(filteredSessions)

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

              {/* Search Input */}
              <div className="mb-2 shrink-0">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[--sidebar-fg-muted]" />
                  <input
                    type="text"
                    placeholder="Search sessions..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-lg border border-[--color-border] bg-[--color-bg] py-1.5 pl-9 pr-3 text-sm text-[--sidebar-fg] placeholder:text-[--sidebar-fg-muted] focus:border-[--color-primary] focus:outline-none focus:ring-1 focus:ring-[--color-primary]"
                  />
                </div>
              </div>

              <div className="scrollbar-soft mt-1 flex-1 space-y-0.5 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="size-4 animate-spin text-[--sidebar-fg-muted]" />
                  </div>
                ) : filteredSessions.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-[--sidebar-fg-muted]">
                    {searchQuery ? "No matching sessions" : "No sessions yet"}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {sessionGroups.map((group) => {
                      // Separate pinned and unpinned sessions
                      const pinnedSessions = group.sessions.filter((s) => isFavorite(s.id))
                      const unpinnedSessions = group.sessions.filter((s) => !isFavorite(s.id))

                      return (
                        <div key={group.label} className="space-y-0.5">
                          <h3 className="px-2 py-1 text-xs font-medium tracking-wider text-[--sidebar-fg-muted] opacity-70">
                            {group.label}
                          </h3>
                          {/* Pinned sessions first */}
                          {pinnedSessions.map((session) => (
                            <SessionItem
                              key={session.id}
                              session={session}
                              isActive={currentSessionId === session.id}
                              isPinned={true}
                              onNavigate={() => navigate(`/session/${session.id}`)}
                              onDelete={(e) => handleDeleteSession(e, session.id)}
                              onRename={(newTitle) => handleRenameSession(session.id, newTitle)}
                              onTogglePin={() => toggleFavorite(session.id)}
                            />
                          ))}
                          {/* Unpinned sessions */}
                          {unpinnedSessions.map((session) => (
                            <SessionItem
                              key={session.id}
                              session={session}
                              isActive={currentSessionId === session.id}
                              isPinned={false}
                              onNavigate={() => navigate(`/session/${session.id}`)}
                              onDelete={(e) => handleDeleteSession(e, session.id)}
                              onRename={(newTitle) => handleRenameSession(session.id, newTitle)}
                              onTogglePin={() => toggleFavorite(session.id)}
                            />
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Bottom: User + Settings + Connection Status */}
            <div className="mt-auto shrink-0 space-y-2 p-3">
              <ConnectionStatus />
              <button
                onClick={() => setSettingsOpen(true)}
                aria-label="Settings"
                className="flex w-full items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[--sidebar-accent]"
              >
                <div className="flex size-9 items-center justify-center overflow-hidden rounded-lg bg-[--sidebar-accent]">
                  <Settings className="size-5 text-[--sidebar-fg-muted]" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-[--sidebar-fg]">Settings</p>
                </div>
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

            <div className="flex shrink-0 flex-col items-center gap-2 px-2 pb-6">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setSettingsOpen(true)}
                    aria-label="Settings"
                    className="flex size-8 items-center justify-center overflow-hidden rounded-lg bg-[--sidebar-accent] transition-all hover:ring-2 hover:ring-[--sidebar-fg-muted]"
                  >
                    <Settings className="size-4 text-[--sidebar-fg-muted]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Settings</TooltipContent>
              </Tooltip>
            </div>
          </>
        )}
      </aside>

      {/* Settings Dialog */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </TooltipProvider>
  )
}

function SessionItem({
  session,
  isActive,
  isPinned,
  onNavigate,
  onDelete,
  onRename,
  onTogglePin,
}: {
  session: { id: string; title: string; time: { created: number; updated: number } }
  isActive: boolean
  isPinned: boolean
  onNavigate: () => void
  onDelete: (e: React.MouseEvent) => void
  onRename: (newTitle: string) => void
  onTogglePin: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const title = session.title || `Session ${session.id.slice(0, 8)}`

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditValue(title)
    setIsEditing(true)
  }

  const handleSaveEdit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== title) {
      onRename(trimmed)
    }
    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditValue("")
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveEdit()
    } else if (e.key === "Escape") {
      handleCancelEdit()
    }
  }

  if (isEditing) {
    return (
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
          isActive
            ? "bg-[--sidebar-accent] font-medium text-[--sidebar-fg]"
            : "bg-[--sidebar-accent-hover] text-[--sidebar-fg]"
        )}
      >
        <MessageSquare className="size-4 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSaveEdit}
          className="min-w-0 flex-1 bg-transparent outline-none"
          onClick={(e) => e.stopPropagation()}
        />
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleSaveEdit()
            }}
            className="flex size-6 items-center justify-center rounded-md hover:bg-[--sidebar-accent]"
            aria-label="Save"
          >
            <Check className="size-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleCancelEdit()
            }}
            className="flex size-6 items-center justify-center rounded-md hover:bg-[--sidebar-accent]"
            aria-label="Cancel"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      onClick={onNavigate}
      className={cn(
        "group relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all duration-150 cursor-pointer",
        isActive
          ? "bg-[--sidebar-accent] font-medium text-[--sidebar-fg]"
          : "text-[--sidebar-fg-muted] hover:bg-[--sidebar-accent-hover] hover:text-[--sidebar-fg]",
        isPinned && "border-l-2 border-[--color-primary]"
      )}
    >
      {/* Pin/Star icon */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onTogglePin()
        }}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center transition-opacity",
          isPinned
            ? "opacity-100 text-[--color-primary]"
            : "opacity-0 group-hover:opacity-60 hover:opacity-100"
        )}
        aria-label={isPinned ? "Unpin" : "Pin"}
      >
        <Star className={cn("size-3.5", isPinned && "fill-current")} />
      </button>

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
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin()
            }}
          >
            <Star className="mr-2 size-4" />
            {isPinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleStartEdit}>
            <Pencil className="mr-2 size-4" />
            Rename
          </DropdownMenuItem>
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
