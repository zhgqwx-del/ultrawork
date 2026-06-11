import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { FolderOpen, Pen, FileText } from "lucide-react"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { useModel } from "@/lib/model-context"
import { useAgents } from "@/lib/agent-context"
import { OPENCODE_DEFAULT_AGENT_ID, isACPAgentId, parseAgentId } from "@/lib/agent-types"
import { ensureACPSession, promptACPSession } from "@/lib/agent-router"
import { ChatInput, ModelSelector, AgentSelector } from "@/components/chat"
import { TopBar } from "@/components/layout/top-bar"
import { useI18n } from "@/lib/i18n-context"

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
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  // The agent for the conversation about to start (档1: chosen before the
  // session is born; the binding freezes once the first message is sent).
  const [agentId, setAgentId] = useState(OPENCODE_DEFAULT_AGENT_ID)
  const navigate = useNavigate()
  const { createSession } = useSessionsContext()
  const { bindSessionAgent } = useAgents()
  const api = useApi()
  const { t } = useI18n()
  const { currentModel, setModel, openModelDialog } = useModel()
  const isACP = isACPAgentId(agentId)

  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return

    setSending(true)
    try {
      const session = await createSession()
      bindSessionAgent(session.id, agentId)
      setInput("")
      // Navigate immediately for instant UX; the prompt call is fire-and-forget.
      // Session.tsx has a safety timeout to reset sending if no SSE events arrive.
      navigate(`/session/${session.id}`, { state: { sending: true, messageText: text } })
      const prompt = isACP
        ? ensureACPSession(parseAgentId(agentId).rawId, session.directory, session.id).then(() =>
            promptACPSession(session.id, text),
          )
        : api.promptAsync(session.id, text, { model: currentModel || undefined })
      prompt.catch((err) => {
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
            placeholder={t("placeholder.askAnything")}
            disabled={sending}
            loading={sending}
            variant="home"
            className="w-full"
            ctaLabel={t("home.startNow")}
            leftSlot={
              <div className="flex items-center gap-1">
                <AgentSelector agentId={agentId} onAgentChange={setAgentId} />
                {!isACP && (
                  <ModelSelector
                    currentModel={currentModel}
                    onModelChange={setModel}
                    onOpenModelDialog={openModelDialog}
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
