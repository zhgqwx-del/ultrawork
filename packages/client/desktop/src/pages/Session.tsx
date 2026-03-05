import { useRef, useEffect } from "react"
import { useParams } from "react-router-dom"
import { useSidebar } from "@/components/layout"
import { useSessionsContext } from "@/lib/sessions-context"
import { cn } from "@/lib/utils"
import { PanelLeft } from "lucide-react"

export function SessionPage() {
  const { id } = useParams()
  const { toggleLeft } = useSidebar()
  const { sessions } = useSessionsContext()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Find the current session
  const session = sessions.find(s => s.id === id)

  // Placeholder messages for layout validation
  const messages: Array<{ role: "user" | "assistant"; content: string }> = []

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

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
            {/* Will be replaced with ChatInput in 2.5 */}
            <div className="rounded-xl border border-[--color-border] bg-[--color-bg] p-3 shadow-sm">
              <textarea
                placeholder="Reply..."
                className="w-full resize-none border-0 bg-transparent px-1 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none"
                rows={1}
                style={{ minHeight: "20px", maxHeight: "120px" }}
              />
              <div className="mt-2 flex items-center justify-end">
                <button
                  aria-label="Send reply"
                  className="flex size-7 items-center justify-center rounded-full bg-[--color-fg-muted] text-[--color-bg]"
                >
                  <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Sidebar placeholder (Phase 3) */}
    </div>
  )
}
