import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { FolderOpen, Pen, FileText, Bot, Users, Cpu } from "lucide-react"
import { useSessionsContext } from "@/lib/sessions-context"
import { useConnector } from "@/lib/sse-context"
import { useModel } from "@/lib/model-context"
import { useAgents } from "@/lib/agent-context"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace-context"
import { useTeamSessions } from "@/lib/team-sessions-context"
import { buildLeaderSystemPrompt, type TeamMember } from "@/lib/team-leader-prompt"
import { ensureOrchestratorMcp } from "@/lib/orchestrator-mcp"
import { createTeamSession } from "@/lib/orchestration-client"
import { OPENCODE_DEFAULT_AGENT_ID, isACPAgentId } from "@agent/connector"
import { ChatInput, ModelSelector, AgentSelector, TeamMemberSelect } from "@/components/chat"
import { TopBar } from "@/components/layout/top-bar"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"

const ABILITY_CARDS = [
  {
    icon: FolderOpen,
    titleKey: "home.card.files",
    descKey: "home.card.files.desc",
    promptKey: "home.card.files.prompt",
  },
  {
    icon: Pen,
    titleKey: "home.card.content",
    descKey: "home.card.content.desc",
    promptKey: "home.card.content.prompt",
  },
  {
    icon: FileText,
    titleKey: "home.card.docs",
    descKey: "home.card.docs.desc",
    promptKey: "home.card.docs.prompt",
  },
]

/** 018 A-2: collaboration mode is a birth property of the task. */
type TaskMode = "single" | "team"

