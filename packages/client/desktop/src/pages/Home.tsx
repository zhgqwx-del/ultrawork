import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { toast } from "sonner"
import { FolderOpen, Pen, FileText, Bot, Users, Cpu } from "lucide-react"
import { useSessionsContext } from "@/lib/sessions-context"
import { commandsAvailableFor } from "@/lib/command-menu"
import { useConnector } from "@/lib/sse-context"
import { useModel } from "@/lib/model-context"
import { useAttachments } from "@/lib/use-attachments"
import type { Attachment } from "@/lib/attachments"
import {
  HOME_DRAFT_KEY,
  useDraftBucket,
  useDraftDispatch,
  type TaskMode,
} from "@/lib/draft-context"
import { useScreenshot } from "@/lib/use-screenshot"
import { useAgents } from "@/lib/agent-context"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace-context"
import { useTeamSessions } from "@/lib/team-sessions-context"
import { buildLeaderSystemPrompt, type TeamMember } from "@/lib/team-leader-prompt"
import { forgetLocallyPrompted, markLocallyPrompted } from "@/lib/notifications/notify-registry"
import { ensureOrchestratorMcp } from "@/lib/orchestrator-mcp"
import { createTeamSession } from "@/lib/orchestration-client"
import { OPENCODE_DEFAULT_AGENT_ID, isACPAgentId } from "@agent/connector"
import { ChatInput, CopyButton, ModelSelector, AgentSelector, TeamMemberSelect } from "@/components/chat"
import { shortenPath } from "@/lib/path-utils"
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

