import { useRef, useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { useSidebar } from "@/components/layout"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { ChatInput } from "@/components/chat"
import { cn } from "@/lib/utils"
import { PanelLeft } from "lucide-react"

export function SessionPage() {
  const { id } = useParams()
  const { toggleLeft } = useSidebar()
  const { sessions } = useSessionsContext()
  const api = useApi()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)

  // Find the current session
  const session = sessions.find(s => s.id === id)

  // Placeholder messages for layout validation
  const messages: Array<{ role: "user" | "assistant"; content: string }> = []

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const handleSend = async () => {
    if (!id || !input.trim() || sending) return

    setSending(true)
    try {
      // Send message (response comes via SSE in 2.4)
      await api.sendMessage(id, input.trim())
      setInput("") // Clear input after successful send
    } catch (err) {
      console.error("Failed to send message:", err)
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
            {messages.length === 0 ? (
              <div className="flex min-h-[200px] items-center justify-center py-12">
                <p className="text-sm text-[--color-fg-muted]">
                  Send a message to start chatting
                </p>
              </div>
            ) : (
              <div className="max-w-full min-w-0 space-y-4">
                {/* Messages will be rendered here in 2.3 */}
              </div>
            )}
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