export function HomePage() {
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  // The agent for the conversation about to start (档1: chosen before the
  // session is born; the binding freezes once the first message is sent).
  // In team mode the same control picks the LEADER.
  const [agentId, setAgentId] = useState(OPENCODE_DEFAULT_AGENT_ID)
  const [mode, setMode] = useState<TaskMode>("single")
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set())
  const membersTouched = useRef(false)
  const navigate = useNavigate()
  const api = useApi()
  const { workspacePath } = useWorkspace()
  const { createSession } = useSessionsContext()
  const { addEntry } = useTeamSessions()
  const { agents, acpAvailable, bindSessionAgent } = useAgents()
  const connector = useConnector()
  const { t } = useI18n()
  const { currentModel, setModel, openModelDialog } = useModel()
  const isACP = isACPAgentId(agentId)

  // Default member selection: everyone, until the user edits the picker.
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

  const handleSingleSend = async (text: string) => {
    setSending(true)
    try {
      const session = await createSession()
      bindSessionAgent(session.id, agentId)
      setInput("")
      // Navigate immediately for instant UX; the prompt call is fire-and-forget.
      // Session.tsx has a safety timeout to reset sending if no SSE events arrive.
      navigate(`/session/${session.id}`, { state: { sending: true, messageText: text } })
      // Dispatched by the binding frozen above (ACP backends lazily create the
      // agent-side session in the workspace directory before prompting).
      connector
        .prompt(session.id, text, { model: currentModel || undefined, directory: session.directory })
        .catch((err) => {
          console.error("Failed to send message:", err)
          toast.error(t("error.sendMessage"))
        })
    } catch (err) {
      console.error("Failed to create session:", err)
      toast.error(t("error.createSession"))
    } finally {
      setSending(false)
    }
  }

  // Team mode (018): the first send creates the Leader session through the
  // sidecar registry, then chats with it like any session. opencode leaders
  // carry the orchestration system prompt + task deny on EVERY turn (here the
  // first one; Session.tsx repeats it); ACP leaders got the prompt baked in
  // at creation, so their prompt call is plain.
  const handleTeamSend = async (text: string) => {
    if (!workspacePath) {
      toast.error(t("orchestration.noWorkspace"))
      return
    }
    const members = [...memberIds]
    if (members.length === 0) {
      toast.error(t("team.noMembers"))
      return
    }
    setSending(true)
    try {
      const systemPrompt = buildLeaderSystemPrompt({
        workspace: workspacePath,
        members: memberRoster(members),
      })
      const isOpencodeLeader = !isACPAgentId(agentId)
      // opencode leaders reach the delegate tools through the global MCP
      // entry — ensure it silently (017 拍板 #5).
      if (isOpencodeLeader) await ensureOrchestratorMcp(api)
      const entry = await createTeamSession({
        workspace: workspacePath,
        leaderAgentId: agentId,
        members,
        systemPrompt,
      })
      // Registry context first: the Session page's team lookup must hit
      // before the navigation below renders it.
      addEntry(entry)
      if (!isOpencodeLeader) bindSessionAgent(entry.id, agentId)
      setInput("")
      navigate(`/session/${entry.id}`, { state: { sending: true, messageText: text } })
      connector
        .prompt(
          entry.id,
          text,
          isOpencodeLeader
            ? {
                model: currentModel || undefined,
                directory: workspacePath,
                system: systemPrompt,
                tools: { task: false },
              }
            : { directory: workspacePath },
        )
        .catch((err) => {
          console.error("Failed to send message:", err)
          toast.error(t("error.sendMessage"))
        })
    } catch (err) {
      console.error("Failed to create team session:", err)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return
    if (mode === "team") await handleTeamSend(text)
    else await handleSingleSend(text)
  }

  const handleCardClick = (promptKey: string) => {
    setInput(t(promptKey))
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <TopBar />

      <div className="flex flex-1 flex-col items-center justify-center px-4 pb-8">
        <div className="flex w-full max-w-2xl flex-col items-center gap-8">
          {/* Headline */}
          <div className="space-y-2 text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-fg)] md:text-4xl">
              {t("home.headline")}
            </h1>
            <p className="text-sm text-[var(--color-fg-muted)]">
              {t("home.subtitle")}
            </p>
          </div>

          {/* Ability Cards */}
          <div className="grid w-full grid-cols-3 gap-3">
            {ABILITY_CARDS.map((card) => (
              <button
                key={card.titleKey}
                onClick={() => handleCardClick(card.promptKey)}
                className="flex flex-col items-start gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4 text-left transition-all hover:border-[var(--color-brand)] hover:shadow-sm"
              >
                <card.icon className="size-5 text-[var(--color-brand)]" />
                <span className="text-sm font-medium text-[var(--color-fg)]">
                  {t(card.titleKey)}
                </span>
                <span className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
                  {t(card.descKey)}
                </span>
              </button>
            ))}
          </div>

          {/* Input */}
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            placeholder={mode === "team" ? t("team.inputPlaceholder") : t("placeholder.askAnything")}
            disabled={sending}
            loading={sending}
            variant="home"
            className="w-full"
            ctaLabel={t("home.startNow")}
            leftSlot={
              <div className="flex items-center gap-1">
                <ModeSwitch mode={mode} onModeChange={setMode} teamDisabled={!acpAvailable} />
                <AgentSelector agentId={agentId} onAgentChange={setAgentId} leader={mode === "team"} />
                {mode === "team" && (
                  <TeamMemberSelect selected={memberIds} onToggle={toggleMember} />
                )}
                {isACP ? (
                  // ACP agents bring their own model — show why the picker is
                  // absent instead of silently vanishing (018 reported "no linkage").
                  <span
                    title={t("home.model.agentManaged.hint")}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-[var(--color-fg-muted)]"
                  >
                    <Cpu className="size-3" />
                    {t("home.model.agentManaged")}
                  </span>
                ) : (
                  <ModelSelector
                    currentModel={currentModel}
                    onModelChange={setModel}
                    onOpenModelDialog={openModelDialog}
                    title={mode === "team" ? t("home.model.leaderScope.hint") : undefined}
                  />
                )}
              </div>
            }
          />
        </div>
      </div>

    </div>
  )
}

/** Segmented「单 agent | Team」switch — the task's birth mode (018 A-2). */
function ModeSwitch({
  mode,
  onModeChange,
  teamDisabled,
}: {
  mode: TaskMode
  onModeChange: (mode: TaskMode) => void
  teamDisabled: boolean
}) {
  const { t } = useI18n()
  const segment = (value: TaskMode, label: string, Icon: typeof Bot, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? t("agent.sidecarUnavailable") : undefined}
      onClick={() => onModeChange(value)}
      className={cn(
        "flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs transition-colors",
        mode === value
          ? "bg-[var(--color-bg)] font-medium text-[var(--color-brand)] shadow-sm"
          : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
        disabled && "cursor-not-allowed opacity-50 hover:text-[var(--color-fg-muted)]",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  )

  return (
    <div className="flex items-center gap-0.5 rounded-md bg-[var(--color-accent)]/60 p-0.5">
      {segment("single", t("home.mode.single"), Bot)}
      {segment("team", t("home.mode.team"), Users, teamDisabled)}
    </div>
  )
}