export function HomePage() {
  const [sending, setSending] = useState(false)
  // Everything the user has typed or picked lives in the draft bucket, not in local
  // state: this page is a child of <Outlet>, so any navigation unmounts it and local
  // state would be gone on return (discussions/060).
  const draft = useDraftBucket(HOME_DRAFT_KEY)
  const { patchDraft, clearDraft } = useDraftDispatch()
  const navigate = useNavigate()
  const location = useLocation()
  const api = useApi()
  const { workspacePath } = useWorkspace()
  const { createSession } = useSessionsContext()
  const { addEntry } = useTeamSessions()
  const { agents, acpAvailable, bindSessionAgent } = useAgents()
  const connector = useConnector()
  const { t } = useI18n()
  const { currentModel, setModel, maybeOfferFreeTrial } = useModel()

  // --- Draft-backed composer state ---------------------------------------------------
  // Every setter below is stable (`patchDraft` is frozen for the app's lifetime), so
  // moving this state out of the component doesn't churn ChatInput's props.
  const input = draft.text
  const setInput = useCallback((text: string) => patchDraft(HOME_DRAFT_KEY, { text }), [patchDraft])

  // A restored draft holds REFERENCES — an agent id, a member list, a mode that needs ACP —
  // and what they point at can vanish while the user is on another page (a sidecar goes
  // down, an agent is unregistered). Reconcile on READ rather than writing a cleaned value
  // back: `agents` is empty for the first frames after mount, and a write would turn that
  // transient into a permanent reset of the user's choice. A stale id must never survive
  // to dispatch — AgentSelector falls back to agents[0] for DISPLAY only, so a bad id here
  // would show one agent and prompt another.
  const storedAgentId = draft.agentId ?? OPENCODE_DEFAULT_AGENT_ID
  const agentId =
    agents.length === 0 || agents.some((a) => a.id === storedAgentId)
      ? storedAgentId
      : OPENCODE_DEFAULT_AGENT_ID
  const setAgentId = useCallback(
    (id: string) => patchDraft(HOME_DRAFT_KEY, { agentId: id }),
    [patchDraft],
  )

  // Team runs on ACP. If ACP went away while the user was elsewhere, fall back to single
  // rather than leaving them in a mode whose send path is guaranteed to fail.
  const mode: TaskMode = draft.mode === "team" && acpAvailable ? "team" : "single"
  const setMode = useCallback(
    (next: TaskMode) => patchDraft(HOME_DRAFT_KEY, { mode: next }),
    [patchDraft],
  )

  // Default member selection: everyone, until the user edits the picker — and then exactly
  // what they picked, minus anyone who is no longer around (a stored id with no agent would
  // otherwise reach the leader's system prompt as a member named after its own id).
  const memberIds = useMemo(() => {
    const stored = draft.memberIds
    if (!stored || !draft.membersTouched) return new Set(agents.map((a) => a.id))
    if (agents.length === 0) return new Set(stored)
    return new Set(stored.filter((id) => agents.some((a) => a.id === id)))
  }, [draft.memberIds, draft.membersTouched, agents])

  // Attachments live in the bucket too — they are the part of a composer that is most
  // expensive to rebuild by hand.
  const attachStore = useMemo(
    () => ({
      key: HOME_DRAFT_KEY,
      items: draft.attachments,
      setItems: (next: Attachment[]) => patchDraft(HOME_DRAFT_KEY, { attachments: next }),
    }),
    [draft.attachments, patchDraft],
  )

  // Team mode runs on ACP (text-only prompts), so the attach entry point is hidden there.
  const attach = useAttachments(currentModel, attachStore)
  const shot = useScreenshot(attach.add)
  const attachmentSlot = useMemo(
    () => ({
      items: attach.items,
      add: attach.add,
      addPaths: attach.addPaths,
      remove: attach.remove,
      blocker: attach.blocker,
      checking: attach.checking,
      disabled: mode === "team",
      screenshot: shot,
    }),
    [attach.items, attach.add, attach.addPaths, attach.remove, attach.blocker, attach.checking, mode, shot],
  )
  // Switching to Team mode after attaching: Team runs on ACP, which takes text only. The
  // disabled slot only greys out the ➕ button — the already-attached files would still sit
  // in the composer and then be dropped without a word by handleTeamSend. Drop them here,
  // visibly, and say so.
  useEffect(() => {
    if (mode === "team" && attach.items.length > 0) {
      attach.clear()
      toast.info(t("attachment.clearedForTeam"))
    }
  }, [mode, attach, t])

  const isACP = isACPAgentId(agentId)

  // Read the live draft text without making it an effect dependency (the hand-off effect
  // below must run on `location.state`, not on every keystroke).
  const textRef = useRef(draft.text)
  textRef.current = draft.text

  // Prefill the composer when navigated here with an initial prompt (e.g. the
  // Settings "install skill" action hands off to the built-in skill-installer).
  // StrictMode mounts effects twice. Without a guard the user sees the toast twice, and
  // the second run reads the prompt we just wrote as the "displaced" draft — so Undo would
  // hand back the prompt instead of their typing. Keyed on the state OBJECT: react-router
  // makes a fresh one per navigation, and the two StrictMode passes share it.
  const handedOffRef = useRef<unknown>(null)

  useEffect(() => {
    const state = location.state as { initialInput?: string } | null
    const initial = state?.initialInput
    if (!initial) return
    if (handedOffRef.current === state) return
    handedOffRef.current = state
    // The hand-off prompt is several hundred words of machine instruction; splicing it onto
    // a half-typed draft would produce something incoherent that the user could well send
    // as-is — and the composer only shows 200px, so their own words would scroll out of
    // sight. Replace. But a feature whose entire point is "your typing survives" must not
    // silently eat it: hand it back the same way the Team-mode attachment drop below does.
    const displaced = textRef.current
    patchDraft(HOME_DRAFT_KEY, { text: initial })
    navigate(".", { replace: true, state: null })
    if (displaced.trim()) {
      toast.info(t("draft.replacedByHandoff"), {
        // Stable id: a second toast for the same hand-off would be noise even if the guard
        // above ever failed to hold.
        id: "draft-handoff",
        action: {
          label: t("draft.restore"),
          onClick: () => patchDraft(HOME_DRAFT_KEY, { text: displaced }),
        },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const toggleMember = (id: string) => {
    const next = new Set(memberIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    patchDraft(HOME_DRAFT_KEY, { memberIds: [...next], membersTouched: true })
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
      // Attachments can only be materialised now: documents are copied into the session's
      // workspace, and on Home there was no session (and no workspace) until this moment.
      const { attachments, noteText } = await attach.materialize(session.id, session.directory)
      const prompt = text + noteText
      // Every attachment can fail to materialise. Sending a prompt with neither text nor
      // attachments would be refused downstream anyway — but we have already created and are
      // about to navigate into a session, so say what happened instead of stranding the user
      // in an empty conversation that looks like it swallowed their message.
      if (!prompt.trim() && attachments.length === 0) {
        toast.error(t("attachment.nothingToSend"))
        return
      }
      // The draft has now been consumed by a real session — wipe the whole bucket (text,
      // attachments and the task's birth configuration). Note this sits AFTER the early
      // return above: a turn that failed to materialise anything keeps the user's input.
      // attach.clear() first so the hook's own cap bookkeeping is emptied too, not just
      // the bucket it reads from.
      attach.clear()
      clearDraft(HOME_DRAFT_KEY)
      // Navigate immediately for instant UX; the prompt call is fire-and-forget.
      // Session.tsx has a safety timeout to reset sending if no SSE events arrive.
      navigate(`/session/${session.id}`, { state: { sending: true, messageText: text } })
      // A new session's FIRST turn is started here, not through the composer's
      // sendMessage — so the notification allowlist has to be told here too, or the
      // most common path of all (ask something from Home, walk away) never notifies.
      markLocallyPrompted(session.id)
      // Dispatched by the binding frozen above (ACP backends lazily create the
      // agent-side session in the workspace directory before prompting).
      connector
        .prompt(session.id, prompt, {
          model: currentModel || undefined,
          directory: session.directory,
          attachments,
        })
        .catch((err) => {
          console.error("Failed to send message:", err)
          // No turn ever ran, so no idle will ever arrive to consume the entry — it would
          // sit there and arm a false "completed" on the next idle this session sees.
          forgetLocallyPrompted(session.id)
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
      clearDraft(HOME_DRAFT_KEY)
      navigate(`/session/${entry.id}`, { state: { sending: true, messageText: text } })
      markLocallyPrompted(entry.id)
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
          forgetLocallyPrompted(entry.id)
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
    // An attachment with no text is a complete turn — don't require typing.
    if ((!text && attach.items.length === 0) || sending) return
    // `checking` matters as much as `blocker`: the gate awaits a 4 MB GET /provider, and
    // paste-then-Enter would otherwise outrun a check that simply hadn't finished.
    if (attach.blocker || attach.checking) return
    // Pre-dispatch consent gate (ADR-057): offer the free-trial card instead of dispatching when
    // the only usable models are free Zen models and the user hasn't opted in. On consent it
    // re-invokes handleSend, which then falls through to the real dispatch. Skipped for ACP agents
    // (Claude/Gemini CLI) — they carry their own auth and ignore the opencode model entirely, so a
    // free-Zen-model card would be meaningless there.
    if (!isACP && await maybeOfferFreeTrial(() => { void handleSend() })) return
    // Team mode runs on ACP, which is text-only; the composer already hides the attach
    // button there, so this is belt-and-braces rather than a reachable path.
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
                <div className="flex items-center gap-2">
                  <card.icon className="size-5 shrink-0 text-[var(--color-brand)]" />
                  <span className="text-sm font-medium text-[var(--color-fg)]">
                    {t(card.titleKey)}
                  </span>
                </div>
                <span className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
                  {t(card.descKey)}
                </span>
              </button>
            ))}
          </div>

          {/* Input */}
          <div className="flex w-full flex-col gap-2">
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              attachments={attachmentSlot}
              placeholder={mode === "team" ? t("team.inputPlaceholder") : t("placeholder.askAnything")}
              disabled={sending}
              loading={sending}
              variant="home"
              className="w-full"
              ctaLabel={t("home.startNow")}
              // The command list is OpenCode's; an ACP leader never sees it.
              // In Team mode `agentId` IS the leader, so this covers both modes.
              commandsEnabled={commandsAvailableFor(agentId)}
              topSlot={<ModeSwitch mode={mode} onModeChange={setMode} teamDisabled={!acpAvailable} />}
              leftSlot={
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
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
                      onOpenModelDialog={() => navigate("/settings", { state: { section: "models" } })}
                      title={mode === "team" ? t("home.model.leaderScope.hint") : undefined}
                    />
                  )}
                </div>
              }
            />

            {/* Workspace indicator (hidden until a workspace is confirmed):
                clicking the path copies the FULL path (display is shortened);
                the trailing entry mirrors the settings-popover workspace item. */}
            {workspacePath && (
              <div className="flex max-w-full items-center gap-0.5 text-xs text-[var(--color-fg-muted)]">
                <CopyButton
                  text={workspacePath}
                  label={shortenPath(workspacePath)}
                  title={workspacePath}
                  ariaLabel={t("home.workspace.copyHint")}
                  className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-[var(--color-accent)]/60 hover:text-[var(--color-fg)]"
                  iconClassName="size-3 shrink-0"
                  labelClassName="truncate"
                />
                <button
                  type="button"
                  onClick={() => navigate("/workspace")}
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-[var(--color-accent)]/60 hover:text-[var(--color-fg)]"
                >
                  <FolderOpen className="size-3" />
                  {t("home.workspace.switch")}
                </button>
              </div>
            )}
          </div>
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
