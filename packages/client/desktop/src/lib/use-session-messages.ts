import { useRef, useEffect, useState, useCallback, useMemo } from "react"
import { toast } from "sonner"
import { useSessionsContext } from "@/lib/sessions-context"
import { useApi } from "@/lib/use-api"
import { useSSESubscribe } from "@/lib/sse-context"
import { useI18n } from "@/lib/i18n-context"
import { useAgents } from "@/lib/agent-context"
import { isACPAgentId, parseAgentId } from "@/lib/agent-types"
import { ensureACPSession, promptACPSession, cancelACPSession, fetchACPSessionMessages } from "@/lib/agent-router"
import { useACPSSE } from "@/lib/use-acp-sse"
import type { SendMessageResponse } from "@agent/api-client"
import type { SSEEvent } from "@/lib/sse-client"

// --- History window constants ---
const TURN_INIT = 15           // Initial turns to render on session load
const TURN_BATCH = 8           // Turns to reveal per backfill gesture
const INITIAL_PAGE_SIZE = 80   // First API request limit
const HISTORY_PAGE_SIZE = 200  // Older history API request limit
const PREFETCH_BUFFER = 16    // Start prefetching when turnStart <= this
const PREFETCH_COOLDOWN = 400  // ms between prefetch requests

interface UseSessionMessagesOptions {
  /** True when navigating from Home with an in-flight prompt */
  initialSending?: boolean
  /** Pre-fill user message text for optimistic UI */
  initialMessageText?: string
}

