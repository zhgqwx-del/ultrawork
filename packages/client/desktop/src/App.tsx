import { useState, useEffect, useRef } from "react"
import { createApiClient, type MessagePart } from "@agent/api-client"

const API_BASE = "http://localhost:4096"
const PASSWORD = "test123"

const client = createApiClient({
  baseUrl: API_BASE,
  password: PASSWORD,
})

function App() {
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([])
  const [input, setInput] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState("Connecting...")
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Create session on mount with retry
  useEffect(() => {
    const connect = async () => {
      for (let i = 0; i < 10; i++) {
        try {
          const session = await client.createSession()
          setSessionId(session.id)
          setStatus("Connected")
          return
        } catch {
          setStatus(`Connecting... (${i + 1}/10)`)
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
      setStatus("Connection failed")
    }
    connect()
  }, [])

  const handleSend = async () => {
    if (!input.trim() || !sessionId || sending) return

    const userMessage = input
    setMessages((prev) => [...prev, { role: "user", content: userMessage }])
    setInput("")
    setSending(true)
    setStatus("Thinking...")

    try {
      const response = await client.sendMessage(sessionId, userMessage)

      // Extract text from response parts
      const textParts = (response.parts || [])
        .filter((p: MessagePart) => p.type === "text" && p.text)
        .map((p: MessagePart) => p.text!)
        .join("\n")

      if (textParts) {
        setMessages((prev) => [...prev, { role: "assistant", content: textParts }])
      }
      setStatus("Connected")
    } catch (error) {
      console.error("Failed to send message:", error)
      setStatus("Error - click to retry")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-gray-50">
      {/* Status bar */}
      <div className="flex items-center justify-between border-b bg-white px-4 py-2">
        <span className="text-sm font-medium text-gray-800">Ultrawork</span>
        <span
          className={`text-xs ${
            status === "Connected"
              ? "text-green-600"
              : status.startsWith("Error")
                ? "text-red-500"
                : "text-yellow-600"
          }`}
        >
          {status === "Connected" ? "● Connected" : status}
        </span>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-gray-400">
            Send a message to start chatting
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`mb-4 ${msg.role === "user" ? "text-right" : ""}`}>
            <div className="mb-1 text-xs text-gray-400">{msg.role === "user" ? "You" : "Assistant"}</div>
            <div
              className={`inline-block max-w-[80%] rounded-lg px-4 py-2 text-left ${
                msg.role === "user"
                  ? "bg-blue-500 text-white"
                  : "border border-gray-200 bg-white text-gray-900"
              }`}
              style={{ whiteSpace: "pre-wrap" }}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="mb-4">
            <div className="mb-1 text-xs text-gray-400">Assistant</div>
            <div className="inline-block rounded-lg border border-gray-200 bg-white px-4 py-2 text-gray-400">
              Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t bg-white p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder="Type a message..."
            disabled={sending || !sessionId}
            className="flex-1 rounded-lg border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          />
          <button
            onClick={handleSend}
            disabled={sending || !sessionId}
            className="rounded-lg bg-blue-500 px-6 py-2 text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {sending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
