import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { handleDrag } from "./drag-region"
import {
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
  Crown,
  Plug,
  Sparkles,
  Wrench,
  Radio,
} from "lucide-react"
import { Logo } from "@/components/ui/logo"
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
import { useSidebar, isSettingsPath } from "./sidebar-context"
import { isMacOS } from "@/lib/platform"
import { useSessionsContext } from "@/lib/sessions-context"
import { SettingsPopover } from "@/components/settings/settings-popover"
import { useFavorites } from "@/lib/use-favorites"
import { useI18n } from "@/lib/i18n-context"
import { formatDateOnly } from "@/lib/format-time"
import { useTeamSessions, type TeamSessionEntry } from "@/lib/team-sessions-context"
import { useChannelSessions, type ChannelSessionEntry } from "@/lib/channel-sessions-context"
import { useUnread } from "@/lib/use-unread"
import { sessionDraftKey, useDraftDispatch } from "@/lib/draft-context"
import { useWorkspace } from "@/lib/workspace-context"
import { WeChatIcon, WeComIcon, DingTalkIcon, FeishuIcon } from "@/components/brand-icons"
import type { ComponentType } from "react"

/** Brand icon per channel type — same registry as the settings page. A type with
 *  no icon here still gets a badge, just a generic one. */
const CHANNEL_TYPE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  wechat: WeChatIcon,
  dingtalk: DingTalkIcon,
  wecom: WeComIcon,
  feishu: FeishuIcon,
}

/**
 * Quick-access entries for the four capability-extension settings sections that
 * are otherwise buried under the settings gear. Pure navigation shortcuts — they
 * deep-link into `/settings` via router history `state` (the same pattern the
 * settings popover / model picker already use). `section` matches SettingsSection
 * in pages/Settings.tsx; kept as a local literal because that type isn't exported.
 */
export const EXTENSION_ENTRIES: {
  section: "services" | "skills" | "tools" | "channels"
  icon: ComponentType<{ className?: string }>
  labelKey: string
}[] = [
  { section: "channels", icon: Radio, labelKey: "settingsPage.channels" },
  { section: "services", icon: Plug, labelKey: "settingsPage.services" },
  { section: "skills", icon: Sparkles, labelKey: "settingsPage.skills" },
  { section: "tools", icon: Wrench, labelKey: "settingsPage.tools" },
]

function formatTime(timestamp: number, t: (key: string) => string, language?: string): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t("time.justNow")
  if (minutes < 60) return t("time.mAgo").replace("{n}", String(minutes))
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("time.hAgo").replace("{n}", String(hours))
  const days = Math.floor(hours / 24)
  if (days < 7) return t("time.dAgo").replace("{n}", String(days))
  // Past a week the relative form stops being useful and we print the date. Same
  // locale source as the transcript's timestamps: the UI language, not the OS
  // (lib/format-time.ts). Falls back to "" only for a corrupt timestamp.
  return formatDateOnly(timestamp, language) ?? ""
}

interface SessionGroup {
  label: string
  sessions: Session[]
}

/**
 * Snapshot of the list order, taken while the pointer sits over the sidebar.
 * `recency` pins the sort/group key per session; `ids` is the row set at freeze
 * time, so sessions born mid-freeze stay out instead of splicing in on top.
 */
export interface FrozenOrder {
  ids: Set<string>
  recency: Map<string, number>
}

export function snapshotOrder(rows: Session[]): FrozenOrder {
  return {
    ids: new Set(rows.map((s) => s.id)),
    recency: new Map(rows.map((s) => [s.id, s.time.updated])),
  }
}

/** Sort/group key: the frozen value while frozen, else live last-activity. */
export function recencyOf(session: Session, frozen: FrozenOrder | null): number {
  return frozen?.recency.get(session.id) ?? session.time.updated
}

/**
 * Sidebar order, DERIVED — never held in state. useSessions patches a session in
 * place on SSE session.updated (index untouched), so a gateway prompt bumping
 * time.updated reordered nothing and IM traffic never surfaced in the list.
 * Deriving at render makes order a pure function of the data, with no
 * effect-ordering race to lose (ADR-048 took the same turn with `settled`).
 */
export function orderSessions(sessions: Session[], frozen: FrozenOrder | null): Session[] {
  const visible = frozen ? sessions.filter((s) => frozen.ids.has(s.id)) : sessions
  return [...visible].sort((a, b) => recencyOf(b, frozen) - recencyOf(a, frozen))
}

