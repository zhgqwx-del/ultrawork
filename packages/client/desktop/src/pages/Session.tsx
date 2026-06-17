import { useRef, useEffect, useState, useCallback, useMemo } from "react"
import { useParams, useLocation, useNavigate } from "react-router-dom"
import { TopBar } from "@/components/layout/top-bar"
import { handleDrag } from "@/components/layout/drag-region"
import { useSidebar } from "@/components/layout/sidebar-context"
import { useSessionsContext } from "@/lib/sessions-context"
import { useModel } from "@/lib/model-context"
import { useSessionMessages } from "@/lib/use-session-messages"
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
import { PanelRight, ChevronDown, ChevronRight, Crown } from "lucide-react"
import { ProgressPanel, ArtifactsPanel, WorkspacePanel, MCPPanel, SkillsPanel, ArtifactPreview, TeamHeader } from "@/components/session"
import type { Artifact } from "@/components/session"
import { useI18n } from "@/lib/i18n-context"

export function SessionPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { sessions } = useSessionsContext()
  const { t } = useI18n()
  const { currentModel, setModel } = useModel()
  const { rightOpen, toggleRight } = useSidebar()
  const { workspacePath } = useWorkspace()

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const [input, setInput] = useState("")
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null)

  const session = sessions.find(s => s.id === id)

  // Team session (018 统一交互): identity comes from the sidecar registry.
  const { entryOf } = useTeamSessions()
  const { agents } = useAgents()
  const teamEntry = entryOf(id)

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
  const isAgentActive = sending || streamingMessageId !== null
  const {
    pendingPermission,
    pendingQuestion,
    replyPermission,
    replyQuestion,
    rejectQuestion,
  } = useSessionPermission(id, isAgentActive)

  // --- Scroll management hook ---
  const { scrollToBottom } = useSessionScroll({
    scrollContainerRef,
    contentRef,
    onScrollNearTop,
    sessionId: id,
    messages,
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
    scrollToBottom(true)
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

        {/* Messages Area */}
        <div
          ref={scrollContainerRef}
          className={cn("relative flex flex-1 justify-center overflow-x-hidden overflow-y-auto scrollbar-soft")}
        >
          <div ref={contentRef} className="w-full max-w-[800px] px-6 pt-4 pb-24">
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
            {sending && !stopped && (
              <ExecutionStatus
                state="working"
                onStop={stopGeneration}
              />
            )}
            {/* Scroll anchor removed — useSessionScroll uses ResizeObserver */}
          </div>
        </div>

        {/* Active delegates + relayed child permissions (ADR-031 ②) */}
        <div className="flex shrink-0 justify-center">
          <DelegateDock workspacePath={workspacePath} />
        </div>

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
            <div className="w-full max-w-[800px] px-4 py-3">
              <ChatInput
                value={input}
                onChange={setInput}
                onSend={handleSend}
                onStop={stopGeneration}
                placeholder={t("placeholder.reply")}
                disabled={sending}
                loading={sending}
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
        <aside className="flex w-80 shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]">
          <div onMouseDown={handleDrag} className="h-9 shrink-0" />
          <div className="flex-1 overflow-y-auto p-3 pt-0 scrollbar-soft">
            <RightSidebarSection title={t("session.rightSidebar.plan")}>
              <ProgressPanel messages={allMessages} />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.workspace")}>
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

function RightSidebarSection({ title, placeholder, children }: { title: string; placeholder?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-b border-[var(--color-border)] last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-3 text-sm font-medium text-[var(--color-fg)] hover:text-[var(--color-fg)]"
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
