import { useRef, useEffect, useState, useCallback } from "react"
import { useParams } from "react-router-dom"
import { toast } from "sonner"
import { TopBar } from "@/components/layout/top-bar"
import { useSidebar } from "@/components/layout/sidebar-context"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { useSSE } from "@/lib/use-sse"
import { ChatInput, MessageList } from "@/components/chat"
import { ExecutionStatus } from "@/components/chat/execution-status"
import { PermissionDock } from "@/components/chat/permission-dock"
import { QuestionDock } from "@/components/chat/question-dock"
import { cn } from "@/lib/utils"
import { PanelRight, ChevronDown, ChevronRight } from "lucide-react"
import { ProgressPanel, ArtifactsPanel, WorkspacePanel } from "@/components/session"
import { useI18n } from "@/lib/i18n-context"
import type { SendMessageResponse, PermissionRequest, QuestionRequest } from "@agent/api-client"
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
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
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

  // Helper: get sessionID from event properties (OpenCode uses both "sessionID" and nested part.sessionID)
  const getEventSessionID = useCallback((event: SSEEvent): string | undefined => {
    const props = event.properties as Record<string, any>
    if (props.sessionID) return props.sessionID
    if (props.part?.sessionID) return props.part.sessionID
    if (props.info?.sessionID) return props.info.sessionID
    if (props.id) return props.id // session.updated may use id
    return undefined
  }, [])

  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      const eventSessionID = getEventSessionID(event)
      // Filter events not for this session (except session-level events that use id)
      if (eventSessionID && eventSessionID !== id) return

      switch (event.type) {
        // --- OpenCode primary events ---

        case "message.part.updated": {
          // Full part object upserted (creation or state change)
          const { part } = event.properties
          if (!("messageID" in part)) break
          const messageID = (part as any).messageID as string
          setStreamingMessageId(messageID)
          setMessages((prev) => {
            const msgIndex = prev.findIndex((m) => m.info.id === messageID)
            if (msgIndex >= 0) {
              const updated = [...prev]
              const msg = { ...updated[msgIndex] }
              const partID = (part as any).id as string
              const partIndex = msg.parts.findIndex((p) => "id" in p && (p as any).id === partID)
              if (partIndex >= 0) {
                msg.parts = [...msg.parts.slice(0, partIndex), part, ...msg.parts.slice(partIndex + 1)]
              } else {
                msg.parts = [...msg.parts, part]
              }
              updated[msgIndex] = msg
              return updated
            }
            // New message — remove any temp user message (optimistic UI dedup)
            const filtered = prev.filter((m) => !m.info.id.startsWith("temp-"))
            return [
              ...filtered,
              {
                info: {
                  id: messageID,
                  sessionID: id!,
                  role: "assistant" as const,
                  time: { created: Date.now() },
                },
                parts: [part],
              },
            ]
          })
          break
        }

        case "message.part.delta": {
          // Incremental text append to a specific part field
          const { messageID, partID, field, delta } = event.properties
          setStreamingMessageId(messageID)
          setMessages((prev) => {
            const msgIndex = prev.findIndex((m) => m.info.id === messageID)
            if (msgIndex >= 0) {
              const updated = [...prev]
              const msg = { ...updated[msgIndex] }
              const pIndex = msg.parts.findIndex((p) => "id" in p && (p as any).id === partID)
              if (pIndex >= 0) {
                const existing = msg.parts[pIndex] as any
                const updatedPart = { ...existing, [field]: (existing[field] || "") + delta }
                msg.parts = [...msg.parts.slice(0, pIndex), updatedPart, ...msg.parts.slice(pIndex + 1)]
              }
              updated[msgIndex] = msg
              return updated
            } else {
              // Create new message with a text part for this delta
              return [
                ...prev,
                {
                  info: {
                    id: messageID,
                    sessionID: id!,
                    role: "assistant" as const,
                    time: { created: Date.now() },
                  },
                  parts: [{ type: "text", id: partID, sessionID: id!, messageID, [field]: delta } as any],
                },
              ]
            }
          })
          break
        }

        case "message.updated": {
          // Message metadata updated (e.g., completion)
          const { info } = event.properties
          if (info.sessionID !== id) break
          setStreamingMessageId(null)
          setMessages((prev) =>
            prev.map((m) =>
              m.info.id === info.id ? { ...m, info: { ...m.info, ...info } } : m
            )
          )
          // Clear sending state when assistant message completes
          if (info.role === "assistant" && info.finish) {
            setSending(false)
          }
          break
        }

        case "message.part.removed": {
          const { messageID, partID } = event.properties
          setMessages((prev) =>
            prev.map((m) =>
              m.info.id === messageID
                ? { ...m, parts: m.parts.filter((p) => !("id" in p) || (p as any).id !== partID) }
                : m
            )
          )
          break
        }

        // --- Legacy events (backward compat) ---

        case "message.delta": {
          const { messageID, delta } = event.properties as any
          setStreamingMessageId(messageID)
          setMessages((prev) => {
            const existingIndex = prev.findIndex((m) => m.info.id === messageID)
            if (existingIndex >= 0) {
              const updated = [...prev]
              const existing = { ...updated[existingIndex] }
              const textPartIndex = existing.parts.findIndex((p) => p.type === "text")
              if (textPartIndex >= 0) {
                const textPart = existing.parts[textPartIndex]
                const existingText = "text" in textPart ? (textPart.text as string) : ""
                existing.parts = [
                  ...existing.parts.slice(0, textPartIndex),
                  { ...textPart, text: existingText + delta },
                  ...existing.parts.slice(textPartIndex + 1),
                ]
              } else {
                existing.parts = [...existing.parts, { type: "text", text: delta } as any]
              }
              updated[existingIndex] = existing
              return updated
            } else {
              return [
                ...prev,
                {
                  info: { id: messageID, sessionID: id!, role: "assistant" as const, time: { created: Date.now() } },
                  parts: [{ type: "text", text: delta } as any],
                },
              ]
            }
          })
          break
        }

        case "message.completed": {
          const { messageID } = event.properties as any
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

        // --- Session events ---

        case "session.updated": {
          const props = event.properties
          const sid = props.sessionID || props.id
          const title = props.title
          if (sid && title) {
            updateSession(sid, { title })
          }
          break
        }

        case "session.status": {
          const { sessionID, status } = event.properties as { sessionID: string; status: { type: string } }
          if (sessionID === id && status.type === "idle") {
            setSending(false)
          }
          break
        }

        // --- Permission / Question blocking-interaction events ---

        case "permission.asked": {
          const perm = event.properties as PermissionRequest
          if (perm.sessionID === id) {
            setPendingPermission(perm)
          }
          break
        }

        case "permission.replied": {
          setPendingPermission(null)
          break
        }

        case "question.asked": {
          const q = event.properties as QuestionRequest
          if (q.sessionID === id) {
            setPendingQuestion(q)
          }
          break
        }

        case "question.replied":
        case "question.rejected": {
          setPendingQuestion(null)
          break
        }
      }
    },
    [id, updateSession, getEventSessionID]
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

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setSending(false)
    // Call server-side abort endpoint
    if (id) {
      api.abortSession(id).catch(() => {
        // Ignore abort errors — best effort
      })
    }
  }, [id, api])

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

    // Fire-and-forget: SSE handles all message display
    // When SSE creates a new message, any temp- messages are automatically removed
    api.sendMessage(id, userMessage).catch((err) => {
      console.error("Failed to send message:", err)
    })
  }

  const handlePermissionReply = useCallback(
    (reply: "once" | "always" | "reject") => {
      if (!pendingPermission) return
      setPendingPermission(null)
      api.replyPermission(pendingPermission.id, reply).catch((err: Error) => {
        console.error("Failed to reply permission:", err)
        toast.error("Failed to reply permission")
      })
    },
    [pendingPermission, api]
  )

  const handleQuestionReply = useCallback(
    (answers: string[][]) => {
      if (!pendingQuestion) return
      setPendingQuestion(null)
      api.replyQuestion(pendingQuestion.id, answers).catch((err: Error) => {
        console.error("Failed to reply question:", err)
        toast.error("Failed to reply question")
      })
    },
    [pendingQuestion, api]
  )

  const handleQuestionReject = useCallback(() => {
    if (!pendingQuestion) return
    setPendingQuestion(null)
    api.rejectQuestion(pendingQuestion.id).catch((err: Error) => {
      console.error("Failed to reject question:", err)
      toast.error("Failed to reject question")
    })
  }, [pendingQuestion, api])

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
            {sending && (
              <ExecutionStatus
                state="working"
                onStop={handleStop}
              />
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Reply Input / Permission Dock / Question Dock */}
        <div className="relative flex shrink-0 justify-center">
          {pendingQuestion ? (
            <QuestionDock
              request={pendingQuestion}
              onReply={handleQuestionReply}
              onReject={handleQuestionReject}
            />
          ) : pendingPermission ? (
            <PermissionDock
              request={pendingPermission}
              onReply={handlePermissionReply}
            />
          ) : (
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
          )}
        </div>
      </div>

      {/* Right Sidebar */}
      {rightOpen && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-[--color-border] bg-[--color-bg]">
          <div className="flex-1 overflow-y-auto p-3 scrollbar-soft">
            <RightSidebarSection title={t("session.rightSidebar.plan")}>
              <ProgressPanel messages={messages} />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.workspace")}>
              <WorkspacePanel directory={session?.directory} />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.artifacts")}>
              <ArtifactsPanel messages={messages} />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.mcp")} placeholder={t("placeholder.comingSoon")} />
            <RightSidebarSection title={t("session.rightSidebar.skills")} placeholder={t("placeholder.comingSoon")} />
          </div>
        </aside>
      )}
    </div>
  )
}

function RightSidebarSection({ title, placeholder, children }: { title: string; placeholder?: string; children?: React.ReactNode }) {
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
          {children || placeholder}
        </div>
      )}
    </div>
  )
}
