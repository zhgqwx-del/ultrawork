import { useEffect, useRef, useState, useCallback, useMemo } from "react"
import { useParams, useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { TopBar } from "@/components/layout/top-bar"
import { handleDrag } from "@/components/layout/drag-region"
import { useSidebar } from "@/components/layout/sidebar-context"
import { useSessionsContext } from "@/lib/sessions-context"
import { commandsAvailableFor } from "@/lib/command-menu"
import { useModel } from "@/lib/model-context"
import { useSessionMessages } from "@/lib/use-session-messages"
import { useSessionPlan } from "@/lib/use-session-plan"
import { useSessionArtifacts } from "@/lib/use-session-artifacts"
import { useDelegateRows } from "@/lib/use-delegate-rows"
import { useArtifactUnread } from "@/lib/use-artifact-unread"
import { useConfig } from "@/lib/config-context"
import { useSessionPermission } from "@/lib/use-session-permission"
import { useSessionScroll } from "@/lib/use-session-scroll"
import { ChatInput, MessageList, ModelSelector, AgentSelector, AgentAvatar } from "@/components/chat"
import { useConnector } from "@/lib/sse-context"
import { useAttachments } from "@/lib/use-attachments"
import { useScreenshot } from "@/lib/use-screenshot"
import { ExecutionStatus } from "@/components/chat/execution-status"
import { PermissionDock } from "@/components/chat/permission-dock"
import { QuestionDock } from "@/components/chat/question-dock"
import { DelegateDock } from "@/components/chat/delegate-dock"
import { useWorkspace } from "@/lib/workspace-context"
import { useAgents } from "@/lib/agent-context"
import { useTeamSessions } from "@/lib/team-sessions-context"
import { buildLeaderSystemPrompt } from "@/lib/team-leader-prompt"
import { isACPAgentId } from "@agent/connector"
import { cn } from "@/lib/utils"
import { PanelRight, Crown, ArrowDown } from "lucide-react"
import { PlanPanel, ArtifactsPanel, WorkspacePanel, ArtifactPreview, TeamHeader } from "@/components/session"
import { RightSidebarSection } from "@/components/session/right-sidebar-section"
import { UnreadBadge } from "@/components/ui/unread-badge"
import type { Artifact } from "@/components/session"
import { useI18n } from "@/lib/i18n-context"
import { useMarkReadWhileOpen } from "@/lib/use-unread"
import type { Attachment } from "@/lib/attachments"
import { sessionDraftKey, useDraftBucket, useDraftDispatch } from "@/lib/draft-context"

export function SessionPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { sessions, activeSessionIds } = useSessionsContext()
  const { t } = useI18n()
  const { currentModel, setModel, maybeOfferFreeTrial } = useModel()
  const { rightOpen, toggleRight, setRightOpen, previewMode, openPreview, closePreview, togglePreviewMaximized } = useSidebar()
  const { workspacePath } = useWorkspace()
  const { config } = useConfig()

  // Composer state is keyed by session id, NOT component-local. react-router reuses this
  // element across a :id change (no remount), so a local draft would follow the user from
  // session A into session B; and a route change away DOES unmount, so a local draft would
  // be lost on return. One keyed bucket fixes both (discussions/060). The sibling reset
  // effect below already treats per-session UI state this way — it just never covered the
  // composer.
  const draftKey = sessionDraftKey(id)
  const draft = useDraftBucket(draftKey)
  const { patchDraft, clearDraft } = useDraftDispatch()
  const input = draft.text
  const setInput = useCallback(
    (text: string) => patchDraft(draftKey, { text }),
    [patchDraft, draftKey],
  )
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null)

  const session = sessions.find(s => s.id === id)

  // The session you are looking at is, by definition, read. Re-marks on every
  // time.updated bump — including the local one useSessions stamps when a turn
  // goes idle — so an open session can never flag itself unread.
  useMarkReadWhileOpen(id, session?.time.updated)

  // Team session (018 统一交互): identity comes from the sidecar registry.
  const { entryOf } = useTeamSessions()
  const { agents, getSessionAgentId } = useAgents()
  const teamEntry = entryOf(id)
  // Whether THIS session can own delegates (→ render the DelegateDock). opencode
  // single-agent sessions deny `orchestrator_*` (can't delegate); only Team
  // Leaders do. ACP sessions can delegate when their agent has orchestratorMcp on
  // — we can't cheaply read that flag here, so we include all ACP-bound sessions
  // (a non-delegating one just shows an empty dock; the important thing is we
  // never HIDE the dock from a session that does delegate, which would strand its
  // child-permission relay). Cross-team leakage is now prevented at the row level
  // by `ownerSessionId` scoping in the dock (discussions/022 §8.5); this gate just
  // keeps the dock off non-delegating sessions.
  const canShowDelegates = !!teamEntry || isACPAgentId(getSessionAgentId(id))

  // Capability-gated UI (ADR-030 D-5): model override only where supported.
  const connector = useConnector()
  const supportsModel = connector.capabilitiesOf(id).model

  // Read navigation state once per session change
  const navState = location.state as { sending?: boolean; messageText?: string } | null

  // opencode leaders carry the orchestration instructions on EVERY turn
  // (promptAsync system append) plus the built-in task deny (017 拍板 #2).
  // ACP leaders received the prompt once at session creation — nothing extra.
  const promptOptions = useMemo(() => {
    if (!teamEntry || isACPAgentId(teamEntry.leaderAgentId)) return undefined
    const members = teamEntry.members.map((memberId) => {
      const agent = agents.find((a) => a.id === memberId)
      return { id: memberId, name: agent?.name ?? memberId, description: agent?.description }
    })
    return {
      system: buildLeaderSystemPrompt({ workspace: teamEntry.workspace, members }),
      tools: { task: false },
    }
  }, [teamEntry, agents])

  // --- Message management hook ---
  const {
    messages,
    allMessages,
    sending,
    loading,
    streamingMessageId,
    stopped,
    stoppedAtMessageId,
    toolCompletionCount,
    turnStart,
    hasMore,
    historyLoading,
    sendMessage,
    stopGeneration,
    loadEarlierMessages,
    onScrollNearTop,
  } = useSessionMessages(id, {
    initialSending: !!navState?.sending,
    initialMessageText: navState?.messageText,
    // Legacy team sessions may be missing from SessionsContext — the
    // registry knows their directory.
    directory: teamEntry?.workspace,
    promptOptions,
  })

  // --- Permission/Question management hook ---
  // sessionBusy = app-level "this session has a turn in flight" truth that
  // SURVIVES switching away/back (fed by opencode session.status in use-sessions;
  // ACP stays false → covered separately by the sidecar running endpoint). Local
  // `sending`/`streamingMessageId` reset to false on remount, so without this a
  // turn still running when you re-open the session would false-render as
  // completed (green check + collapsed flow + footer) and lose the stop button
  // during model-thinking gaps. See docs/discussions/022.
  const sessionBusy = !!id && activeSessionIds.has(id)
  const isAgentActive = sending || streamingMessageId !== null || sessionBusy

  // Task plan (ADR-038): session-level state hydrated from backend truth +
  // live plan.updated. Shown only when the agent actually produced a plan
  // (complex tasks); simple tasks fall back to the Activity section below.
  const { steps: planSteps } = useSessionPlan(id)
  const {
    pendingPermission,
    pendingQuestion,
    replyPermission,
    replyQuestion,
    rejectQuestion,
  } = useSessionPermission(id, isAgentActive)

  // Delegate activity + relayed child permissions. Held HERE, not inside the dock:
  // the maximized preview re-parents the dock, and a remount would silently drop
  // every pending child permission (the delegate SSE snapshot replays delegates but
  // not pending permission requests) — stranding the child until it timed out.
  const delegateRows = useDelegateRows(id, workspacePath)

  // --- Scroll management hook ---
  const { scrollRef, contentRef, isAtBottom, forceScrollToBottom, jumpToBottom } = useSessionScroll({
    onScrollNearTop,
    sessionId: id,
  })

  // --- UI handlers ---
  const workspaceRefreshKey = toolCompletionCount
  // Legacy Team Leader sessions may be absent from SessionsContext (so `session`
  // is undefined); the team registry still knows the workspace. Fall back to it
  // so the workspace tree, artifacts scan, and preview all resolve paths.
  const workspaceDir = session?.directory ?? teamEntry?.workspace

  // Composer attachments. ACP/Team backends declare capabilities.image = false and their
  // prompt() throws on attachments, so the entry point is disabled there rather than
  // letting the user attach a file that would only blow up on send.
  const attachStore = useMemo(
    () => ({
      key: draftKey,
      items: draft.attachments,
      setItems: (next: Attachment[]) => patchDraft(draftKey, { attachments: next }),
    }),
    [draft.attachments, patchDraft, draftKey],
  )
  const attach = useAttachments(currentModel, attachStore)
  const shot = useScreenshot(attach.add)
  // Read the BACKEND's image capability live per render (same pattern as `supportsModel`
  // above), NOT inside the memo keyed on `connector`/`id`. Switching a fresh session's agent
  // (opencode→ACP) via the in-session AgentSelector flips the backend without changing `id`
  // or `connector` identity, so a memo keyed on those would go stale and leave attachments
  // enabled on a text-only ACP backend — whose prompt() throws on attachments (the exact
  // silent-drop/blow-up this feature exists to prevent).
  const backendAcceptsAttachments = connector.capabilitiesOf(id).image
  // True while attachments are being materialised (a document copy can take seconds).
  const [preparing, setPreparing] = useState(false)
  const attachmentSlot = useMemo(
    () => ({
      items: attach.items,
      add: attach.add,
      addPaths: attach.addPaths,
      remove: attach.remove,
      blocker: attach.blocker,
      checking: attach.checking,
      disabled: !backendAcceptsAttachments,
      screenshot: shot,
    }),
    [attach.items, attach.add, attach.addPaths, attach.remove, attach.blocker, attach.checking, backendAcceptsAttachments, shot],
  )

  // Artifacts (ADR-048 D5): derived at session level, not inside the sidebar
  // panel, because the unread badge and the preview's prev/next navigation both
  // need them while the sidebar is closed.
  const {
    ordered: orderedArtifacts,
    deliverables,
    working,
    settled: artifactsSettled,
    byTurn: artifactsByTurn,
  } = useSessionArtifacts(allMessages, workspaceDir, isAgentActive)

  // --- Awareness (ADR-048 D1) ---
  // Two events, two treatments. A plan is the turn's roadmap: it lands once and
  // is worth revealing. Artifacts arrive in batches at the end of a turn, so
  // opening the sidebar for each would keep stealing focus — they get a badge.
  // Both defer to the user: a hand-closed sidebar suppresses auto-reveal for the
  // rest of the session.
  const [autoRevealSuppressed, setAutoRevealSuppressed] = useState(false)
  const planRevealedRef = useRef(false)

  // Unread artifacts. Seen-ness is tracked by path and survives session switches —
  // see the hook for why a count doesn't work.
  // `hasHistory` = this session already had assistant turns before we opened it. A
  // brand-new session must not wait for the (idle-only) workspace scan before
  // seeding — see the hook.
  const hasHistory = useMemo(
    () => allMessages.some((m) => m.info?.role === "assistant"),
    [allMessages],
  )
  const { unread: unreadArtifacts, markSeen: markArtifactsSeen } = useArtifactUnread(
    id,
    orderedArtifacts,
    { loading, settled: artifactsSettled, hasHistory },
  )

  // --- Reset per-session UI state on session change ---
  useEffect(() => {
    setSelectedArtifact(null)
    closePreview()
    setAutoRevealSuppressed(false)
    planRevealedRef.current = false
    // Seen-ness is NOT reset — it lives in useArtifactUnread, keyed by session id.
  }, [id, closePreview])

  // The preview owns nothing but the artifact it shows: `previewMode` is the
  // single source of truth for whether it's up, so anything that closes it
  // (Escape, the sidebar taking over) also clears the selection.
  useEffect(() => {
    if (previewMode === "closed") setSelectedArtifact(null)
  }, [previewMode])

  const hasPlan = planSteps.length > 0
  useEffect(() => {
    if (!hasPlan || planRevealedRef.current) return
    if (autoRevealSuppressed || !config.planAutoReveal) return
    // The preview and the sidebar are mutually exclusive, and the preview is
    // where the user is looking — don't yank it out from under them. Hold the
    // reveal (don't burn the once-per-session flag) until the preview closes.
    if (previewMode !== "closed") return
    planRevealedRef.current = true
    setRightOpen(true)
  }, [hasPlan, autoRevealSuppressed, config.planAutoReveal, previewMode, setRightOpen])

  const handleToggleRight = useCallback(() => {
    // Closing by hand is a standing instruction, not a one-off: stop auto-revealing
    // the sidebar for the rest of this session (VS Code's "manual wins").
    if (rightOpen) setAutoRevealSuppressed(true)
    toggleRight()
  }, [rightOpen, toggleRight])

  const handleSend = async () => {
    // An attachment with no text is a legitimate turn ("look at this screenshot").
    if (!id || (!input.trim() && attach.items.length === 0)) return
    // `checking` matters as much as `blocker`: the gate awaits a 4 MB GET /provider, and
    // pasting an image then hitting Enter immediately would otherwise sail straight past a
    // check that simply had not finished computing yet.
    if (attach.blocker || attach.checking || preparing) return

    // Pre-dispatch consent gate (ADR-057): if the only usable models are free Zen models and the
    // user hasn't opted in, offer the trial instead of dispatching (the server would otherwise
    // route their code to a free model with no consent). Placed BEFORE materialize so the
    // post-consent auto-retry re-enters cleanly without double-copying attachments. Gated on
    // `supportsModel` (false for ACP sessions, which ignore the opencode model) so ACP team/single
    // sessions don't get a meaningless free-Zen-model card.
    if (supportsModel && await maybeOfferFreeTrial(() => { void handleSend() })) return

    // Documents are copied into the workspace here (not at attach time) and their paths
    // appended to the prompt, since OpenCode can't inline them (discussions/039 §3.2).
    // That copy can take seconds for a large file — hence `preparing`, which disables the
    // composer. Without it a second Enter starts a SECOND materialize: the file gets copied
    // into the workspace twice (uniquified), and the second send is then swallowed by
    // sendMessage's own guard, leaving an orphaned copy nothing refers to.
    setPreparing(true)
    try {
      const { attachments, noteText } = await attach.materialize(id, workspaceDir)
      const text = input.trim() + noteText
      // Every attachment can fail to materialise (no workspace, copy failed, file vanished).
      // sendMessage would then find nothing to send and return SILENTLY — while we cleared the
      // composer, which reads exactly like a successful send. Keep the user's input and say so.
      if (!text.trim() && attachments.length === 0) {
        toast.error(t("attachment.nothingToSend"))
        return
      }
      sendMessage(text, currentModel, attachments)
      // Consumed by a real turn — drop the whole bucket. Sits after the early return above,
      // so a turn that materialised nothing keeps the user's input. attach.clear() first:
      // this page is NOT unmounted after a send, so the hook's cap bookkeeping would keep
      // counting the files we just sent.
      attach.clear()
      clearDraft(draftKey)
      // Force scroll to bottom after sending, even if user was viewing history
      forceScrollToBottom()
    } finally {
      setPreparing(false)
    }
  }

  // The row that chat / preview / sidebar share. Measured (not derived from
  // window.innerWidth minus an assumed sidebar width) so the half-vs-full decision
  // can't drift away from what's actually on screen.
  const columnsRowRef = useRef<HTMLDivElement>(null)
  const revealPreview = useCallback(() => {
    openPreview(columnsRowRef.current?.getBoundingClientRect().width)
  }, [openPreview])

  const handleArtifactClick = useCallback((artifact: Artifact) => {
    setSelectedArtifact({ ...artifact, sessionId: id })
    revealPreview()
  }, [id, revealPreview])

  const handleFileTreeClick = useCallback((path: string) => {
    setSelectedArtifact({ type: "file", path })
    revealPreview()
  }, [revealPreview])

  const handleClosePreview = useCallback(() => {
    closePreview()
  }, [closePreview])

  // Prev/next through the artifact list (ADR-048 D3). A file opened from the
  // workspace tree isn't in that list — `indexOf` returns -1 and the nav controls
  // stay hidden rather than pretending to be somewhere.
  const previewIndex = useMemo(
    () => (selectedArtifact ? orderedArtifacts.findIndex((a) => a.path === selectedArtifact.path) : -1),
    [selectedArtifact, orderedArtifacts],
  )
  const stepPreview = useCallback((delta: number) => {
    const next = orderedArtifacts[previewIndex + delta]
    if (next) setSelectedArtifact({ ...next, sessionId: id })
  }, [orderedArtifacts, previewIndex, id])
  const previewNav = previewIndex >= 0
    ? {
        index: previewIndex,
        total: orderedArtifacts.length,
        onPrev: () => stepPreview(-1),
        onNext: () => stepPreview(1),
      }
    : undefined

  const previewOpen = previewMode !== "closed" && !!selectedArtifact
  const maximized = previewMode === "full" && !!selectedArtifact

  // While the transcript is hidden (full preview), tell the user when the agent
  // has answered — otherwise a reply lands somewhere they can't see and the app
  // looks dead. Baseline = the message count at the moment we went full.
  //
  // Count ASSISTANT messages, not all messages: `sendMessage` appends a temp user
  // message synchronously, so a total-count baseline would flip the banner to
  // "the agent replied" the instant the user sent something from this very bar —
  // which is the main thing they do in `full` ("看着产物提修改意见"). Only the
  // agent's own turns count as a reply.
  //
  // And it has to be state, not a ref: a ref starts at 0, so on the first frame of
  // `full` every pre-existing message would read as new, and since writing a ref
  // doesn't re-render, that lie would stay on screen. `null` until the effect runs
  // means the first frame claims nothing — the safe direction.
  const assistantCount = useMemo(
    () => messages.reduce((n, m) => (m.info?.role === "assistant" ? n + 1 : n), 0),
    [messages],
  )
  const [fullBaseline, setFullBaseline] = useState<number | null>(null)
  useEffect(() => {
    setFullBaseline(maximized ? assistantCount : null)
    // Deliberately keyed on `maximized` only: we want the count as it was when we
    // went full, not a baseline that chases every new message.
  }, [maximized])
  const repliedWhileHidden = maximized && fullBaseline !== null && assistantCount > fullBaseline

  // Restore the bottom when leaving `full`.
  //
  // Don't rely on the transcript having stayed pinned while it was hidden: measured
  // on WebKit, a reply that lands during `full` leaves the (hidden) view ~122px off
  // the bottom, and Chromium differs because it has native scroll anchoring and
  // WebKit doesn't (ADR-047). Sticking inside a hidden subtree is simply not a
  // guarantee worth building on.
  //
  // The intent is easy to state without it: if you were at the bottom when you went
  // full-screen, you're at the bottom when you come back — so you see the reply that
  // arrived while you were reading. If you had scrolled up to read history, we leave
  // you where you were.
  // The snapshot must be taken at the moment we ENTER full, and read through a ref:
  // once the transcript is hidden `isAtBottom` drifts (that's the whole problem), so
  // an effect that re-ran on `isAtBottom` would overwrite the snapshot with the very
  // drift it exists to survive.
  const atBottom = useRef(true)
  atBottom.current = isAtBottom
  const wasPinnedBeforeFull = useRef(true)
  const prevMaximized = useRef(false)
  useEffect(() => {
    const entering = !prevMaximized.current && maximized
    const leaving = prevMaximized.current && !maximized
    prevMaximized.current = maximized
    if (entering) wasPinnedBeforeFull.current = atBottom.current
    else if (leaving && wasPinnedBeforeFull.current) forceScrollToBottom()
  }, [maximized, forceScrollToBottom])

  // ACTION-REQUIRED docks. These follow the preview into `full` (ADR-048 D4): each
  // one is something the agent is BLOCKED on, so hiding it doesn't declutter the
  // screen, it strands a turn. They render nothing when there's nothing to answer
  // (DelegateDock returns null when it has no rows), so in the common case `full`
  // shows none of them and stays clean.
  //
  // DelegateDock in particular relays CHILD permission requests from delegated
  // agents; a blocked child is exactly as stuck as a blocked parent. The first
  // version left it behind in the (hidden, inert) chat column, which would have
  // stranded the delegate until its sidecar timed out — no visible cause, nothing
  // to click.
  const actionDocks = (
    <>
      {/* Active delegates + relayed child permissions (ADR-031 ②). Scoping
          (discussions/022 §8.5): (1) `canShowDelegates` keeps the dock off
          non-delegating sessions; (2) `isAgentActive` hides it on idle/completed
          sessions (a delegate call blocks its leader's turn, so a session with
          running delegates is itself busy); (3) the dock filters rows by
          `ownerSessionId === this session` — delegates are tagged with their
          leader session (opencode via MCP `_meta`, ACP via per-session env), so
          two teams in one workspace never cross-show, even simultaneously. */}
      {canShowDelegates && isAgentActive && (
        <div className="flex shrink-0 justify-center">
          <DelegateDock rows={delegateRows} />
        </div>
      )}
      {(pendingQuestion || pendingPermission) && (
        <div className="relative flex shrink-0 justify-center">
          {pendingQuestion ? (
            <QuestionDock request={pendingQuestion} onReply={replyQuestion} onReject={rejectQuestion} />
          ) : (
            <PermissionDock request={pendingPermission!} onReply={replyPermission} />
          )}
        </div>
      )}
    </>
  )

  // The composer proper. Dropped in `full`: with the transcript hidden there's no
  // conversation to sit under, and the bar reads as clutter. Anything genuinely
  // blocking still shows (see actionDocks), and Stop moves up into the banner.
  const composer = (
    <>
      {actionDocks}
      {/* The input itself is suppressed while a dock is up: the docks already own
          the bottom of the screen, and the agent is waiting on an answer, not on a
          new message. */}
      {!pendingQuestion && !pendingPermission && (
        <div className="relative flex shrink-0 justify-center">
          <div className="w-full max-w-[860px] px-4 py-3">
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              attachments={attachmentSlot}
              onStop={stopGeneration}
              placeholder={t("placeholder.reply")}
              disabled={isAgentActive || preparing}
              loading={isAgentActive || preparing}
              variant="reply"
              // Team session → the leader is the receiving backend; otherwise the
              // session binding. Rationale + matrix: lib/command-menu.ts.
              commandsEnabled={commandsAvailableFor(teamEntry?.leaderAgentId ?? getSessionAgentId(id))}
              leftSlot={
                <div className="flex items-center gap-1">
                  {teamEntry ? (
                    // Birth-locked leader chip (018 A-2): no selector affordance.
                    <span
                      title={t("agent.locked")}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-fg-muted)] opacity-70"
                    >
                      <AgentAvatar
                        agentId={teamEntry.leaderAgentId}
                        name={leaderName(agents, teamEntry.leaderAgentId)}
                        className="size-4 text-[8px]"
                      />
                      <Crown className="size-3 text-amber-500" />
                      <span className="max-w-[120px] truncate">
                        {leaderName(agents, teamEntry.leaderAgentId)}
                      </span>
                    </span>
                  ) : (
                    id && (
                      <AgentSelector
                        sessionId={id}
                        locked={loading || sending || allMessages.length > 0}
                      />
                    )
                  )}
                  {supportsModel && (
                    <ModelSelector
                      currentModel={currentModel}
                      onModelChange={setModel}
                      onOpenModelDialog={() => navigate("/settings", { state: { section: "models" } })}
                    />
                  )}
                </div>
              }
            />
            {/* AI-generated-content notice. Session only — Home's composer starts a
                task and has no AI output above it to qualify. Deliberately inside
                the same conditional as the input: while a dock is up the input is
                gone anyway, and the transcript above still carries the notice's
                context. */}
            <p className="mt-1.5 text-center text-[11px] text-[var(--color-fg-muted)] opacity-80">
              {t("session.aiDisclaimer")}
            </p>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div ref={columnsRowRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Chat column. Widths are derived from `previewMode`, never from ad-hoc
            conditions: the preview and the right sidebar are mutually exclusive
            (ADR-048), so at most two columns ever share this row and the old
            `50% + 50% + 288px` overflow — which the chat column silently ate — is
            gone by construction.

            HOW `full` hides the chat is load-bearing, and three constraints pin it:

              1. NOT `display:none` / unmount — the transcript's ResizeObserver must
                 keep firing, or stick-to-bottom stops self-correcting and we come
                 back to the wrong scroll position (ADR-047).
              2. NOT zero width — a 0px content box re-wraps every message at
                 min-content (about one word per line) on the way in AND again on the
                 way out. On a long session that's a large synchronous relayout for
                 nothing.
              3. Tab order and screen readers must skip it: it still holds focusable
                 things (the sidebar toggle, artifact links in the transcript).
                 `inert` alone can't carry this — it needs Safari 15.5+ (macOS 12.4+)
                 and we ship down to 10.15, where WKWebView silently ignores it.

            `visibility:hidden` + out of flow at the SAME `w-1/2` it had in `half`
            satisfies all three: removal from the tab order and the a11y tree that
            works on every engine we ship to, an unchanged layout width (zero
            reflow), and a live box the ResizeObserver keeps reporting on. `inert`
            rides along for the engines that do support it. */}
        <div
          data-testid="chat-column"
          className={cn(
            "flex min-w-0 flex-col overflow-hidden",
            maximized
              ? "invisible pointer-events-none absolute inset-y-0 left-0 w-1/2"
              : previewOpen
                ? "w-1/2"
                : "flex-1",
          )}
          inert={maximized}
        >
          {/* Header */}
          <TopBar title={session?.title || teamEntry?.title || t("session.newChat")}>
            <button
              onClick={handleToggleRight}
              aria-label={t("aria.toggleSidebar")}
              data-testid="toggle-right"
              className={cn(
                "relative flex size-8 items-center justify-center rounded-lg transition-colors",
                rightOpen
                  ? "bg-[var(--color-accent)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
              )}
            >
              <PanelRight className="size-4" />
              {/* Passive notification: new artifacts exist but we won't steal focus
                  for them (NN/g passive vs action-required). */}
              {!rightOpen && (
                <UnreadBadge
                  count={unreadArtifacts}
                  data-testid="artifact-badge"
                  aria-label={t("aria.unreadArtifacts")}
                  className="absolute -right-0.5 -top-0.5"
                />
              )}
            </button>
          </TopBar>

          {/* Team members bar (018 议题 B) */}
          {teamEntry && <TeamHeader entry={teamEntry} />}

          {/* Messages Area.
              The scroll container is deliberately NOT a flex container: contentRef must
              be free to grow with its children so its ResizeObserver keeps firing. As a
              stretched flex item it would stay pinned at the container's inner height and
              auto-scroll would silently stop self-correcting. See useSessionScroll. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              data-transcript-scroll
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scrollbar-soft"
            >
              <div ref={contentRef as React.Ref<HTMLDivElement>} className="mx-auto w-full max-w-[860px] px-6 pt-4 pb-8">
                <MessageList
                  artifactsByTurn={artifactsByTurn}
                  workspaceDir={workspaceDir}
                  messages={messages}
                  isLoading={loading && !sending}
                  streamingMessageId={streamingMessageId}
                  sessionActive={isAgentActive}
                  stoppedAtMessageId={stoppedAtMessageId}
                  onArtifactClick={handleArtifactClick}
                  showLoadEarlier={turnStart > 0 || hasMore}
                  historyLoading={historyLoading}
                  onLoadEarlier={loadEarlierMessages}
                />
                {teamEntry && messages.length === 0 && !loading && (
                  <p className="py-10 text-center text-sm text-[var(--color-fg-muted)]">{t("team.emptyHint")}</p>
                )}
                {isAgentActive && !stopped && (
                  <ExecutionStatus
                    state="working"
                    onStop={stopGeneration}
                  />
                )}
              </div>
            </div>

            {!isAtBottom && messages.length > 0 && (
              <button
                onClick={jumpToBottom}
                aria-label={t("aria.scrollToBottom")}
                title={t("aria.scrollToBottom")}
                className="absolute bottom-4 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg-muted)] shadow-md transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
              >
                <ArrowDown className="size-4" />
              </button>
            )}
          </div>

          {!maximized && composer}
        </div>

        {/* Artifact Preview — takes the right half, or the whole main area in
            `full`. Never coexists with the right sidebar (ADR-048). */}
        {previewOpen && (
          <div
            data-testid="artifact-preview"
            className={cn("overflow-hidden border-l border-[var(--color-border)]", maximized ? "min-w-0 flex-1" : "w-1/2 shrink-0")}
          >
            <ArtifactPreview
              artifact={selectedArtifact}
              directory={workspaceDir}
              onClose={handleClosePreview}
              nav={previewNav}
              maximized={maximized}
              onToggleMaximized={togglePreviewMaximized}
            />
          </div>
        )}

        {/* Right Sidebar */}
        {rightOpen && (
          <aside data-testid="right-sidebar" className="flex w-72 shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]">
            <div onMouseDown={handleDrag} className="h-9 shrink-0" />
            <div className="flex-1 overflow-y-auto p-3 pt-0 scrollbar-soft">
              {planSteps.length > 0 && (
                <RightSidebarSection title={t("session.rightSidebar.plan")} defaultOpen>
                  <PlanPanel steps={planSteps} active={isAgentActive} />
                </RightSidebarSection>
              )}
              <RightSidebarSection title={t("session.rightSidebar.workspace")} defaultOpen>
                <WorkspacePanel directory={workspaceDir} refreshKey={workspaceRefreshKey} onFileClick={handleFileTreeClick} />
              </RightSidebarSection>
              {/* Artifacts open themselves as soon as any exist — `autoOpen`, not
                  merely `defaultOpen`, because the plan auto-reveal typically opens
                  the sidebar BEFORE the agent has written a single file, and
                  `useState(defaultOpen)` reads its argument only at mount (see the
                  prop's docs). They used to sit behind a collapsed section, so even
                  users who opened the sidebar didn't see them. Expanding clears the
                  badge; a hand-collapse is respected from then on. */}
              <RightSidebarSection
                title={t("session.rightSidebar.artifacts")}
                badge={unreadArtifacts}
                defaultOpen={orderedArtifacts.length > 0}
                autoOpen={orderedArtifacts.length > 0}
                onOpen={markArtifactsSeen}
              >
                <ArtifactsPanel
                  deliverables={deliverables}
                  working={working}
                  onArtifactClick={handleArtifactClick}
                  selectedPath={selectedArtifact?.path}
                />
              </RightSidebarSection>
            </div>
          </aside>
        )}

      </div>

      {/* Maximized preview: a single thin bar, no composer. With the transcript
          hidden there's no conversation for an input box to sit under, and it reads
          as clutter against a full-screen artifact.

          What does NOT get dropped: anything the agent is BLOCKED on (permission,
          question, delegated-child permission). Hiding those wouldn't declutter the
          screen, it would strand a turn with no visible cause. They render nothing
          when there's nothing to answer, so the common case is just this bar.

          Stop moves up here too — it normally lives inside ChatInput, and without
          this there'd be no way to stop a run from `full` short of leaving it. */}
      {maximized && (
        <div className="shrink-0 border-t border-[var(--color-border)]">
          {actionDocks}
          <div className="flex items-center justify-center gap-3 py-1">
            <button
              onClick={togglePreviewMaximized}
              data-testid="transcript-hidden-banner"
              data-replied={repliedWhileHidden ? "true" : "false"}
              className="flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              {repliedWhileHidden ? (
                <>
                  <span className="size-1.5 rounded-full bg-[var(--color-brand)]" />
                  {t("session.repliedWhileHidden")}
                </>
              ) : (
                t("session.transcriptHidden")
              )}
            </button>
            {isAgentActive && !stopped && (
              <button
                onClick={stopGeneration}
                className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
              >
                {t("message.stopExecution")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function leaderName(agents: Array<{ id: string; name: string }>, id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id
}
