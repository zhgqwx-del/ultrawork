import { useState, useRef, useEffect } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  PanelLeft,
  Plus,
  Settings,
  MessageSquare,
  MoreHorizontal,
  Trash2,
  Loader2,
  Pencil,
  Check,
  X,
  Search,
  Star,
  Clock,
  Briefcase,
  Sparkles,
} from "lucide-react"
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
import { SettingsPopover } from "@/components/settings/settings-popover"
import { ConnectionStatus } from "@/components/settings"
import { useFavorites } from "@/lib/use-favorites"
import { useI18n } from "@/lib/i18n-context"

function formatTime(timestamp: number, t: (key: string) => string): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t("time.justNow")
  if (minutes < 60) return t("time.mAgo").replace("{n}", String(minutes))
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("time.hAgo").replace("{n}", String(hours))
  const days = Math.floor(hours / 24)
  if (days < 7) return t("time.dAgo").replace("{n}", String(days))
  return new Date(timestamp).toLocaleDateString()
}

interface SessionGroup {
  label: string
  sessions: Session[]
}

function groupSessionsByDate(sessions: Session[], t: (key: string) => string): SessionGroup[] {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000

  const today: Session[] = []
  const yesterday: Session[] = []
  const thisWeek: Session[] = []
  const earlier: Session[] = []

  sessions.forEach((session) => {
    const created = session.time.created
    if (created >= todayStart) {
      today.push(session)
    } else if (created >= yesterdayStart) {
      yesterday.push(session)
    } else if (created >= weekStart) {
      thisWeek.push(session)
    } else {
      earlier.push(session)
    }
  })

  const groups: SessionGroup[] = []
  if (today.length > 0) groups.push({ label: t("dateGroup.today"), sessions: today })
  if (yesterday.length > 0) groups.push({ label: t("dateGroup.yesterday"), sessions: yesterday })
  if (thisWeek.length > 0) groups.push({ label: t("dateGroup.thisWeek"), sessions: thisWeek })
  if (earlier.length > 0) groups.push({ label: t("dateGroup.earlier"), sessions: earlier })

  return groups
}

