// Team tab (017 Team 页): delegation as the DEFAULT behavior of a Leader
// session. The user only describes the task; splitting / delegating /
// summarizing is driven by the Leader's system prompt. Leader sessions hang
// off a hidden parent and never enter the sidebar — this tab is their only
// surface. Reuses the whole chat stack (useSessionMessages / MessageList /
// ChatInput / DelegateDock / permission docks); the delegate cards inside the
// message flow come from batch-2 renderers untouched.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ArrowLeft, Crown, Loader2, Plus, RefreshCw, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatInput, MessageList, ModelSelector } from "@/components/chat"
import { ExecutionStatus } from "@/components/chat/execution-status"
import { PermissionDock } from "@/components/chat/permission-dock"
import { QuestionDock } from "@/components/chat/question-dock"
import { DelegateDock } from "@/components/chat/delegate-dock"
import { useAgents } from "@/lib/agent-context"
import { useApi } from "@/lib/use-api"
import { useConnector } from "@/lib/sse-context"
import { useI18n } from "@/lib/i18n-context"
import { useModel } from "@/lib/model-context"
import { useSessionMessages } from "@/lib/use-session-messages"
import { useSessionPermission } from "@/lib/use-session-permission"
import { useSessionScroll } from "@/lib/use-session-scroll"
import { useWorkspace } from "@/lib/workspace-context"
import { buildLeaderSystemPrompt, type TeamMember } from "@/lib/team-leader-prompt"
import { ensureOrchestratorMcp } from "@/lib/orchestrator-mcp"
import {
  createTeamSession,
  listTeamSessions,
  type TeamSessionEntry,
} from "@/lib/orchestration-client"

const OPENCODE_LEADER = "opencode:default"

