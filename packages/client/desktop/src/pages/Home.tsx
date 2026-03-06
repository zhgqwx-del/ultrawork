import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { ChatInput } from "@/components/chat"

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
      // Create session
      const session = await createSession()

      // Send first message and wait for confirmation
      await api.sendMessage(session.id, text)

      // Clear input and navigate
      setInput("")
      navigate(`/session/${session.id}`)
    } catch (err) {
      console.error("Failed to send message:", err)
      // TODO: Show error toast to user
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
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          placeholder="Ask anything..."
          disabled={sending}
          loading={sending}
          variant="home"
          className="w-full"
        />
      </div>
    </div>
  )
}
