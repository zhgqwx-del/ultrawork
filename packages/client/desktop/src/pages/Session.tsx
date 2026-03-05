import { useRef, useEffect, useState, useCallback } from "react"
import { useParams } from "react-router-dom"
import { useSidebar } from "@/components/layout"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { useSSE } from "@/lib/use-sse"
import { ChatInput, MessageList } from "@/components/chat"
import { cn } from "@/lib/utils"
import { PanelLeft } from "lucide-react"
import type { SendMessageResponse } from "@agent/api-client"

export function SessionPage() {
  const { id } = useParams()
  const { toggleLeft } = useSidebar()
  const { sessions } = useSessionsContext()
  const api = useApi()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<SendMessageResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)

  // Find the current session
  const session = sessions.find(s => s.id === id)

  // Handle SSE events
  const handleSSEEvent = useCallback(
    (event: any) => {
      const { payload } = event

      // Only process events for current session
      if (payload.properties?.sessionID !== id) return

      switch (payload.type) {
        case "message.delta": {
          const { messageID, delta } = payload.properties
          setStreamingMessageId(messageID)
          setMessages((prev) => {
            // Find existing message
            const existingIndex = prev.findIndex((m) => m.info.id === messageID)

            if (existingIndex >= 0) {
              // Update existing message (immutable)
              const updated = [...prev]
              const existing = { ...updated[existingIndex] }
              const textPartIndex = existing.parts.findIndex((p) => p.type === "text")

              if (textPartIndex >= 0) {
                // Update existing text part
                const textPart = existing.parts[textPartIndex]
                existing.parts = [
                  ...existing.parts.slice(0, textPartIndex),
                  { ...textPart, text: (textPart.text || "") + delta },
                  ...existing.parts.slice(textPartIndex + 1),
                ]
              } else {
                // Add new text part
                existing.parts = [...existing.parts, { type: "text", text: delta }]
              }

              updated[existingIndex] = existing
              return updated
            } else {
              // Create new message
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
          const { messageID } = payload.properties
          setStreamingMessageId(null)
          setMessages((prev) => {
            const updated = [...prev]
            const message = updated.find((m) => m.info.id === messageID)
            if (message) {
              message.info.time.completed = Date.now()
            }
            return updated
          })
          break
        }

        case "session.updated": {
          // Session title updated, will be reflected in sidebar via SessionsContext
          break
        }
      }
    },
    [id]
  )

  // Connect to SSE
  useSSE(handleSSEEvent)

  // Load messages when session ID changes
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
          setMessages([])
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [id, api])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const handleSend = async () => {
    if (!id || !input.trim() || sending) return

    const userMessage = input.trim()
    const tempId = `temp-${Date.now()}`
    setSending(true)

    // Optimistically add user message to UI
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
    setInput("") // Clear input immediately

    try {
      // Send message (AI response will come via SSE)
      const response = await api.sendMessage(id, userMessage)

      // Replace temporary user message with real one from server
      setMessages((prev) =>
        prev.map((m) => (m.info.id === tempId ? response : m))
      )
    } catch (err) {
      console.error("Failed to send message:", err)
      // Remove optimistic message on error
      setMessages((prev) => prev.filter((m) => m.info.id !== tempId))
      setInput(userMessage) // Restore input
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      {/* Left Panel - Chat */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl">
        {/* Header */}
        <header className="z-10 flex shrink-0 items-center gap-2 border-none px-4 py-3">
          <button
            onClick={toggleLeft}
            aria-label="Toggle sidebar"
            className="flex items-center justify-center rounded-lg p-2 text-[--color-fg-muted] transition-colors hover:bg-[--color-accent] hover:text-[--color-fg] md:hidden"
          >
            <PanelLeft className="size-5" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <h1 className="inline-block max-w-full truncate px-2 py-1 text-sm font-normal text-[--color-fg]">
              {session?.title || "New Chat"}
            </h1>
          </div>
        </header>

        {/* Messages Area */}
        <div className={cn("relative flex-1 overflow-x-hidden overflow-y-auto scrollbar-soft", "flex justify-center")}>
          <div className="w-full max-w-[800px] px-6 pt-4 pb-24">
            <MessageList messages={messages} isLoading={loading} streamingMessageId={streamingMessageId} />
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Reply Input - Centered */}
        <div className="relative shrink-0 flex justify-center">
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

      {/* Right Sidebar placeholder (Phase 3) */}
    </div>
  )
}