export function TeamTab() {
  const { t } = useI18n()
  const api = useApi()
  const { agents, bindSessionAgent } = useAgents()
  const { workspacePath } = useWorkspace()

  const [sessions, setSessions] = useState<TeamSessionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [unreachable, setUnreachable] = useState(false)
  const [active, setActive] = useState<TeamSessionEntry | null>(null)
  const [creating, setCreating] = useState(false)
  const [leaderAgentId, setLeaderAgentId] = useState(OPENCODE_LEADER)
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set())
  const membersTouched = useRef(false)

  const refresh = useCallback(async () => {
    try {
      setSessions(await listTeamSessions(workspacePath ?? undefined))
      setUnreachable(false)
    } catch {
      setUnreachable(true)
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Default member selection: everyone, until the user edits the checkboxes.
  useEffect(() => {
    if (membersTouched.current) return
    setMemberIds(new Set(agents.map((a) => a.id)))
  }, [agents])

  const toggleMember = (id: string) => {
    membersTouched.current = true
    setMemberIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const memberRoster = (ids: string[]): TeamMember[] =>
    ids.map((id) => {
      const agent = agents.find((a) => a.id === id)
      return { id, name: agent?.name ?? id, description: agent?.description }
    })

  const create = async () => {
    if (!workspacePath) {
      toast.error(t("orchestration.noWorkspace"))
      return
    }
    const members = [...memberIds]
    if (members.length === 0) {
      toast.error(t("team.noMembers"))
      return
    }
    setCreating(true)
    try {
      const systemPrompt = buildLeaderSystemPrompt({
        workspace: workspacePath,
        members: memberRoster(members),
      })
      // opencode leaders reach the delegate tools through the global MCP
      // entry — ensure it silently (017 拍板 #5; replaces the Settings toggle).
      if (leaderAgentId === OPENCODE_LEADER) await ensureOrchestratorMcp(api)
      const entry = await createTeamSession({
        workspace: workspacePath,
        leaderAgentId,
        members,
        systemPrompt,
      })
      if (leaderAgentId.startsWith("acp:")) bindSessionAgent(entry.id, leaderAgentId)
      setSessions((prev) => [entry, ...prev])
      setActive(entry)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const open = (entry: TeamSessionEntry) => {
    // Rebind eagerly: hydration covers restarts, but an immediate bind makes
    // opening work even before the next agents refresh.
    if (entry.leaderAgentId.startsWith("acp:")) bindSessionAgent(entry.id, entry.leaderAgentId)
    setActive(entry)
  }

  if (active) {
    return <TeamChat entry={active} onBack={() => setActive(null)} />
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {/* Create card */}
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5">
          <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
            {t("team.desc")}
            {workspacePath ? ` · ${workspacePath}` : ""}
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-xs font-medium text-[var(--color-fg-muted)]">
              <Crown className="size-3.5" />
              {t("team.leader")}
            </span>
            <select
              value={leaderAgentId}
              onChange={(e) => setLeaderAgentId(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)]"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1 text-xs font-medium text-[var(--color-fg-muted)]">
              <Users className="size-3.5" />
              {t("team.members")}
            </span>
            {agents.map((agent) => (
              <label key={agent.id} className="flex items-center gap-1.5 text-xs text-[var(--color-fg)]">
                <input
                  type="checkbox"
                  checked={memberIds.has(agent.id)}
                  onChange={() => toggleMember(agent.id)}
                  className="size-3.5 accent-[var(--color-brand)]"
                />
                {agent.name}
              </label>
            ))}
          </div>
          <Button size="sm" onClick={() => void create()} disabled={creating || !workspacePath}>
            {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {t("team.start")}
          </Button>
        </section>

        {/* History list */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold text-[var(--color-fg)]">{t("team.history")}</h2>
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-[var(--color-fg-muted)]" />
            </div>
          ) : unreachable ? (
            <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">
              {t("orchestration.sidecarUnreachable")}
            </p>
          ) : sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">{t("team.noSessions")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {sessions.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => open(entry)}
                  className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 text-left transition-colors hover:border-[var(--color-accent)]"
                >
                  <Crown className="size-4 shrink-0 text-[var(--color-fg-muted)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--color-fg)]">
                      {entry.title || `${t("team.sessionTitle")} · ${agentName(agents, entry.leaderAgentId)}`}
                    </div>
                    <div className="truncate text-xs text-[var(--color-fg-muted)]">
                      {entry.members.length} {t("team.membersCount")} ·{" "}
                      {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function agentName(agents: Array<{ id: string; name: string }>, id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id
}

function TeamChat({ entry, onBack }: { entry: TeamSessionEntry; onBack: () => void }) {
  const { t } = useI18n()
  const { agents } = useAgents()
  const { currentModel, setModel, openModelDialog } = useModel()
  const connector = useConnector()

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState("")

  const isOpencodeLeader = entry.leaderAgentId === OPENCODE_LEADER

  // opencode leaders carry the orchestration instructions on EVERY turn
  // (promptAsync system append) plus the built-in task deny — the
  // tool-confusion fix decided in 017 拍板 #2. ACP leaders received the same
  // prompt once at session creation (sidecar injection), so nothing extra.
  const promptOptions = useMemo(() => {
    if (!isOpencodeLeader) return undefined
    const members = entry.members.map((id) => {
      const agent = agents.find((a) => a.id === id)
      return { id, name: agent?.name ?? id, description: agent?.description }
    })
    return {
      system: buildLeaderSystemPrompt({ workspace: entry.workspace, members }),
      tools: { task: false },
    }
  }, [isOpencodeLeader, entry, agents])

  const {
    messages,
    sending,
    loading,
    streamingMessageId,
    stopped,
    stoppedAtMessageId,
    turnStart,
    hasMore,
    historyLoading,
    sendMessage,
    stopGeneration,
    loadEarlierMessages,
    onScrollNearTop,
  } = useSessionMessages(entry.id, { directory: entry.workspace, promptOptions })

  const isAgentActive = sending || streamingMessageId !== null
  const { pendingPermission, pendingQuestion, replyPermission, replyQuestion, rejectQuestion } =
    useSessionPermission(entry.id, isAgentActive)

  const { scrollToBottom } = useSessionScroll({
    scrollContainerRef,
    contentRef,
    onScrollNearTop,
    sessionId: entry.id,
    messages,
  })

  const supportsModel = connector.capabilitiesOf(entry.id).model

  const handleSend = () => {
    if (!input.trim()) return
    sendMessage(input.trim(), currentModel)
    setInput("")
    scrollToBottom(true)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Team header: back + leader + locked member chips */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <button
          onClick={onBack}
          aria-label={t("team.back")}
          className="flex size-7 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft className="size-4" />
        </button>
        <span className="flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-fg)]">
          <Crown className="size-3" />
          {agentName(agents, entry.leaderAgentId)}
        </span>
        <span className="flex min-w-0 items-center gap-1 truncate text-xs text-[var(--color-fg-muted)]">
          <Users className="size-3 shrink-0" />
          {entry.members.map((id) => agentName(agents, id)).join(" · ")}
        </span>
      </div>

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        className="relative flex flex-1 justify-center overflow-x-hidden overflow-y-auto scrollbar-soft"
      >
        <div ref={contentRef} className="w-full max-w-[800px] px-6 pt-4 pb-24">
          <MessageList
            messages={messages}
            isLoading={loading && !sending}
            streamingMessageId={streamingMessageId}
            stoppedAtMessageId={stoppedAtMessageId}
            showLoadEarlier={turnStart > 0 || hasMore}
            historyLoading={historyLoading}
            onLoadEarlier={loadEarlierMessages}
          />
          {messages.length === 0 && !loading && (
            <p className="py-10 text-center text-sm text-[var(--color-fg-muted)]">{t("team.emptyHint")}</p>
          )}
          {sending && !stopped && <ExecutionStatus state="working" onStop={stopGeneration} />}
        </div>
      </div>

      {/* Active delegates + relayed child permissions (batch 2, reused) */}
      <div className="flex shrink-0 justify-center">
        <DelegateDock workspacePath={entry.workspace} />
      </div>

      {/* Leader's own permission/question docks + input */}
      <div className="relative flex shrink-0 justify-center">
        {pendingQuestion ? (
          <QuestionDock request={pendingQuestion} onReply={replyQuestion} onReject={rejectQuestion} />
        ) : pendingPermission ? (
          <PermissionDock request={pendingPermission} onReply={replyPermission} />
        ) : (
          <div className="w-full max-w-[800px] px-4 py-3">
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              onStop={stopGeneration}
              placeholder={t("team.inputPlaceholder")}
              disabled={sending}
              loading={sending}
              variant="reply"
              leftSlot={
                supportsModel ? (
                  <ModelSelector
                    currentModel={currentModel}
                    onModelChange={setModel}
                    onOpenModelDialog={openModelDialog}
                  />
                ) : undefined
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}
