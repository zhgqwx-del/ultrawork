import { useRef, useEffect, useState, useCallback, useMemo } from "react"
import { useParams, useLocation } from "react-router-dom"
import { toast } from "sonner"
import { TopBar } from "@/components/layout/top-bar"
import { useSidebar } from "@/components/layout/sidebar-context"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { useSSESubscribe } from "@/lib/sse-context"
import { useModel } from "@/lib/model-context"
import { ChatInput, MessageList, ModelSelector } from "@/components/chat"
import { ExecutionStatus } from "@/components/chat/execution-status"
import { PermissionDock } from "@/components/chat/permission-dock"
import { QuestionDock } from "@/components/chat/question-dock"
import { cn } from "@/lib/utils"
import { PanelRight, ChevronDown, ChevronRight } from "lucide-react"
import { ProgressPanel, ArtifactsPanel, WorkspacePanel, MCPPanel, SkillsPanel, ArtifactPreview } from "@/components/session"
import type { Artifact } from "@/components/session"
import { useI18n } from "@/lib/i18n-context"
import type { SendMessageResponse, PermissionRequest, QuestionRequest } from "@agent/api-client"
import type { SSEEvent } from "@/lib/sse-client"

export function SessionPage() {
  const { id } = useParams()
  const location = useLocation()
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
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null)
  const [stopped, setStopped] = useState(false) // temporary: blocks SSE during abort cycle
  const [stoppedAtMessageId, setStoppedAtMessageId] = useState<string | null>(null) // permanent: inline indicator
  const { currentModel, setModel, openModelDialog } = useModel()
  const { rightOpen, toggleRight } = useSidebar()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Refs to access latest state inside callbacks without stale closures
  const messagesRef = useRef<SendMessageResponse[]>(messages)
  messagesRef.current = messages
  const stoppedRef = useRef(stopped)
  stoppedRef.current = stopped
  // Message IDs from stopped interactions — events for these IDs are permanently
  // ignored even after `stopped` is cleared, preventing stale event leakage
  const frozenMessageIdsRef = useRef<Set<string>>(new Set())

  const session = sessions.find(s => s.id === id)

  // Reset session-specific state when navigating between sessions
  useEffect(() => {
    setPendingPermission(null)
    setPendingQuestion(null)
    setStreamingMessageId(null)
    // Preserve sending=true when navigating from Home with an in-flight prompt
    const navState = location.state as { sending?: boolean } | null
    setSending(!!navState?.sending)
    setSelectedArtifact(null)
    setStopped(false)
    setStoppedAtMessageId(null)
    frozenMessageIdsRef.current = new Set()
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps -- location.state is read once per id change

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

      // Block message events from stopped or frozen (old) interactions
      if (event.type.startsWith("message.")) {
        // Full block while stop is active (server still cleaning up)
        if (stoppedRef.current) return
        // After stopped is cleared, still block events for frozen message IDs
        // (prevents stale events from old interaction leaking into new one)
        const p = event.properties as Record<string, any>
        const msgId: string | undefined = p.messageID || p.part?.messageID || p.info?.id
        if (msgId && frozenMessageIdsRef.current.has(msgId)) return
      }

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
            // New message — check if this replaces a temp user message (optimistic UI dedup)
            const tempMsg = prev.find((m) => m.info.id.startsWith("temp-"))
            const hasTemp = !!tempMsg
            const filtered = prev.filter((m) => !m.info.id.startsWith("temp-"))
            // If there was a temp user message, the first new message from server is likely the real user message
            const inferredRole = hasTemp && part.type === "text" ? "user" as const : "assistant" as const
            return [
              ...filtered,
              {
                info: {
                  id: messageID,
                  sessionID: id!,
                  role: inferredRole,
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
            // Do NOT clear `stopped` here — server may still send message cleanup
            // events after idle. Clearing too early causes partial AI response to
            // vanish. `stopped` is cleared in handleSend when the user sends next msg.
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
          const { sessionID: permSid } = event.properties as { sessionID?: string }
          if (!permSid || permSid === id) setPendingPermission(null)
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
          const { sessionID: qSid } = event.properties as { sessionID?: string }
          if (!qSid || qSid === id) setPendingQuestion(null)
          break
        }
      }
    },
    [id, updateSession, getEventSessionID]
  )

  useSSESubscribe(handleSSEEvent)

  // --- Permission/Question polling fallback ---
  // If SSE missed the permission.asked / question.asked event (race condition
  // when navigating from Home → Session), poll every 3s to catch it.
  // Trigger: `sending` (sent from Session) OR `streamingMessageId` (SSE events
  // arriving — covers the Home→Session case where sending=false but AI is active).
  const isAgentActive = sending || streamingMessageId !== null
  useEffect(() => {
    if (!id || !isAgentActive || pendingPermission || pendingQuestion) return

    const poll = () => {
      api.listPermissions().then((perms) => {
        const match = perms.find((p) => p.sessionID === id)
        if (match) setPendingPermission(match)
      }).catch((err) => console.debug("Permission poll failed:", err))

      api.listQuestions().then((qs) => {
        const match = qs.find((q) => q.sessionID === id)
        if (match) setPendingQuestion(match)
      }).catch((err) => console.debug("Question poll failed:", err))
    }

    // Run immediately once, then every 3s
    poll()
    const timer = setInterval(poll, 3000)
    return () => clearInterval(timer)
  }, [id, isAgentActive, pendingPermission, pendingQuestion, api])

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
          toast.error(t("error.loadMessages"))
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
    setStopped(true)
    stoppedRef.current = true // Update ref immediately so SSE guard works before re-render
    setStreamingMessageId(null)
    setSending(false)

    const currentMsgs = messagesRef.current
    if (currentMsgs.length === 0) return

    // --- Freeze message IDs & set stopped indicator ---
    const lastMsg = currentMsgs[currentMsgs.length - 1]
    const frozenIds = new Set<string>()
    let stoppedId = lastMsg.info.id

    if (stoppedId.startsWith("temp-")) {
      // Promote temp msg to a stable ID so it survives temp-dedup when the
      // next interaction starts (temp-dedup removes ALL temp-* messages)
      const stableId = `stopped-${Date.now()}`
      setMessages((prev) =>
        prev.map((m) =>
          m.info.id === stoppedId
            ? { ...m, info: { ...m.info, id: stableId } }
            : m
        )
      )
      currentMsgs.forEach((m) =>
        frozenIds.add(m.info.id === stoppedId ? stableId : m.info.id)
      )
      stoppedId = stableId
    } else {
      currentMsgs.forEach((m) => frozenIds.add(m.info.id))
    }

    frozenMessageIdsRef.current = frozenIds
    setStoppedAtMessageId(stoppedId)

    // --- Abort + revert (server-side cleanup) ---
    // With frozenIds protecting the UI, revert's cleanup SSE events are safely
    // ignored. Revert ensures the server history is clean for the next prompt.
    if (id) {
      const lastUserMsg = [...currentMsgs].reverse().find(
        (m) => m.info.role === "user" && !m.info.id.startsWith("temp-")
      )
      api.abortSession(id)
        .then(() => {
          if (lastUserMsg) {
            return api.revertSession(id, lastUserMsg.info.id).catch(() => {
              // Revert is best-effort
            })
          }
        })
        .catch(() => {
          setSending(false)
        })
    }
  }, [id, api])

  const handleSend = async () => {
    if (!id || !input.trim() || sending) return
    // Clear stopped state so SSE events flow for the new interaction
    if (stoppedRef.current) {
      setStopped(false)
      stoppedRef.current = false
    }
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

    // Use prompt_async (returns 204 immediately) instead of fire-and-forget sendMessage
    // Pass current model so the server uses the selected model for this message
    api.promptAsync(id, userMessage, { model: currentModel || undefined }).catch((err) => {
      console.error("Failed to send message:", err)
      setSending(false)
      // Remove the orphaned temp message
      setMessages((prev) => prev.filter((m) => m.info.id !== tempId))
      toast.error(t("error.sendMessage"))
    })
  }

  const handlePermissionReply = useCallback(
    (reply: "once" | "always" | "reject") => {
      if (!pendingPermission) return
      const perm = pendingPermission
      setPendingPermission(null)
      api.replyPermission(perm.id, reply).catch((err: Error) => {
        console.error("Failed to reply permission:", err)
        // Restore the permission dock so user can retry
        setPendingPermission(perm)
        toast.error(t("error.replyPermission"))
      })
    },
    [pendingPermission, api, t]
  )

  const handleQuestionReply = useCallback(
    (answers: string[][]) => {
      if (!pendingQuestion) return
      const q = pendingQuestion
      setPendingQuestion(null)
      api.replyQuestion(q.id, answers).catch((err: Error) => {
        console.error("Failed to reply question:", err)
        setPendingQuestion(q)
        toast.error(t("error.replyQuestion"))
      })
    },
    [pendingQuestion, api, t]
  )

  const handleQuestionReject = useCallback(() => {
    if (!pendingQuestion) return
    const q = pendingQuestion
    setPendingQuestion(null)
    api.rejectQuestion(q.id).catch((err: Error) => {
      console.error("Failed to reject question:", err)
      setPendingQuestion(q)
      toast.error(t("error.rejectQuestion"))
    })
  }, [pendingQuestion, api, t])

  // Count completed tool calls to trigger workspace file tree refresh
  const workspaceRefreshKey = useMemo(() => {
    return messages.reduce((count, msg) => {
      if (!msg.parts) return count
      return count + msg.parts.filter(
        (p) => p.type === "tool" && "state" in p && (p as any).state?.status === "completed"
      ).length
    }, 0)
  }, [messages])

  const handleArtifactClick = useCallback((artifact: Artifact) => {
    // Add sessionId for patch type artifacts so preview can fetch diff
    setSelectedArtifact({ ...artifact, sessionId: id })
  }, [id])

  const handleClosePreview = useCallback(() => {
    setSelectedArtifact(null)
  }, [])

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      {/* Artifact Preview (left, 50% when active) */}
      {selectedArtifact && (
        <div className="w-1/2 shrink-0 overflow-hidden border-r border-[var(--color-border)]">
          <ArtifactPreview artifact={selectedArtifact} onClose={handleClosePreview} />
        </div>
      )}

      {/* Chat Panel (full width or 50% when preview active) */}
      <div className={cn("flex min-w-0 flex-col overflow-hidden", selectedArtifact ? "w-1/2" : "flex-1")}>
        {/* Header */}
        <TopBar title={session?.title || t("session.newChat")}>
          <button
            onClick={toggleRight}
            aria-label={t("aria.toggleSidebar")}
            className={cn(
              "flex size-8 items-center justify-center rounded-lg transition-colors",
              rightOpen
                ? "bg-[var(--color-accent)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
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
            <MessageList
              messages={messages}
              isLoading={loading}
              streamingMessageId={streamingMessageId}
              stoppedAtMessageId={stoppedAtMessageId}
              onArtifactClick={handleArtifactClick}
            />
            {sending && !stopped && (
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
                placeholder={t("placeholder.reply")}
                disabled={sending}
                loading={sending}
                variant="reply"
                leftSlot={
                  <ModelSelector
                    currentModel={currentModel}
                    onModelChange={setModel}
                    onOpenModelDialog={openModelDialog}
                  />
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* Right Sidebar */}
      {rightOpen && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]">
          <div className="flex-1 overflow-y-auto p-3 scrollbar-soft">
            <RightSidebarSection title={t("session.rightSidebar.plan")}>
              <ProgressPanel messages={messages} />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.workspace")}>
              <WorkspacePanel directory={session?.directory} refreshKey={workspaceRefreshKey} />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.artifacts")}>
              <ArtifactsPanel
                messages={messages}
                directory={session?.directory}
                onArtifactClick={handleArtifactClick}
                selectedPath={selectedArtifact?.path}
              />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.mcp")}>
              <MCPPanel />
            </RightSidebarSection>
            <RightSidebarSection title={t("session.rightSidebar.skills")}>
              <SkillsPanel />
            </RightSidebarSection>
          </div>
        </aside>
      )}

    </div>
  )
}

function RightSidebarSection({ title, placeholder, children }: { title: string; placeholder?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-b border-[var(--color-border)] last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-3 text-sm font-medium text-[var(--color-fg)] hover:text-[var(--color-fg)]"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        {title}
      </button>
      {open && (
        <div className="pb-3 text-xs text-[var(--color-fg-muted)]">
          {children || placeholder}
        </div>
      )}
    </div>
  )
}