/**
 * Group by LAST ACTIVITY, not creation. The list is sorted by time.updated, so
 * grouping by time.created tore the two apart: a channel session created weeks
 * ago but woken by an IM message today stayed pinned under 「更早」 — first in a
 * group nobody scrolls to — even after a manual refresh. Headings read as "what
 * moved today", so they must key off the same clock the order does.
 *
 * `frozen` is required rather than defaulted: sort and grouping must read the SAME
 * key or they tear apart again. A default would let a caller silently drop it —
 * rows hopping date groups mid-hover — while these unit tests, which pass `frozen`
 * explicitly, stayed green. Let tsc catch it instead.
 */
export function groupSessionsByDate(
  sessions: Session[],
  t: (key: string) => string,
  frozen: FrozenOrder | null,
): SessionGroup[] {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000

  const today: Session[] = []
  const yesterday: Session[] = []
  const thisWeek: Session[] = []
  const earlier: Session[] = []

  sessions.forEach((session) => {
    const active = recencyOf(session, frozen)
    if (active >= todayStart) {
      today.push(session)
    } else if (active >= yesterdayStart) {
      yesterday.push(session)
    } else if (active >= weekStart) {
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
  const {
    sessions,
    loading,
    activeSessionIds,
    deleteSession,
    renameSession,
    search: searchQuery,
    setSearch: setSearchQuery,
    hasMore,
    loadMore,
  } = useSessionsContext()
  const [showSearch, setShowSearch] = useState(false)
  const { toggleFavorite, isFavorite } = useFavorites()
  const { entryOf } = useTeamSessions()
  const { entryOf: channelEntryOf } = useChannelSessions()
  const { isUnread } = useUnread()
  const { dropDraft } = useDraftDispatch()
  const { workspacePath } = useWorkspace()
  const { t, language } = useI18n()

  // "+" goes Home instead of creating a session: the session is born on the
  // first Home send, after the agent is chosen (档1: one session, one agent).
  const handleNewChat = () => navigate("/")

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    try {
      await deleteSession(sessionId)
      // Its draft can never be reached again; without this the bucket (and any
      // megabyte-scale data: URLs in it) would sit in memory for the rest of the session.
      dropDraft(sessionDraftKey(sessionId))
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

  // On the Settings page the sidebar is force-collapsed (Settings has its own
  // left nav), regardless of the user's real `leftOpen` preference. Deriving it
  // from the route means leaving Settings automatically restores the preference
  // — no global state to save/restore.
  const isSettings = isSettingsPath(location.pathname)
  const effectiveOpen = leftOpen && !isSettings

  // The query also goes to the SERVER (useSessions), so results are no longer
  // limited to the loaded window — this local pass only keeps the list responsive
  // between a keystroke and the debounced round-trip. Same substring rule, so it
  // can never hide a row the server chose to return.
  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) =>
        session.title.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [sessions, searchQuery]
  )

  // Freeze the order while the pointer is over the list: an IM message floating an
  // old session to the top is exactly what we want, EXCEPT when it reshuffles rows
  // under a cursor that is about to click (mis-click). Contents (title, relative
  // time) keep updating live underneath; only the order is held. Thaws on leave.
  const [frozen, setFrozen] = useState<FrozenOrder | null>(null)

  const orderedSessions = useMemo(
    () => orderSessions(filteredSessions, frozen),
    [filteredSessions, frozen]
  )

  // Read by the freeze handler only — keeps it out of the dependency cycle it would
  // otherwise form (freezing reads the very order it is about to freeze).
  const orderedRef = useRef<Session[]>(orderedSessions)
  orderedRef.current = orderedSessions

  const freezeOrder = useCallback(() => {
    setFrozen((prev) => prev ?? snapshotOrder(orderedRef.current))
  }, [])

  const thawOrder = useCallback(() => setFrozen(null), [])

  // Search re-filters the list and a workspace switch replaces it wholesale; a
  // stale freeze would withhold every row that is not in its `ids`. In both cases
  // the pointer is off the rows anyway, so there is nothing left to protect.
  useEffect(() => {
    setFrozen(null)
  }, [searchQuery, workspacePath])

  const sessionGroups = groupSessionsByDate(orderedSessions, t, frozen)

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          // select-none: the whole left sidebar is navigational chrome, not
          // readable copy — pressing a row and dragging down should never start a
          // cross-row text selection (mainstream agent sidebars behave the same).
          // The two <input>s below opt back in with select-text.
          "flex h-full shrink-0 flex-col select-none bg-[var(--sidebar-bg)] transition-all duration-300",
          effectiveOpen ? "w-64" : isMacOS ? "w-[68px]" : "w-12"
        )}
      >
        {effectiveOpen ? (
          <>
            {/* Expanded: Brand. Sidebar collapse lives in the main-area TopBar
                (single toggle, avoids the duplicate that sat here). */}
            <div onMouseDown={handleDrag} className="flex shrink-0 items-center gap-3 p-4 pt-9">
              <button
                onClick={() => navigate("/")}
                className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
              >
                <Logo className="size-8" />
                <span className="text-sm font-semibold tracking-wide text-[var(--sidebar-fg)]">
                  {t("brand.name")}
                </span>
              </button>
            </div>

            {/* Action buttons: new-task, then the capability-extension shortcuts
                (Connectors / Skills / Tools / Channels), with search last (a
                low-frequency utility). Six size-8 icons fit the w-64 rail; the
                extensions deep-link into /settings via router state — pure nav. */}
            <nav className="flex shrink-0 items-center gap-1 px-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleNewChat}
                    className="flex size-8 items-center justify-center rounded-lg text-[var(--sidebar-fg-muted)] transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
                  >
                    <Plus className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("sidebar.newTask")}</TooltipContent>
              </Tooltip>

              {EXTENSION_ENTRIES.map((entry) => (
                <Tooltip key={entry.section}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => navigate("/settings", { state: { section: entry.section } })}
                      aria-label={t(entry.labelKey)}
                      className="flex size-8 items-center justify-center rounded-lg text-[var(--sidebar-fg-muted)] transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
                    >
                      <entry.icon className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t(entry.labelKey)}</TooltipContent>
                </Tooltip>
              ))}

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setShowSearch(!showSearch)}
                    // Every sibling in this row carries one; this control had only
                    // a tooltip, leaving it unnamed for assistive tech (and for
                    // any test that asks for controls by name).
                    aria-label={t("sidebar.search")}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-lg transition-colors",
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

              {/* TODO: 定时任务 (sidebar.scheduled) — 未实现，暂隐藏 */}
              {/* TODO: 自定义 (sidebar.custom) — 未实现，暂隐藏 */}
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
                    className="w-full select-text rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-9 pr-3 text-[13px] text-[var(--sidebar-fg)] placeholder:text-[var(--sidebar-fg-muted)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                  />
                </div>
              </div>
            )}

            {/* Task/Sessions list */}
            <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden px-3">
              <div
                onMouseEnter={freezeOrder}
                onMouseLeave={thawOrder}
                className="scrollbar-soft flex-1 space-y-0.5 overflow-y-auto"
              >
                {loading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="size-4 animate-spin text-[var(--sidebar-fg-muted)]" />
                  </div>
                ) : orderedSessions.length === 0 ? (
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
                          <h3 className="px-2 py-0.5 text-xs font-medium tracking-wider text-[var(--sidebar-fg-muted)] opacity-70">
                            {group.label}
                          </h3>
                          {pinnedSessions.map((session) => (
                            <SessionItem
                              key={session.id}
                              session={session}
                              teamEntry={entryOf(session.id)}
                              channelEntry={channelEntryOf(session.id)}
                              isUnread={isUnread(session)}
                              isActive={currentSessionId === session.id}
                              isRunning={activeSessionIds.has(session.id)}
                              isPinned={true}
                              onNavigate={() => navigate(`/session/${session.id}`)}
                              onDelete={(e) => handleDeleteSession(e, session.id)}
                              onRename={(newTitle) => handleRenameSession(session.id, newTitle)}
                              onTogglePin={() => toggleFavorite(session.id)}
                              t={t}
                              language={language}
                            />
                          ))}
                          {unpinnedSessions.map((session) => (
                            <SessionItem
                              key={session.id}
                              session={session}
                              teamEntry={entryOf(session.id)}
                              channelEntry={channelEntryOf(session.id)}
                              isUnread={isUnread(session)}
                              isActive={currentSessionId === session.id}
                              isRunning={activeSessionIds.has(session.id)}
                              isPinned={false}
                              onNavigate={() => navigate(`/session/${session.id}`)}
                              onDelete={(e) => handleDeleteSession(e, session.id)}
                              onRename={(newTitle) => handleRenameSession(session.id, newTitle)}
                              onTogglePin={() => toggleFavorite(session.id)}
                              t={t}
                              language={language}
                            />
                          ))}
                        </div>
                      )
                    })}
                    {/* The list is a "newest N" window, and the endpoint has no
                        cursor — so older sessions were simply unreachable before
                        this, however many of them existed. */}
                    {hasMore && (
                      <button
                        onClick={() => {
                          // Thaw first. The freeze exists to stop BACKGROUND churn
                          // (an IM message floating a session to the top) from
                          // reshuffling rows under a cursor that is about to
                          // click — but clicking here IS the user asking for more
                          // rows, and `orderSessions` renders only the frozen id
                          // set, so leaving it on makes the button appear to do
                          // nothing until the pointer leaves the list.
                          thawOrder()
                          loadMore()
                        }}
                        className="w-full rounded-lg px-2 py-2 text-xs text-[var(--sidebar-fg-muted)] transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
                      >
                        {t("sidebar.loadMore")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Footer: User avatar + Settings.
                019 后续：「自动化」（流水线/Fan-out）入口暂时下线——surface 需一次真正
                的 UI/UE 设计且属低频高级功能；orchestrator 后端由 Team delegate 共用、
                未死。路由 /orchestration 保留可深链，PipelineTab/OrchestrationRun 代码
                原样在册，恢复只需加回此入口。详见 docs/discussions/019 §7。 */}
            <div className="mt-auto shrink-0 space-y-2 p-3">
              <SettingsPopover>
                <button
                  aria-label="User settings"
                  className="flex w-full items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[var(--sidebar-accent)]"
                >
                  <div className="flex size-8 items-center justify-center rounded-full bg-[var(--color-brand)] text-sm font-semibold text-white">
                    Y
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    <p className="truncate text-[13px] font-medium text-[var(--sidebar-fg)]">
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
            <div onMouseDown={handleDrag} className="flex shrink-0 items-center justify-center p-2 pt-9">
              <button
                onClick={() => navigate("/")}
                aria-label="Home"
                className="flex size-8 items-center justify-center rounded-lg transition-all hover:ring-2 hover:ring-[var(--sidebar-fg-muted)]"
              >
                <Logo className="size-8" />
              </button>
            </div>

            <div className="flex shrink-0 flex-col items-center gap-1 px-1 pt-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleNewChat}
                    aria-label={t("sidebar.newTask")}
                    className="flex size-9 items-center justify-center rounded-lg text-[var(--sidebar-fg-muted)] transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
                  >
                    <Plus className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{t("sidebar.newTask")}</TooltipContent>
              </Tooltip>

              {/* The "expand sidebar" toggle is hidden on Settings: there the
                  collapse is route-derived and locked, so toggling would only
                  pollute the user's real `leftOpen` for after they leave. */}
              {!isSettings && (
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
              )}

              {/* Extensions: collapsed-rail parity with the expanded list. */}
              {EXTENSION_ENTRIES.map((entry) => (
                <Tooltip key={entry.section}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => navigate("/settings", { state: { section: entry.section } })}
                      aria-label={t(entry.labelKey)}
                      className="flex size-9 items-center justify-center rounded-lg text-[var(--sidebar-fg-muted)] transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-fg)]"
                    >
                      <entry.icon className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{t(entry.labelKey)}</TooltipContent>
                </Tooltip>
              ))}
              {/* 019 后续：折叠态「自动化」入口同步下线（见展开态注释 / 019 §7）。 */}
            </div>

            {/* Empty vertical strip doubles as a window drag handle — collapsed
                mode otherwise loses the wide brand-bar handle the expanded state
                has (handleDrag skips buttons, so the icon column stays clickable). */}
            <div onMouseDown={handleDrag} className="flex-1" />

            <div className="flex shrink-0 flex-col items-center gap-2 px-1 pb-3">
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

/** Which IM a session came from. The gateway's "[钉钉·张三]" title prefix is text
 *  the user cannot scan at a glance — and it only lands after the first turn. */
function ChannelBadge({ entry }: { entry: ChannelSessionEntry }) {
  // A v1 entry migrated from the old flat store has no channel type until its chat
  // is seen again — rendering it would put a mute, tooltip-less icon on the row.
  // Say nothing rather than something meaningless.
  if (!entry.channelType) return null

  const Icon = CHANNEL_TYPE_ICONS[entry.channelType]
  const label = entry.senderName
    ? `${entry.channelType} · ${entry.senderName}`
    : entry.channelType
  return (
    <span
      title={label}
      aria-label={label}
      className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-brand)]/10 p-0.5 text-[var(--color-brand)]"
    >
      {Icon ? <Icon className="size-3" /> : <MessageSquare className="size-3" />}
    </span>
  )
}

