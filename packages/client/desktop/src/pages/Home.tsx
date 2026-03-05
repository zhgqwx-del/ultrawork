import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { Loader2 } from "lucide-react"

export function HomePage() {
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const navigate = useNavigate()
  const { createSession } = useSessionsContext()
  const api = useApi()

  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return

    setSending(true)
    try {
      // Create session → send first message → navigate
      const session = await createSession()
      // Fire and forget: send message (response comes via SSE in 2.4)
      api.sendMessage(session.id, text).catch(console.error)
      navigate(`/session/${session.id}`)
    } catch (err) {
      console.error("Failed to create session:", err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-auto px-4">
      <div className="flex w-full max-w-2xl flex-col items-center gap-6">
        {/* Title */}
        <h1 className="text-center text-4xl font-normal tracking-tight text-[--color-fg] md:text-5xl">
          What can I help you with?
        </h1>

        {/* Input */}
        <div className="w-full rounded-2xl border border-[--color-border] bg-[--color-bg] p-4 shadow-lg">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything..."
            disabled={sending}
            className="w-full resize-none border-0 bg-transparent text-base text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none disabled:opacity-50"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <div className="mt-3 flex items-center justify-end">
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              aria-label="Send message"
              className="flex size-8 items-center justify-center rounded-full bg-[--color-fg] text-[--color-bg] transition-all disabled:opacity-30"
            >
              {sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
