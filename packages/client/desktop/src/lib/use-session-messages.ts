import { useRef, useEffect, useState, useCallback, useMemo } from "react"
import { toast } from "sonner"
import { useSessionsContext } from "@/lib/sessions-context"
import { useConnector, useSessionSubscribe } from "@/lib/sse-context"
import { useI18n } from "@/lib/i18n-context"
import { forgetLocallyPrompted, markLocallyPrompted } from "@/lib/notifications/notify-registry"
import type { SendMessageResponse } from "@agent/api-client"
import type { SSEEvent } from "@agent/connector"

// --- History window constants ---
const TURN_INIT = 15           // Initial turns to render on session load
const TURN_BATCH = 8           // Turns to reveal per backfill gesture
const INITIAL_PAGE_SIZE = 80   // First API request limit
const HISTORY_PAGE_SIZE = 200  // Older history API request limit
const PREFETCH_BUFFER = 16    // Start prefetching when turnStart <= this
const PREFETCH_COOLDOWN = 400  // ms between prefetch requests

// --- Cross-session-switch message cache (discussions/022 Issue 1) ---
// Switching sessions resets `messages` to [] (the [sessionId] effect below) and
// rebuilds from a fetchHistory snapshot + resumed SSE deltas. For opencode the
// persisted snapshot LAGS the live stream, and while a session is backgrounded no
// mounted hook folds its deltas, so the text that streamed during the switch is
// lost until the terminal full part.updated. Fix: the app-level GLOBAL listener
// (use-sessions) folds EVERY session's opencode message events into this cache via
// applyMessageEventToCache — even backgrounded ones — so the cache is always
// current. On switch-back the fetchHistory merge applies it as a TEXT-ONLY patch
// (never re-seeding the list — that would reorder paginated history and resurrect
// reverted turns). ACP is immune (history folded synchronously) so its events
// (per-session, not on the global stream) need no caching.
const MESSAGE_CACHE_LIMIT = 30
const messageCache = new Map<string, SendMessageResponse[]>()
function cacheMessages(sessionId: string, messages: SendMessageResponse[]): void {
  if (messageCache.has(sessionId)) messageCache.delete(sessionId) // refresh LRU order
  messageCache.set(sessionId, messages)
  if (messageCache.size > MESSAGE_CACHE_LIMIT) {
    const oldest = messageCache.keys().next().value
    if (oldest !== undefined) messageCache.delete(oldest)
  }
}
/** Test-only: clear the cross-switch cache so module-level state can't leak
 *  between cases (the cache is process-global within a test file). */
export function __resetMessageCache(): void {
  messageCache.clear()
}
/** Total streamed text length of a message — lets the switch-back merge prefer
 *  the richer version so a lagging snapshot can't shrink an in-flight message. */
function textLength(m: SendMessageResponse): number {
  return m.parts.reduce(
    (n, p) => n + (p && "text" in p && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text.length : 0),
    0,
  )
}

/**
 * Apply one opencode message event to the cross-switch cache for ANY session.
 * Driven by the app-level GLOBAL SSE listener (use-sessions), so a session's
 * stream keeps folding into its cache even while it is NOT the mounted session —
 * the only way switch-back can restore text that streamed WHILE you were away
 * (discussions/022 Issue 1). Mirrors the hook's reducer (part.updated upsert /
 * delta append / message.updated merge). ACP message events aren't on the global
 * stream, but ACP history is already current so its cache isn't needed.
 */
