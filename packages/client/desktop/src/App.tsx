import { useState, useEffect } from "react"

const API_BASE = "http://localhost:4096"
const PASSWORD = "test123"

function App() {
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([])
  const [input, setInput] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState("Connecting...")

  useEffect(() => {
    createSession()
  }, [])

  const createSession = async (retries = 10) => {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(`${API_BASE}/session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}`,
          },
          body: JSON.stringify({}),
        })
        const data = await res.json()
        setSessionId(data.id)
        setStatus("Connected")
        return
      } catch {
        setStatus(`Connecting... (${i + 1}/${retries})`)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    setStatus("Connection failed")
  }

  const handleSend = async () => {
    if (!input.trim() || !sessionId) return

    const userMessage = input
    setMessages([...messages, { role: "user", content: userMessage }])
    setInput("")

    try {
      await fetch(`${API_BASE}/session/${sessionId}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}`,
        },
        body: JSON.stringify({ prompt: userMessage }),
      })
    } catch (error) {
      console.error("Failed to send message:", error)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-gray-50">
      <div className="border-b bg-white px-4 py-2 text-sm text-gray-600">{status}</div>
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((msg, i) => (
          <div key={i} className={`mb-4 ${msg.role === "user" ? "text-right" : ""}`}>
            <div
              className={`inline-block rounded-lg px-4 py-2 ${
                msg.role === "user" ? "bg-blue-500 text-white" : "bg-white text-gray-900"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t bg-white p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Type a message..."
            className="flex-1 rounded-lg border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleSend}
            className="rounded-lg bg-blue-500 px-6 py-2 text-white hover:bg-blue-600"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