export function LeftSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { leftOpen, toggleLeft } = useSidebar()
  const { sessions, loading, createSession, deleteSession, renameSession } = useSessionsContext()
  const [creating, setCreating] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [showSearch, setShowSearch] = useState(false)
  const { toggleFavorite, isFavorite } = useFavorites()
  const { t } = useI18n()

  const handleNewChat = async () => {
    if (creating) return
    setCreating(true)
    try {
      const session = await createSession()
      navigate(`/session/${session.id}`)
    } catch (err) {
      console.error("Failed to create session:", err)
      toast.error("Failed to create session")
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    try {
      await deleteSession(sessionId)
      if (location.pathname === `/session/${sessionId}`) {
        navigate("/")
      }
    } catch (err) {
      console.error("Failed to delete session:", err)
      toast.error("Failed to delete session")
    }
  }

  const handleRenameSession = async (sessionId: string, newTitle: string) => {
    try {
      await renameSession(sessionId, newTitle)
    } catch (err) {
      console.error("Failed to rename session:", err)
      toast.error("Failed to rename session")
    }
  }

  const currentSessionId = location.pathname.startsWith("/session/")
    ? location.pathname.split("/session/")[1]
    : null

  const filteredSessions = sessions.filter((session) =>
    session.title.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const sessionGroups = groupSessionsByDate(filteredSessions, t)

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col bg-[var(--sidebar-bg)] transition-all duration-300",
          leftOpen ? "w-72" : "w-12"
        )}
      >
        {leftOpen ? (
          <>
            {/* Expanded: Brand + Toggle */}
            <div className="flex shrink-0 items-center justify-between gap-3 p-4">
              <button
                onClick={() => navigate("/")}
                className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
              >
                <div
                  className="flex size-8 items-center justify-center rounded-lg"
                  style={{ background: "var(--color-brand-gradient)" }}
                >
                  <Sparkles className="size-4 text-white" />
                </div>
                <span className="text-sm font-semibold tracking-wide text-[var(--sidebar-fg)]">
                  {t("brand.name")}
                </span>
              </button>
              <button
                onClick={toggleLeft}
                aria-label="Collapse sidebar"
                className="flex size-8 items-center justify-center rounded-lg text-[var(--sidebar-fg-muted)] transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
              >
                <PanelLeft className="size-4" />
              </button>
            </div>

            {/* Action buttons */}
            <nav className="flex shrink-0 items-center gap-1 px-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleNewChat}
                    disabled={creating}
                    className="flex size-9 items-center justify-center rounded-lg text-[var(--sidebar-fg-muted)] transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
                  >
                    {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("sidebar.newTask")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setShowSearch(!showSearch)}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg transition-colors",
                      showSearch
                        ? "bg-[var(--sidebar-accent)] text-[var(--sidebar-fg)]"
                        : "text-[var(--sidebar-fg-muted)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
                    )}
                  >
                    <Search className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("sidebar.search")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    disabled
                    className="flex size-9 items-center justify-center rounded-lg text-[var(--sidebar-fg-muted)] opacity-50"
                  >
                    <Clock className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("sidebar.scheduled")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    disabled
                    className="flex size-9 items-center justify-center rounded-lg text-[var(--sidebar-fg-muted)] opacity-50"
                  >
                    <Briefcase className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("sidebar.custom")}</TooltipContent>
              </Tooltip>
            </nav>

            {/* Search Input (conditional) */}
            {showSearch && (
              <div className="shrink-0 px-3 pt-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--sidebar-fg-muted)]" />
                  <input
                    type="text"
                    placeholder={t("sidebar.searchPlaceholder")}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    autoFocus
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-9 pr-3 text-sm text-[var(--sidebar-fg)] placeholder:text-[var(--sidebar-fg-muted)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                  />
                </div>
              </div>
            )}

            {/* Task/Sessions list */}
            <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden px-3">
              <div className="scrollbar-soft flex-1 space-y-0.5 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="size-4 animate-spin text-[var(--sidebar-fg-muted)]" />
                  </div>
                ) : filteredSessions.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-[var(--sidebar-fg-muted)]">
                    {searchQuery ? t("sidebar.noMatch") : t("sidebar.noSessions")}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {sessionGroups.map((group) => {
                      const pinnedSessions = group.sessions.filter((s) => isFavorite(s.id))
                      const unpinnedSessions = group.sessions.filter((s) => !isFavorite(s.id))

                      return (
                        <div key={group.label} className="space-y-0.5">
                          <h3 className="px-2 py-1 text-xs font-medium tracking-wider text-[var(--sidebar-fg-muted)] opacity-70">
                            {group.label}
                          </h3>
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
                              t={t}
                            />
                          ))}
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
                              t={t}
                            />
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Footer: Connection + User avatar + Settings */}
            <div className="mt-auto shrink-0 space-y-2 p-3">
              <ConnectionStatus />
              <SettingsPopover>
                <button
                  aria-label="User settings"
                  className="flex w-full items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[var(--sidebar-accent)]"
                >
                  <div className="flex size-8 items-center justify-center rounded-full bg-[var(--color-brand)] text-sm font-semibold text-white">
                    Y
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    <p className="truncate text-sm font-medium text-[var(--sidebar-fg)]">
                      {t("sidebar.user")}
                    </p>
                  </div>
                  <Settings className="size-4 text-[var(--sidebar-fg-muted)]" />
                </button>
              </SettingsPopover>
            </div>
          </>
        ) : (
          <>
            {/* Collapsed: Icon-only */}
            <div className="flex shrink-0 items-center justify-center p-2 pt-3">
              <button
                onClick={() => navigate("/")}
                aria-label="Home"
                className="flex size-8 items-center justify-center rounded-lg transition-all hover:ring-2 hover:ring-[var(--sidebar-fg-muted)]"
                style={{ background: "var(--color-brand-gradient)" }}
              >
                <Sparkles className="size-4 text-white" />
              </button>
            </div>

            <div className="flex shrink-0 flex-col items-center gap-1 px-1 pt-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleNewChat}
                    disabled={creating}
                    aria-label={t("sidebar.newTask")}
                    className="flex size-9 items-center justify-center rounded-lg text-[var(--sidebar-fg-muted)] transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
                  >
                    {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{t("sidebar.newTask")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label="Sessions"
                    onClick={toggleLeft}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg transition-colors",
                      location.pathname.startsWith("/session")
                        ? "bg-[var(--sidebar-accent)] text-[var(--sidebar-fg)]"
                        : "text-[var(--sidebar-fg-muted)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
                    )}
                  >
                    <MessageSquare className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{t("session.sessions")}</TooltipContent>
              </Tooltip>
            </div>

            <div className="flex-1" />

            <div className="flex shrink-0 flex-col items-center gap-2 px-1 pb-4">
              <SettingsPopover>
                <button
                  aria-label="Settings"
                  className="flex size-8 items-center justify-center rounded-full bg-[var(--color-brand)] text-xs font-semibold text-white transition-all hover:ring-2 hover:ring-[var(--sidebar-fg-muted)]"
                >
                  Y
                </button>
              </SettingsPopover>
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
  isPinned,
  onNavigate,
  onDelete,
  onRename,
  onTogglePin,
  t,
}: {
  session: { id: string; title: string; time: { created: number; updated: number } }
  isActive: boolean
  isPinned: boolean
  onNavigate: () => void
  onDelete: (e: React.MouseEvent) => void
  onRename: (newTitle: string) => void
  onTogglePin: () => void
  t: (key: string) => string
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

  // Force re-render when session crosses the 30s "active" threshold
  const [, setTick] = useState(0)
  useEffect(() => {
    const age = Date.now() - session.time.updated
    if (age < 30000) {
      const timer = setTimeout(() => setTick((t) => t + 1), 30000 - age + 500)
      return () => clearTimeout(timer)
    }
  }, [session.time.updated])

  // Status icon based on session state
  const StatusIcon = () => {
    const age = Date.now() - session.time.updated

    // Active within last 30 seconds = running
    if (age < 30000) {
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--color-brand)]" />
    }
    // Has meaningful content (updated significantly after creation) = completed
    if (session.time.updated - session.time.created > 5000) {
      return <Check className="size-3.5 shrink-0 text-green-500" />
    }
    return <MessageSquare className="size-3.5 shrink-0" />
  }

  if (isEditing) {
    return (
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
          isActive
            ? "bg-[var(--sidebar-accent)] font-medium text-[var(--sidebar-fg)]"
            : "bg-[var(--sidebar-accent-hover)] text-[var(--sidebar-fg)]"
        )}
      >
        <StatusIcon />
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
            className="flex size-6 items-center justify-center rounded-md hover:bg-[var(--sidebar-accent)]"
            aria-label="Save"
          >
            <Check className="size-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleCancelEdit()
            }}
            className="flex size-6 items-center justify-center rounded-md hover:bg-[var(--sidebar-accent)]"
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
        "group relative flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all duration-150",
        isActive
          ? "bg-[var(--sidebar-accent)] font-medium text-[var(--sidebar-fg)]"
          : "text-[var(--sidebar-fg-muted)] hover:bg-[var(--sidebar-accent-hover)] hover:text-[var(--sidebar-fg)]",
        isPinned && "border-l-2 border-[var(--color-primary)]"
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
            ? "text-[var(--color-primary)] opacity-100"
            : "opacity-0 group-hover:opacity-60 hover:opacity-100"
        )}
        aria-label={isPinned ? t("session.unpin") : t("session.pin")}
      >
        <Star className={cn("size-3.5", isPinned && "fill-current")} />
      </button>

      <StatusIcon />
      <div className="min-w-0 flex-1">
        <p className="truncate">{title}</p>
        <p className="truncate text-xs opacity-60">{formatTime(session.time.updated, t)}</p>
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
            {isPinned ? t("session.unpin") : t("session.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleStartEdit}>
            <Pencil className="mr-2 size-4" />
            {t("session.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onDelete}
            className="text-[var(--color-destructive)] focus:text-[var(--color-destructive)]"
          >
            <Trash2 className="mr-2 size-4" />
            {t("session.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