export function applyMessageEventToCache(event: SSEEvent): void {
  const props = event.properties as Record<string, any>
  const part = props.part
  const sid: string | undefined = part?.sessionID ?? props.sessionID ?? props.info?.sessionID
  // Only fold into sessions the user has actually VIEWED (registered on mount,
  // see the initial-load effect). The opencode global stream also carries task/
  // orchestrator CHILD sessions that are never switched back to — without this
  // guard they'd flood the bounded LRU and evict the leader/parent you do switch
  // back to, re-opening the gap (discussions/022 Issue 1, M1).
  if (!sid || !messageCache.has(sid)) return
  const prev = messageCache.get(sid)!

  if (event.type === "message.part.updated") {
    if (!part || !("messageID" in part)) return
    const idx = prev.findIndex((m) => m.info.id === part.messageID)
    if (idx >= 0) {
      const msg = { ...prev[idx] }
      const pIdx = msg.parts.findIndex((p) => "id" in p && (p as any).id === part.id)
      msg.parts = pIdx >= 0
        ? [...msg.parts.slice(0, pIdx), part, ...msg.parts.slice(pIdx + 1)]
        : [...msg.parts, part]
      cacheMessages(sid, [...prev.slice(0, idx), msg, ...prev.slice(idx + 1)])
    } else {
      cacheMessages(sid, [...prev, { info: { id: part.messageID, sessionID: sid, role: "assistant", time: { created: Date.now() } }, parts: [part] }])
    }
  } else if (event.type === "message.part.delta") {
    const { messageID, partID, field, delta } = props
    if (!messageID) return
    const idx = prev.findIndex((m) => m.info.id === messageID)
    if (idx >= 0) {
      const msg = { ...prev[idx] }
      const pIdx = msg.parts.findIndex((p) => "id" in p && (p as any).id === partID)
      if (pIdx < 0) return
      const existing = msg.parts[pIdx] as any
      msg.parts = [...msg.parts.slice(0, pIdx), { ...existing, [field]: (existing[field] || "") + delta }, ...msg.parts.slice(pIdx + 1)]
      cacheMessages(sid, [...prev.slice(0, idx), msg, ...prev.slice(idx + 1)])
    } else {
      cacheMessages(sid, [...prev, { info: { id: messageID, sessionID: sid, role: "assistant", time: { created: Date.now() } }, parts: [{ type: "text", id: partID, sessionID: sid, messageID, [field]: delta } as any] }])
    }
  } else if (event.type === "message.part.removed") {
    const { messageID, partID } = props
    if (!messageID) return
    // Mirror the removal so a later text-patch can't resurrect a deleted part (M2).
    cacheMessages(sid, prev.map((m) =>
      m.info.id === messageID ? { ...m, parts: m.parts.filter((p) => !("id" in p) || (p as any).id !== partID) } : m,
    ))
  } else if (event.type === "message.updated") {
    const info = props.info
    if (!info?.id) return
    cacheMessages(sid, prev.map((m) => (m.info.id === info.id ? { ...m, info: { ...m.info, ...info } } : m)))
  }
}

/** Register/forget a session in the cross-switch cache. The hook calls register
 *  on mount so the global listener folds only viewed sessions (M1); deleteSession
 *  forgets it (L1). */
export function registerMessageCacheSession(sessionId: string): void {
  if (!messageCache.has(sessionId)) messageCache.set(sessionId, [])
}
export function forgetMessageCacheSession(sessionId: string): void {
  messageCache.delete(sessionId)
}

interface UseSessionMessagesOptions {
  /** True when navigating from Home with an in-flight prompt */
  initialSending?: boolean
  /** Pre-fill user message text for optimistic UI */
  initialMessageText?: string
  /**
   * Workspace directory for sessions that are NOT in SessionsContext (Team
   * Leader sessions hang off a hidden parent and never enter the sidebar
   * list). Falls back to the context lookup when unset.
   */
  directory?: string
  /**
   * Per-turn prompt extras. The Team page sends the Leader's orchestration
   * instructions + the built-in-task deny here ({ system, tools }); normal
   * sessions leave it unset and get the connector's default orchestrator_*
   * deny (017 拍板 #4).
   */
  promptOptions?: { system?: string; tools?: Record<string, boolean> }
}

