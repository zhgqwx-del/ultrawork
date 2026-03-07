import { useRef, useEffect, useState, useCallback } from "react"
import { useParams } from "react-router-dom"
import { toast } from "sonner"
import { TopBar } from "@/components/layout/top-bar"
import { useSidebar } from "@/components/layout/sidebar-context"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { useSSE } from "@/lib/use-sse"
import { ChatInput, MessageList } from "@/components/chat"
import { cn } from "@/lib/utils"
import { PanelRight, ChevronDown, ChevronRight } from "lucide-react"
import { useI18n } from "@/lib/i18n-context"
import type { SendMessageResponse } from "@agent/api-client"
import type { SSEEvent } from "@/lib/sse-client"

export function SessionPage() {
  const { id } = useParams()
  const { sessions, updateSession } = useSessionsContext()
  const api = useApi()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const { t } = useI18n()

  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<SendMessageResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const { rightOpen, toggleRight } = useSidebar()
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const session = sessions.find(s => s.id === id)

  const checkIfAtBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return true
    const threshold = 100
    const isBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold
    setIsAtBottom(isBottom)
  }, [])

  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      if (event.properties?.sessionID !== id) return

      switch (event.type) {
        case "message.delta": {
          const { messageID, delta } = event.properties
          setStreamingMessageId(messageID)
          setMessages((prev) => {
            const existingIndex = prev.findIndex((m) => m.info.id === messageID)
            if (existingIndex >= 0) {
              const updated = [...prev]
              const existing = { ...updated[existingIndex] }
              const textPartIndex = existing.parts.findIndex((p) => p.type === "text")
              if (textPartIndex >= 0) {
                const textPart = existing.parts[textPartIndex]
                existing.parts = [
                  ...existing.parts.slice(0, textPartIndex),
                  { ...textPart, text: (textPart.text || "") + delta },
                  ...existing.parts.slice(textPartIndex + 1),
                ]
              } else {
                existing.parts = [...existing.parts, { type: "text", text: delta }]
              }
              updated[existingIndex] = existing
              return updated
            } else {
              return [
                ...prev,
                {
                  info: {
                    id: messageID,
                    sessionID: id!,
                    role: "assistant" as const,
                    time: { created: Date.now() },
                  },
                  parts: [{ type: "text", text: delta }],
                },
              ]
            }
          })
          break
        }
        case "message.completed": {
          const { messageID } = event.properties
          setStreamingMessageId(null)
          setMessages((prev) =>
            prev.map((m) =>
              m.info.id === messageID
                ? { ...m, info: { ...m.info, time: { ...m.info.time, completed: Date.now() } } }
                : m
            )
          )
          break
        }
        case "session.updated": {
          const { sessionID, title } = event.properties
          if (title) {
            updateSession(sessionID, { title })
          }
          break
        }
      }
    },
    [id, updateSession]
  )

  useSSE(handleSSEEvent)

  useEffect(() => {
    let cancelled = false
    if (!id) {
      setLoading(false)
      return
    }
    setLoading(true)
    api
      .getMessages(id)
      .then((msgs: SendMessageResponse[]) => {
        if (!cancelled) {
          setMessages(msgs)
          setLoading(false)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          console.error("Failed to load messages:", err)
          toast.error("Failed to load messages")
          setMessages([])
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [id, api])

  useEffect(() => {
    if (isAtBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages, isAtBottom])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const handleScroll = () => checkIfAtBottom()
    container.addEventListener("scroll", handleScroll)
    return () => container.removeEventListener("scroll", handleScroll)
  }, [checkIfAtBottom])

  const handleSend = async () => {
    if (!id || !input.trim() || sending) return
    const userMessage = input.trim()
    const tempId = `temp-${crypto.randomUUID()}`
    setSending(true)

    const tempUserMessage: SendMessageResponse = {
      info: {
        id: tempId,
        sessionID: id,
        role: "user",
        time: { created: Date.now() },
      },
      parts: [{ type: "text", text: userMessage }],
    }
    setMessages((prev) => [...prev, tempUserMessage])
    setInput("")

    try {
      const response = await api.sendMessage(id, userMessage)
      if (response.info.role === "user") {
        setMessages((prev) => prev.map((m) => (m.info.id === tempId ? response : m)))
      } else if (response.info.role === "assistant") {
        setMessages((prev) => {
          const userMessageWithId = {
            ...tempUserMessage,
            info: { ...tempUserMessage.info, id: `user-${crypto.randomUUID()}` },
          }
          return prev.map((m) => (m.info.id === tempId ? userMessageWithId : m)).concat(response)
        })
      }
    } catch (err) {
      console.error("Failed to send message:", err)
      toast.error("Failed to send message")
      setMessages((prev) => prev.filter((m) => m.info.id !== tempId))
      setInput(userMessage)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      {/* Left Panel - Chat */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header */}
        <TopBar title={session?.title || "New Chat"}>
          <button
            onClick={toggleRight}
            aria-label="Toggle right sidebar"
            className={cn(
              "flex size-8 items-center justify-center rounded-lg transition-colors",
              rightOpen
                ? "bg-[--color-accent] text-[--color-fg]"
                : "text-[--color-fg-muted] hover:bg-[--color-accent] hover:text-[--color-fg]"
            )}
          >
            <PanelRight className="size-4" />
          </button>
        </TopBar>

        {/* Messages Area */}
        <div
          ref={scrollContainerRef}
          className={cn("relative flex flex-1 justify-center overflow-x-hidden overflow-y-auto scrollbar-soft")}
        >
          <div className="w-full max-w-[800px] px-6 pt-4 pb-24">
            <MessageList messages={messages} isLoading={loading} streamingMessageId={streamingMessageId} />
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Reply Input */}
        <div className="relative flex shrink-0 justify-center">
          <div className="w-full max-w-[800px] px-4 py-3">
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              placeholder="Reply..."
              disabled={sending}
              loading={sending}
              variant="reply"
            />
          </div>
        </div>
      </div>

      {/* Right Sidebar */}
      {rightOpen && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-[--color-border] bg-[--color-bg]">
          <div className="flex-1 overflow-y-auto p-3 scrollbar-soft">
            <RightSidebarSection title={t("session.rightSidebar.plan")} placeholder={t("placeholder.comingInRound2")} />
            <RightSidebarSection title={t("session.rightSidebar.workspace")} placeholder={t("placeholder.comingInRound2")} />
            <RightSidebarSection title={t("session.rightSidebar.artifacts")} placeholder={t("placeholder.comingInRound2")} />
            <RightSidebarSection title={t("session.rightSidebar.mcp")} placeholder={t("placeholder.comingInRound2")} />
            <RightSidebarSection title={t("session.rightSidebar.skills")} placeholder={t("placeholder.comingInRound2")} />
          </div>
        </aside>
      )}
    </div>
  )
}

function RightSidebarSection({ title, placeholder }: { title: string; placeholder: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-b border-[--color-border] last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-3 text-sm font-medium text-[--color-fg] hover:text-[--color-fg]"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        {title}
      </button>
      {open && (
        <div className="pb-3 text-xs text-[--color-fg-muted]">
          {placeholder}
        </div>
      )}
    </div>
  )
}