export function SessionItem({
  session,
  teamEntry,
  channelEntry,
  isUnread,
  isActive,
  isRunning,
  isPinned,
  onNavigate,
  onDelete,
  onRename,
  onTogglePin,
  t,
  language,
}: {
  session: { id: string; title: string; time: { created: number; updated: number } }
  /** Present when this session is a Team leader (018 A-1 混排+徽标). */
  teamEntry?: TeamSessionEntry
  /** Present when an IM chat owns this session (gateway registry). */
  channelEntry?: ChannelSessionEntry
  isUnread: boolean
  isActive: boolean
  isRunning: boolean
  isPinned: boolean
  onNavigate: () => void
  onDelete: (e: React.MouseEvent) => void
  onRename: (newTitle: string) => void
  onTogglePin: () => void
  t: (key: string) => string
  /** UI language for the row tooltip's date. Optional: omitting it falls back to
   *  the system locale, which is what a bare render (tests) gets. */
  language?: string
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  // Registry title is the legacy fallback — new team leaders are roots and
  // get the opencode auto-title in session.title like any chat.
  const title = session.title || teamEntry?.title || `Session ${session.id.slice(0, 8)}`

  // Rows are single-line (title only) to match mainstream agent sidebars and
  // stay compact; the relative time that used to live on a second line now
  // rides on the row's hover tooltip together with the full title. The title is
  // capped so a very long name doesn't produce an unwieldy tooltip.
  const tooltipTitle = title.length > 60 ? `${title.slice(0, 60)}…` : title
  const rowTooltip = `${tooltipTitle}\n${formatTime(session.time.updated, t, language)}`

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

  // Status icon: only the *running* spinner earns a permanent left slot — a
  // completed check / idle bubble on every row just squeezed the title without
  // adding information (mainstream agent sidebars show titles flush-left). When
  // idle we render nothing, so the title starts at the row edge.
  const StatusIcon = () => {
    if (isRunning) {
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--color-brand)]" />
    }
    return null
  }

  if (isEditing) {
    return (
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-lg px-3 py-1 text-[13px]",
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
          className="min-w-0 flex-1 select-text bg-transparent outline-none"
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
      title={rowTooltip}
      // Stable hook for e2e/session-reachability (mirrors the command menu's
      // data-index). Class names here are layout, and layout churns.
      data-session-row={session.id}
      className={cn(
        "group relative flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1 text-[13px] transition-all duration-150",
        isActive
          ? "bg-[var(--sidebar-accent)] font-medium text-[var(--sidebar-fg)]"
          : "text-[var(--sidebar-fg-muted)] hover:bg-[var(--sidebar-accent-hover)] hover:text-[var(--sidebar-fg)]",
        isPinned && "border-l-[3px] border-[var(--color-primary)]"
      )}
    >
      {/* Pin status is shown via the left accent bar (border-l) + top sorting;
          the pin/unpin action lives in the three-dot menu below. */}
      <StatusIcon />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          {teamEntry && (
            <span
              title={`${teamEntry.members.length} ${t("team.membersCount")}`}
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--color-brand)]/15 px-1.5 py-px text-[10px] font-medium text-[var(--color-brand)]"
            >
              <Crown className="size-2.5" />
              {t("team.badge")}
            </span>
          )}
          {channelEntry && <ChannelBadge entry={channelEntry} />}
          <span
            className={cn(
              "truncate",
              // Unread reads as weight + full-strength text, not just the dot —
              // the dot alone is easy to miss in a long list.
              isUnread && !isActive && "font-medium text-[var(--sidebar-fg)]",
              !isActive && !isUnread && "text-[var(--sidebar-fg-soft)] group-hover:text-[var(--sidebar-fg)]"
            )}
          >
            {title}
          </span>
          {isUnread && !isActive && (
            <span
              aria-label={t("sidebar.unread")}
              title={t("sidebar.unread")}
              className="ml-auto size-2 shrink-0 rounded-full bg-[var(--color-brand)]"
            />
          )}
        </p>
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