export function useSessionMessages(
  sessionId: string | undefined,
  options?: UseSessionMessagesOptions,
) {
  const { sessions, activeSessionIds, updateSession, markSessionActive, markSessionIdle } = useSessionsContext()
  const connector = useConnector()
  const { t } = useI18n()

  // Backend behavior differences are capability-declared (ADR-030 D-5);
  // the connector dispatches every call by the session's agent binding.
  const capabilities = connector.capabilitiesOf(sessionId)

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
  // App-level busy truth, read synchronously in sendMessage's concurrency guard
  // (a switched-back session has sending/sendingRef reset but may still be busy).
  const activeIdsRef = useRef(activeSessionIds)
  activeIdsRef.current = activeSessionIds
  const prefetchUntilRef = useRef(0)
  // Home→Session optimistic-send safety timer. Fires once if the navigated send
  // never produces a turn; MUST be cancelled the moment real SSE activity proves
  // the turn is live, otherwise it force-clears `sending` mid-turn at 8s and any
  // turn longer than that flips to a false "completed" state (collapsed flow +
  // footer) during model-thinking gaps.
  const navSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    // Reset to empty (NOT seeded from the cross-switch cache): seeding the full
    // cached list would break the paginated merge below — older-than-page cached
    // messages fall into `sseOnly` and reorder, and reverted turns get
    // resurrected. The cache is instead applied as a TEXT-ONLY patch in the
    // fetchHistory merge, which can't change membership/order (discussions/022
    // Issue 1, F1/F2).
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

    // 8-second safety timeout for Home→Session navigation. Only a fallback for
    // "the optimistic send never produced a turn" — cancelled by the SSE handler
    // on the first real activity (see navSafetyTimerRef). Without that cancel it
    // would fire mid-turn and cause the false-complete described above.
    if (isSendingFromNav && sessionId) {
      const sid = sessionId
      const timer = setTimeout(() => {
        if (sendingRef.current && !stoppedRef.current) {
          sendingRef.current = false
          setSending(false)
          markSessionIdle(sid)
        }
      }, 8000)
      navSafetyTimerRef.current = timer
      return () => { clearTimeout(timer); navSafetyTimerRef.current = null }
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Initial message load (paginated) ---
  useEffect(() => {
    let cancelled = false
    if (!sessionId) {
      setLoading(false)
      return
    }
    // Register so the global listener folds THIS session's stream into the cache
    // (even while backgrounded) — bounding the cache to viewed sessions (M1).
    registerMessageCacheSession(sessionId)
    setLoading(true)
    // Dispatched by binding: opencode pages by cursor; the ACP sidecar serves
    // the whole shaped history (the turn window below limits what renders).
    connector.fetchHistory(sessionId, { limit: INITIAL_PAGE_SIZE })
      .then((result) => {
        if (!cancelled) {
          const msgs = result.messages
          // Only consult the cache while the turn is in flight (busy). Idle
          // sessions trust the snapshot fully, so a revert can't be undone and
          // paginated history can't be reordered.
          const cached = sessionId && activeIdsRef.current.has(sessionId)
            ? messageCache.get(sessionId)
            : undefined
          setMessages(prev => {
            let base: SendMessageResponse[]
            if (prev.length === 0) base = msgs
            else if (msgs.length === 0) base = prev
            else {
              const serverIds = new Set(msgs.map(m => m.info.id))
              const sseOnly = prev.filter(m =>
                !m.info.id.startsWith("temp-") && !serverIds.has(m.info.id)
              )
              base = [...msgs, ...sseOnly]
            }
            if (!cached) return base
            // TEXT patch (discussions/022 Issue 1): opencode's persisted snapshot
            // lags the live stream, but the app-level cache (kept current for
            // viewed sessions, even backgrounded) has the full streamed text. For
            // messages ALREADY in `base` (never add/reorder → reverted/paginated
            // turns unaffected, F1/F2), MERGE BY PART id: upgrade each base part to
            // the cache's richer-text version, keep base parts the cache lacks
            // (don't drop tool/structure parts, M2), append cache-only parts
            // (streamed-but-not-yet-persisted). Base info (finish/tokens) is kept.
            const cacheById = new Map(cached.map(m => [m.info.id, m]))
            const partTextLen = (p: any): number =>
              p && "text" in p && typeof p.text === "string" ? p.text.length : 0
            return base.map(m => {
              const cm = cacheById.get(m.info.id)
              if (!cm || textLength(cm) <= textLength(m)) return m
              const cParts = new Map(cm.parts.filter(p => "id" in p).map(p => [(p as any).id, p]))
              const baseIds = new Set(m.parts.filter(p => "id" in p).map(p => (p as any).id))
              const merged = m.parts.map(bp => {
                const cp = "id" in bp ? cParts.get((bp as any).id) : undefined
                return cp && partTextLen(cp) > partTextLen(bp) ? cp : bp
              })
              const extra = cm.parts.filter(p => "id" in p && !baseIds.has((p as any).id))
              return { ...m, parts: [...merged, ...extra] }
            })
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
  }, [sessionId, connector]) // eslint-disable-line react-hooks/exhaustive-deps

  // (The cross-switch cache is maintained app-level by the global SSE listener in
  // use-sessions via applyMessageEventToCache — for ALL sessions, including
  // backgrounded ones — so it stays current and switch-back loses no streamed
  // text. The mounted hook only READS it in the fetchHistory patch above.)

  // --- History loading: fetch older messages ---
  const loadOlderMessages = useCallback(async () => {
    if (!sessionId || !hasMore || historyLoading || !cursor) return
    setHistoryLoading(true)
    try {
      const result = await connector.fetchHistory(sessionId, {
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
  }, [sessionId, hasMore, historyLoading, cursor, connector])

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
        // Real turn activity → the optimistic send produced a turn; cancel the
        // Home→Session safety timer so it can't force-clear `sending` mid-turn.
        if (navSafetyTimerRef.current) {
          clearTimeout(navSafetyTimerRef.current)
          navSafetyTimerRef.current = null
        }
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
          // A "tool-calls" finish ends only the current STEP, not the turn —
          // opencode's tool-calling loop continues with another assistant
          // message. Clearing `sending` here would drop sessionActive between
          // steps, making the turn briefly render as done (green check +
          // collapsed flow + footer) during the gap before the next step
          // streams. Only a terminal finish (stop/length/…) ends the turn.
          if (info.role === "assistant" && info.finish && info.finish !== "tool-calls") {
            setSending(false)
            // Backends without session.status events (ACP) signal idle via
            // the terminal finish — clear the sidebar activity marker here.
            if (!capabilities.sessionStatus) {
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
    [sessionId, updateSession, markSessionIdle, getEventSessionID, capabilities.sessionStatus]
  )

  // Dispatched by binding: opencode filters the global stream; ACP merges the
  // sidecar's shaped per-session stream with the global stream (titles).
  useSessionSubscribe(sessionId, handleSSEEvent)

  // --- Cleanup: mark session idle on unmount/session change ---
  // Only for backends WITHOUT a global lifecycle stream: they have no app-level
  // idle signal, so a locally-tracked `sending` would leak the busy marker forever
  // once you leave. Both opencode (session.status) and ACP (the sidecar's global
  // /acp/global/events, discussions/022 §8) now maintain activeSessionIds at the
  // app level, so switching away from a STILL-running turn must NOT mark it idle
  // here — that would drop the marker that lets switch-back re-derive
  // sessionActive, reintroducing the false-complete. Gated on globalEvents (not
  // sessionStatus) so ACP is covered too; kept as a fallback for any future
  // backend without a global stream.
  useEffect(() => {
    return () => {
      if (sessionId && sendingRef.current && !capabilities.globalEvents) {
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
      // The user pressed Stop: the idle that follows is the one thing they already
      // know about. Announcing it would be telling them what they just did.
      forgetLocallyPrompted(sessionId)
      const lastUserMsg = [...currentMsgs].reverse().find(
        (m) => m.info.role === "user" && !m.info.id.startsWith("temp-")
      )
      connector.cancel(sessionId)
        .then(() => {
          // Backends without revert (ACP) just end the turn — the agent
          // keeps its own history.
          if (lastUserMsg && connector.capabilitiesOf(sessionId).revert) {
            return connector.revert(sessionId, lastUserMsg.info.id).catch(() => {})
          }
        })
        .catch(() => {
          setSending(false)
        })
    }
  }, [sessionId, connector, markSessionIdle])

  const sendMessage = useCallback((
    text: string,
    model?: string | null,
  ) => {
    // The last clause guards switch-back: a session still running in the
    // background has sending/sendingRef reset by remount, so without the
    // app-level busy check a second prompt could slip past the UI's disabled
    // state and collide with the in-flight turn (discussions/022).
    if (!sessionId || !text.trim() || sending || sendingRef.current || activeIdsRef.current.has(sessionId)) return
    sendingRef.current = true
    markSessionActive(sessionId)
    // The desktop user started this turn ⇒ they are owed a notification when it ends.
    // The turns we do NOT register (IM channel messages, delegate children) are exactly
    // the ones that must stay silent — discussions/036 §2.3.
    markLocallyPrompted(sessionId)

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
      // The composer already told them (toast below) and they are clearly at the
      // keyboard — don't also chime at them.
      forgetLocallyPrompted(sessionId)
      if (wasStopped) {
        setStopped(true)
        stoppedRef.current = true
        if (prevFrozenIds) frozenMessageIdsRef.current = prevFrozenIds
      }
      setMessages((prev) => prev.filter((m) => m.info.id !== tempId))
      toast.error(t("error.sendMessage"))
    }

    // Dispatched by binding. ACP backends lazily ensure the agent-side
    // session (cwd = session workspace) before prompting; turn completion is
    // signaled by the shaped message.updated finish event over SSE.
    const opts = optionsRef.current
    const directory = opts?.directory ?? sessions.find((s) => s.id === sessionId)?.directory
    connector
      .prompt(sessionId, userMessage, {
        model: model || undefined,
        directory,
        system: opts?.promptOptions?.system,
        tools: opts?.promptOptions?.tools,
      })
      .catch(handleSendError)
  }, [sessionId, sending, connector, markSessionActive, markSessionIdle, t, sessions])

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