export function useSessionMessages(
  sessionId: string | undefined,
  options?: UseSessionMessagesOptions,
) {
  const { sessions, updateSession, markSessionActive, markSessionIdle } = useSessionsContext()
  const api = useApi()
  const { t } = useI18n()

  // --- Per-session agent binding (ADR-027 档1) ---
  const { getSessionAgentId } = useAgents()
  const boundAgentId = getSessionAgentId(sessionId)
  const isACP = isACPAgentId(boundAgentId)

  // --- Core message state ---
  const [messages, setMessages] = useState<SendMessageResponse[]>([])
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [stopped, setStopped] = useState(false)
  const [stoppedAtMessageId, setStoppedAtMessageId] = useState<string | null>(null)
  const [toolCompletionCount, setToolCompletionCount] = useState(0)

  // --- History window state ---
  const [turnStart, setTurnStart] = useState(0)
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)

  // --- Refs for synchronous access inside SSE callbacks ---
  const sendingRef = useRef(false)
  const messagesRef = useRef<SendMessageResponse[]>(messages)
  messagesRef.current = messages
  const stoppedRef = useRef(stopped)
  stoppedRef.current = stopped
  const idRef = useRef(sessionId)
  idRef.current = sessionId
  const frozenMessageIdsRef = useRef<Set<string>>(new Set())
  const optionsRef = useRef(options)
  optionsRef.current = options
  const prefetchUntilRef = useRef(0)

  // --- Windowed display messages ---
  const displayMessages = useMemo(() => {
    if (turnStart <= 0) return messages
    // turnStart is based on user message indices; translate to flat array index
    let userIdx = 0
    let sliceFrom = 0
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].info.role === "user") {
        if (userIdx >= turnStart) {
          sliceFrom = i
          break
        }
        userIdx++
      }
    }
    return messages.slice(sliceFrom)
  }, [messages, turnStart])

  // --- Session navigation reset ---
  useEffect(() => {
    const opts = optionsRef.current
    setMessages([])
    setStreamingMessageId(null)
    setToolCompletionCount(0)
    setStopped(false)
    setStoppedAtMessageId(null)
    setTurnStart(0)
    setCursor(undefined)
    setHasMore(false)
    setHistoryLoading(false)
    frozenMessageIdsRef.current = new Set()
    prefetchUntilRef.current = 0

    const isSendingFromNav = !!opts?.initialSending
    setSending(isSendingFromNav)
    sendingRef.current = isSendingFromNav

    // Optimistic user message from Home navigation
    if (isSendingFromNav && sessionId) {
      markSessionActive(sessionId)
      if (opts?.initialMessageText) {
        const tempId = `temp-${crypto.randomUUID()}`
        setMessages([{
          info: {
            id: tempId,
            sessionID: sessionId,
            role: "user",
            time: { created: Date.now() },
          },
          parts: [{ type: "text", text: opts.initialMessageText }],
        }])
      }
    }

    // 8-second safety timeout for Home→Session navigation
    if (isSendingFromNav && sessionId) {
      const sid = sessionId
      const timer = setTimeout(() => {
        if (sendingRef.current && !stoppedRef.current) {
          sendingRef.current = false
          setSending(false)
          markSessionIdle(sid)
        }
      }, 8000)
      return () => clearTimeout(timer)
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Initial message load (paginated) ---
  useEffect(() => {
    let cancelled = false
    if (!sessionId) {
      setLoading(false)
      return
    }
    setLoading(true)
    // ACP-bound sessions: history lives in the ACP sidecar's store (shaped,
    // returned whole — the turn window below still limits what renders).
    const load = isACP
      ? fetchACPSessionMessages(sessionId).then((messages) => ({
          messages,
          cursor: undefined,
          hasMore: false,
        }))
      : api.getMessagesPaginated(sessionId, { limit: INITIAL_PAGE_SIZE })
    load
      .then((result) => {
        if (!cancelled) {
          const msgs = result.messages
          setMessages(prev => {
            if (prev.length === 0) return msgs
            if (msgs.length === 0) return prev
            const serverIds = new Set(msgs.map(m => m.info.id))
            const sseOnly = prev.filter(m =>
              !m.info.id.startsWith("temp-") && !serverIds.has(m.info.id)
            )
            return [...msgs, ...sseOnly]
          })
          setCursor(result.cursor)
          setHasMore(result.hasMore)
          // Set initial window: show last TURN_INIT turns
          const userCount = msgs.filter(m => m.info.role === "user").length
          setTurnStart(userCount > TURN_INIT ? userCount - TURN_INIT : 0)
          // Seed tool completion counter
          const initialToolCount = msgs.reduce((count, msg) => {
            if (!msg.parts) return count
            return count + msg.parts.filter(
              (p) => p.type === "tool" && "state" in p && (p as any).state?.status === "completed"
            ).length
          }, 0)
          setToolCompletionCount(initialToolCount)
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
  }, [sessionId, api, isACP]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- History loading: fetch older messages ---
  const loadOlderMessages = useCallback(async () => {
    if (!sessionId || !hasMore || historyLoading || !cursor) return
    setHistoryLoading(true)
    try {
      const result = await api.getMessagesPaginated(sessionId, {
        limit: HISTORY_PAGE_SIZE,
        before: cursor,
      })
      if (idRef.current !== sessionId) return // session changed
      setMessages(prev => [...result.messages, ...prev])
      setCursor(result.cursor)
      setHasMore(result.hasMore)
      // Shift turnStart to account for newly prepended messages
      const newUserCount = result.messages.filter(m => m.info.role === "user").length
      setTurnStart(prev => prev + newUserCount)
    } catch (err) {
      console.error("Failed to load older messages:", err)
    } finally {
      setHistoryLoading(false)
    }
  }, [sessionId, hasMore, historyLoading, cursor, api])

  // --- Backfill: reveal cached messages above the window ---
  const backfillTurns = useCallback(() => {
    setTurnStart(prev => {
      if (prev <= 0) return 0
      const next = prev - TURN_BATCH
      return next > 0 ? next : 0
    })
  }, [])

  // --- Scroll-triggered backfill + prefetch ---
  const onScrollNearTop = useCallback(() => {
    const start = turnStart
    if (start > 0) {
      // Reveal cached turns
      backfillTurns()
      // Prefetch if getting close to the edge
      if (start <= PREFETCH_BUFFER && hasMore && !historyLoading) {
        const now = Date.now()
        if (now >= prefetchUntilRef.current) {
          prefetchUntilRef.current = now + PREFETCH_COOLDOWN
          loadOlderMessages()
        }
      }
      return
    }
    // Already at top of cache, load from server
    if (hasMore && !historyLoading) {
      loadOlderMessages()
    }
  }, [turnStart, backfillTurns, hasMore, historyLoading, loadOlderMessages])

  // --- Load earlier (button click): reveal all cache + fetch ---
  const loadEarlierMessages = useCallback(async () => {
    // First reveal all cached messages
    if (turnStart > 0) setTurnStart(0)
    // Then fetch more from server
    if (hasMore && !historyLoading) {
      await loadOlderMessages()
    }
  }, [turnStart, hasMore, historyLoading, loadOlderMessages])

  // --- SSE event helpers ---
  const getEventSessionID = useCallback((event: SSEEvent): string | undefined => {
    const props = event.properties as Record<string, any>
    return props.sessionID || props.part?.sessionID || props.info?.sessionID || props.id
  }, [])

  // --- SSE handler (message + session events) ---
  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      const eventSessionID = getEventSessionID(event)
      if (eventSessionID && eventSessionID !== sessionId) return

      // Block message events from stopped or frozen interactions
      if (event.type.startsWith("message.")) {
        if (stoppedRef.current) return
        const p = event.properties as Record<string, any>
        const msgId: string | undefined = p.messageID || p.part?.messageID || p.info?.id
        if (msgId && frozenMessageIdsRef.current.has(msgId)) return
      }

      switch (event.type) {
        case "message.part.updated": {
          const { part } = event.properties
          if (!("messageID" in part)) break
          const messageID = (part as any).messageID as string
          setStreamingMessageId(messageID)
          if (part.type === "tool" && "state" in part && (part as any).state?.status === "completed") {
            setToolCompletionCount((c) => c + 1)
          }
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
            const tempMsg = prev.find((m) => m.info.id.startsWith("temp-"))
            const hasTemp = !!tempMsg
            const filtered = prev.filter((m) => !m.info.id.startsWith("temp-"))
            const inferredRole = hasTemp && part.type === "text" ? "user" as const : "assistant" as const
            return [
              ...filtered,
              {
                info: {
                  id: messageID,
                  sessionID: sessionId!,
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
              return [
                ...prev,
                {
                  info: {
                    id: messageID,
                    sessionID: sessionId!,
                    role: "assistant" as const,
                    time: { created: Date.now() },
                  },
                  parts: [{ type: "text", id: partID, sessionID: sessionId!, messageID, [field]: delta } as any],
                },
              ]
            }
          })
          break
        }

        case "message.updated": {
          const { info } = event.properties
          if (info.sessionID !== sessionId) break
          setStreamingMessageId(null)
          setMessages((prev) =>
            prev.map((m) =>
              m.info.id === info.id ? { ...m, info: { ...m.info, ...info } } : m
            )
          )
          if (info.role === "assistant" && info.finish) {
            setSending(false)
            // ACP sessions have no session.status idle event — clear the
            // sidebar activity marker on the terminal finish.
            if (isACP && info.finish !== "tool-calls") {
              sendingRef.current = false
              if (sessionId) markSessionIdle(sessionId)
            }
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

        // Legacy events
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
                  info: { id: messageID, sessionID: sessionId!, role: "assistant" as const, time: { created: Date.now() } },
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

        // Session events
        case "session.updated": {
          const props = event.properties
          const sid = props.sessionID || props.id
          const title = props.title
          if (sid && title) updateSession(sid, { title })
          break
        }

        case "session.error": {
          const { sessionID: errSid, error } = event.properties as { sessionID?: string; error?: { name?: string; data?: { message?: string } } }
          if ((!errSid || errSid === sessionId) && error) {
            const msg = error.data?.message || error.name || t("error.unknown")
            toast.error(msg)
          }
          break
        }

        case "server.instance.disposed": {
          // Instance.dispose() cancels all runners and disconnects SSE.
          // Reset sending state here because the subsequent session.status:idle
          // event may arrive after SSE has already disconnected.
          if (sendingRef.current && sessionId) {
            sendingRef.current = false
            setSending(false)
            setStreamingMessageId(null)
            markSessionIdle(sessionId)
          }
          break
        }

        case "session.status": {
          const { sessionID: statusSid, status } = event.properties as { sessionID: string; status: { type: string } }
          if (statusSid === sessionId && status.type === "idle") {
            sendingRef.current = false
            setSending(false)
            markSessionIdle(statusSid)
          }
          break
        }
      }
    },
    [sessionId, updateSession, markSessionIdle, getEventSessionID, isACP]
  )

  useSSESubscribe(handleSSEEvent)
  // ACP-bound sessions stream from the sidecar; events arrive already shaped
  // like opencode's and stamped with this session's id (no translation).
  useACPSSE(isACP ? sessionId : undefined, handleSSEEvent)

  // --- Cleanup: mark session idle on unmount/session change ---
  useEffect(() => {
    return () => {
      if (sessionId && sendingRef.current) {
        markSessionIdle(sessionId)
      }
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Actions ---
  const stopGeneration = useCallback(() => {
    setStopped(true)
    stoppedRef.current = true
    setStreamingMessageId(null)
    setSending(false)
    if (sessionId) markSessionIdle(sessionId)

    const currentMsgs = messagesRef.current
    if (currentMsgs.length === 0) return

    const lastMsg = currentMsgs[currentMsgs.length - 1]
    const frozenIds = new Set<string>()
    let stoppedId = lastMsg.info.id

    if (stoppedId.startsWith("temp-")) {
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

    if (sessionId) {
      if (isACP) {
        // ACP: session/cancel ends the turn (the agent keeps its own history;
        // there is no revert semantics).
        cancelACPSession(sessionId).catch(() => {
          setSending(false)
        })
        return
      }
      const lastUserMsg = [...currentMsgs].reverse().find(
        (m) => m.info.role === "user" && !m.info.id.startsWith("temp-")
      )
      api.abortSession(sessionId)
        .then(() => {
          if (lastUserMsg) {
            return api.revertSession(sessionId, lastUserMsg.info.id).catch(() => {})
          }
        })
        .catch(() => {
          setSending(false)
        })
    }
  }, [sessionId, api, markSessionIdle, isACP])

  const sendMessage = useCallback((
    text: string,
    model?: string | null,
  ) => {
    if (!sessionId || !text.trim() || sending || sendingRef.current) return
    sendingRef.current = true
    markSessionActive(sessionId)

    const wasStopped = stoppedRef.current
    const prevFrozenIds = wasStopped ? new Set(frozenMessageIdsRef.current) : null
    if (wasStopped) {
      setStopped(false)
      stoppedRef.current = false
      frozenMessageIdsRef.current = new Set()
    }

    const userMessage = text.trim()
    const tempId = `temp-${crypto.randomUUID()}`
    setSending(true)

    const tempUserMessage: SendMessageResponse = {
      info: {
        id: tempId,
        sessionID: sessionId,
        role: "user",
        time: { created: Date.now() },
      },
      parts: [{ type: "text", text: userMessage }],
    }
    setMessages((prev) => [...prev, tempUserMessage])

    const handleSendError = (err: unknown) => {
      console.error("Failed to send message:", err)
      if (idRef.current !== sessionId) return
      sendingRef.current = false
      setSending(false)
      markSessionIdle(sessionId)
      if (wasStopped) {
        setStopped(true)
        stoppedRef.current = true
        if (prevFrozenIds) frozenMessageIdsRef.current = prevFrozenIds
      }
      setMessages((prev) => prev.filter((m) => m.info.id !== tempId))
      toast.error(t("error.sendMessage"))
    }

    if (isACP) {
      // ACP route: lazily create the agent-side session bound to this desktop
      // session (cwd = session workspace), then prompt. Turn completion is
      // signaled by the shaped message.updated finish event over SSE.
      const directory = sessions.find((s) => s.id === sessionId)?.directory
      const { rawId: acpAgentId } = parseAgentId(boundAgentId)
      if (!directory) {
        handleSendError(new Error("Session has no workspace directory"))
        return
      }
      ensureACPSession(acpAgentId, directory, sessionId)
        .then(() => promptACPSession(sessionId, userMessage))
        .catch(handleSendError)
    } else {
      api.promptAsync(sessionId, userMessage, { model: model || undefined }).catch(handleSendError)
    }
  }, [sessionId, sending, api, markSessionActive, markSessionIdle, t, isACP, boundAgentId, sessions])

  return {
    messages: displayMessages,
    allMessages: messages,
    sending,
    loading,
    streamingMessageId,
    stopped,
    stoppedAtMessageId,
    toolCompletionCount,
    // History window
    turnStart,
    hasMore,
    historyLoading,
    // Actions
    sendMessage,
    stopGeneration,
    backfillTurns,
    loadEarlierMessages,
    onScrollNearTop,
  }
}
