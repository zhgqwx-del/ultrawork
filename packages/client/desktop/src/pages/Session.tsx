import { useEffect, useState, useCallback, useMemo } from "react"
import { useParams, useLocation, useNavigate } from "react-router-dom"
import { TopBar } from "@/components/layout/top-bar"
import { handleDrag } from "@/components/layout/drag-region"
import { useSidebar } from "@/components/layout/sidebar-context"
import { useSessionsContext } from "@/lib/sessions-context"
import { useModel } from "@/lib/model-context"
import { useSessionMessages } from "@/lib/use-session-messages"
import { useSessionPlan } from "@/lib/use-session-plan"
import { useSessionPermission } from "@/lib/use-session-permission"
import { useSessionScroll } from "@/lib/use-session-scroll"
import { ChatInput, MessageList, ModelSelector, AgentSelector, AgentAvatar } from "@/components/chat"
import { useConnector } from "@/lib/sse-context"
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
import { PanelRight, ChevronDown, ChevronRight, Crown, ArrowDown } from "lucide-react"
import { PlanPanel, ActivityPanel, ArtifactsPanel, WorkspacePanel, MCPPanel, SkillsPanel, ArtifactPreview, TeamHeader } from "@/components/session"
import type { Artifact } from "@/components/session"
import { useI18n } from "@/lib/i18n-context"

export function SessionPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { sessions, activeSessionIds } = useSessionsContext()
  const { t } = useI18n()
  const { currentModel, setModel } = useModel()
  const { rightOpen, toggleRight } = useSidebar()
  const { workspacePath } = useWorkspace()

  const [input, setInput] = useState("")
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null)

  const session = sessions.find(s => s.id === id)

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

  // --- Scroll management hook ---
  const { scrollRef, contentRef, isAtBottom, forceScrollToBottom, jumpToBottom } = useSessionScroll({
    onScrollNearTop,
    sessionId: id,
  })

  // --- Reset local UI state on session change ---
  useEffect(() => {
    setSelectedArtifact(null)
  }, [id])

  // --- UI handlers ---
  const workspaceRefreshKey = toolCompletionCount
  // Legacy Team Leader sessions may be absent from SessionsContext (so `session`
  // is undefined); the team registry still knows the workspace. Fall back to it
  // so the workspace tree, artifacts scan, and preview all resolve paths.
  const workspaceDir = session?.directory ?? teamEntry?.workspace

  const handleSend = () => {
    if (!input.trim()) return
    sendMessage(input.trim(), currentModel)
    setInput("")
    // Force scroll to bottom after sending, even if user was viewing history
    forceScrollToBottom()
  }

  const handleArtifactClick = useCallback((artifact: Artifact) => {
    setSelectedArtifact({ ...artifact, sessionId: id })
  }, [id])

  const handleFileTreeClick = useCallback((path: string) => {
    setSelectedArtifact({ type: "file", path })
  }, [])

  const handleClosePreview = useCallback(() => {
    setSelectedArtifact(null)
  }, [])

  const handleSkillClick = useCallback((name: string) => {
    setInput(`/${name} `)
  }, [])

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      {/* Chat Panel (full width or 50% when preview active) */}
      <div className={cn("flex min-w-0 flex-col overflow-hidden", selectedArtifact ? "w-1/2" : "flex-1")}>
        {/* Header */}
        <TopBar title={session?.title || teamEntry?.title || t("session.newChat")}>
          <button
            onClick={toggleRight}
            aria-label={t("aria.toggleSidebar")}
            className={cn(
              "flex size-8 items-center justify-center rounded-lg transition-colors",
              rightOpen
                ? "bg-[var(--color-accent)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
            )}
          >
            <PanelRight className="size-4" />
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
            <DelegateDock workspacePath={workspacePath} sessionId={id} />
          </div>
        )}

        {/* Reply Input / Permission Dock / Question Dock */}
        <div className="relative flex shrink-0 justify-center">
          {pendingQuestion ? (
            <QuestionDock
              request={pendingQuestion}
              onReply={replyQuestion}
              onReject={rejectQuestion}
            />
          ) : pendingPermission ? (
            <PermissionDock
              request={pendingPermission}
              onReply={replyPermission}
            />
          ) : (
            <div className="w-full max-w-[860px] px-4 py-3">
              <ChatInput
                value={input}
                onChange={setInput}
                onSend={handleSend}
                onStop={stopGeneration}
                placeholder={t("placeholder.reply")}
                disabled={isAgentActive}
                loading={isAgentActive}
                variant="reply"
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
            </div>
          )}
        </div>
      </div>

      {/* Artifact Preview (right, 50% when active) */}
      {selectedArtifact && (
        <div className="w-1/2 shrink-0 overflow-hidden border-l border-[var(--color-border)]">
          <ArtifactPreview artifact={selectedArtifact} directory={workspaceDir} onClose={handleClosePreview} />
        </div>
      )}

      {/* Right Sidebar */}
      {rightOpen && (
        <aside className="flex w-72 shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]">
          <div onMouseDown={handleDrag} className="h-9 shrink-0" />
          <div className="flex-1 overflow-y-auto p-3 pt-0 scrollbar-soft">
            {planSteps.length > 0 && (
              <RightSidebarSection title={t("session.rightSidebar.plan")} defaultOpen>
                <PlanPanel steps={planSteps} active={isAgentActive} />
              </RightSidebarSection>
            )}
            <RightSidebarSection title={t("session.rightSidebar.activity")} defaultOpen>
              <ActivityPanel messages={allMessages} />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.workspace")} defaultOpen>
              <WorkspacePanel directory={workspaceDir} refreshKey={workspaceRefreshKey} onFileClick={handleFileTreeClick} />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.artifacts")}>
              <ArtifactsPanel
                messages={allMessages}
                directory={workspaceDir}
                active={isAgentActive}
                onArtifactClick={handleArtifactClick}
                selectedPath={selectedArtifact?.path}
              />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.mcp")}>
              <MCPPanel />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.skills")}>
              <SkillsPanel onSkillClick={handleSkillClick} />
            </RightSidebarSection>
          </div>
        </aside>
      )}

    </div>
  )
}

function leaderName(agents: Array<{ id: string; name: string }>, id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id
}

function RightSidebarSection({ title, placeholder, children, defaultOpen = false }: { title: string; placeholder?: string; children?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border-b border-[var(--color-border)] last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-3 text-[13px] font-medium text-[var(--color-fg)] hover:text-[var(--color-fg)]"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        {title}
      </button>
      {open && (
        <div className="pb-3 text-xs text-[var(--color-fg-muted)]">
          {children || placeholder}
        </div>
      )}
    </div>
  )
}
