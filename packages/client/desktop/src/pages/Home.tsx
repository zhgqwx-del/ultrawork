import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { FolderOpen, Pen, FileText } from "lucide-react"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { ChatInput } from "@/components/chat"
import { TopBar } from "@/components/layout/top-bar"
import { useI18n } from "@/lib/i18n-context"

const ABILITY_CARDS = [
  {
    icon: FolderOpen,
    titleKey: "home.card.files",
    descKey: "home.card.files.desc",
    prompt: "Help me organize and sort my files in the current directory",
  },
  {
    icon: Pen,
    titleKey: "home.card.content",
    descKey: "home.card.content.desc",
    prompt: "Help me write an article about ",
  },
  {
    icon: FileText,
    titleKey: "home.card.docs",
    descKey: "home.card.docs.desc",
    prompt: "Help me analyze and summarize this document: ",
  },
]

export function HomePage() {
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const navigate = useNavigate()
  const { createSession } = useSessionsContext()
  const api = useApi()
  const { t } = useI18n()

  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return

    setSending(true)
    try {
      const session = await createSession()
      await api.sendMessage(session.id, text)
      setInput("")
      navigate(`/session/${session.id}`)
    } catch (err) {
      console.error("Failed to send message:", err)
      toast.error("Failed to send message. Please check your connection.")
    } finally {
      setSending(false)
    }
  }

  const handleCardClick = (prompt: string) => {
    setInput(prompt)
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <TopBar />

      <div className="flex flex-1 flex-col items-center justify-center px-4 pb-8">
        <div className="flex w-full max-w-2xl flex-col items-center gap-8">
          {/* Headline */}
          <div className="space-y-2 text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-[--color-fg] md:text-4xl">
              {t("home.headline")}
            </h1>
            <p className="text-sm text-[--color-fg-muted]">
              {t("home.subtitle")}
            </p>
          </div>

          {/* Ability Cards */}
          <div className="grid w-full grid-cols-3 gap-3">
            {ABILITY_CARDS.map((card) => (
              <button
                key={card.titleKey}
                onClick={() => handleCardClick(card.prompt)}
                className="flex flex-col items-start gap-2 rounded-xl border border-[--color-border] bg-[--color-bg-subtle] p-4 text-left transition-all hover:border-[--color-brand] hover:shadow-sm"
              >
                <card.icon className="size-5 text-[--color-brand]" />
                <span className="text-sm font-medium text-[--color-fg]">
                  {t(card.titleKey)}
                </span>
                <span className="text-xs leading-relaxed text-[--color-fg-muted]">
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
            placeholder="Ask anything..."
            disabled={sending}
            loading={sending}
            variant="home"
            className="w-full"
            ctaLabel={t("home.startNow")}
          />
        </div>
      </div>
    </div>
  )
}
