import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { SSEEvent } from "@agent/connector"

// --- Mocks ---------------------------------------------------------------

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), message: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

const markSessionIdle = vi.fn()
const markSessionActive = vi.fn()
let mockActiveIds = new Set<string>()
vi.mock("@/lib/sessions-context", () => ({
  useSessionsContext: () => ({
    sessions: [],
    activeSessionIds: mockActiveIds,
    updateSession: vi.fn(),
    markSessionActive,
    markSessionIdle,
  }),
}))

// capabilitiesOf is swapped per test (sessionStatus drives terminal-finish idle;
// globalEvents drives the switch-away cleanup gate — both opencode and ACP have a
// global lifecycle stream now, discussions/022 §8).
let sessionStatusCap = true
let globalEventsCap = true
const connector = {
  capabilitiesOf: () => ({ sessionStatus: sessionStatusCap, globalEvents: globalEventsCap, revert: true }),
  fetchHistory: vi.fn().mockResolvedValue({ messages: [], cursor: undefined, hasMore: false }),
  cancel: vi.fn().mockResolvedValue(undefined),
  revert: vi.fn().mockResolvedValue(undefined),
  prompt: vi.fn().mockResolvedValue(undefined),
}

// Capture the SSE handler the hook subscribes with so the test can drive it.
let capturedHandler: ((e: SSEEvent) => void) | null = null
vi.mock("@/lib/sse-context", () => ({
  useConnector: () => connector,
  useSessionSubscribe: (_sid: string | undefined, handler: (e: SSEEvent) => void) => {
    capturedHandler = handler
  },
  // No reconnect in this suite: the hook only re-derives `sending` after a recovery.
  useSSEReconnectEpoch: () => 0,
}))

import { useSessionMessages, __resetMessageCache, applyMessageEventToCache, registerMessageCacheSession } from "@/lib/use-session-messages"

function assistantFinish(finish: string): SSEEvent {
  return {
    type: "message.updated",
    properties: {
      info: { id: "m1", sessionID: "s1", role: "assistant", finish },
    },
  } as unknown as SSEEvent
}

beforeEach(() => {
  sessionStatusCap = true
  globalEventsCap = true
  mockActiveIds = new Set()
  __resetMessageCache()
  capturedHandler = null
  markSessionIdle.mockReset()
  markSessionActive.mockReset()
  connector.fetchHistory.mockClear()
  connector.prompt.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useSessionMessages — sending lifecycle across tool-call steps", () => {
  it("keeps `sending` true on an intermediate 'tool-calls' finish (step boundary, not turn end)", async () => {
    const { result } = renderHook(() =>
      useSessionMessages("s1", { initialSending: true }),
    )
    // Starts active (navigated from Home with an in-flight prompt).
    await waitFor(() => expect(result.current.sending).toBe(true))

    // A step finishes with finish:"tool-calls" — the loop continues. This must
    // NOT flip the turn to "done" (regression: false-complete flicker between
    // steps where green check + footer briefly appear).
    act(() => capturedHandler!(assistantFinish("tool-calls")))
    expect(result.current.sending).toBe(true)
  })

  it("clears `sending` on a terminal finish (turn end)", async () => {
    const { result } = renderHook(() =>
      useSessionMessages("s1", { initialSending: true }),
    )
    await waitFor(() => expect(result.current.sending).toBe(true))

    act(() => capturedHandler!(assistantFinish("stop")))
    expect(result.current.sending).toBe(false)
  })

  it("ACP (no session.status): terminal finish marks idle, 'tool-calls' does not", async () => {
    sessionStatusCap = false // ACP signals idle via terminal finish, not session.status
    const { result } = renderHook(() =>
      useSessionMessages("s1", { initialSending: true }),
    )
    await waitFor(() => expect(result.current.sending).toBe(true))

    act(() => capturedHandler!(assistantFinish("tool-calls")))
    expect(markSessionIdle).not.toHaveBeenCalled()
    expect(result.current.sending).toBe(true)

    act(() => capturedHandler!(assistantFinish("stop")))
    expect(markSessionIdle).toHaveBeenCalledWith("s1")
    expect(result.current.sending).toBe(false)
  })
})

describe("useSessionMessages — switch-away cleanup (discussions/022)", () => {
  it("backend with a global lifecycle stream (opencode/ACP): switching away from a still-running turn does NOT mark it idle", async () => {
    globalEventsCap = true // app-level busy truth (session.status / global stream) is authoritative
    const { result, unmount } = renderHook(() =>
      useSessionMessages("s1", { initialSending: true }),
    )
    await waitFor(() => expect(result.current.sending).toBe(true))

    // Leaving the session must NOT drop the busy marker — otherwise switch-back
    // can't re-derive sessionActive and the in-flight turn false-completes.
    unmount()
    expect(markSessionIdle).not.toHaveBeenCalled()
  })

  it("backend WITHOUT a global stream (fallback): switching away while sending marks idle", async () => {
    globalEventsCap = false // no app-level idle signal → local heuristic prevents a leaked busy marker
    const { result, unmount } = renderHook(() =>
      useSessionMessages("s1", { initialSending: true }),
    )
    await waitFor(() => expect(result.current.sending).toBe(true))

    unmount()
    expect(markSessionIdle).toHaveBeenCalledWith("s1")
  })
})

describe("useSessionMessages — sendMessage concurrency guard vs app-level busy (discussions/022 M3)", () => {
  it("does NOT send when the session is already busy app-level (switched back mid-turn)", async () => {
    mockActiveIds = new Set(["s1"]) // a turn is still running in the background
    const { result } = renderHook(() => useSessionMessages("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.sendMessage("second prompt"))
    expect(connector.prompt).not.toHaveBeenCalled()
  })

  it("sends normally when the session is idle", async () => {
    mockActiveIds = new Set() // idle session
    const { result } = renderHook(() => useSessionMessages("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.sendMessage("hello"))
    expect(connector.prompt).toHaveBeenCalledTimes(1)
  })
})

describe("useSessionMessages — switch-back preserves streamed text (discussions/022 Issue 1)", () => {
  // The app-level global listener (use-sessions) folds events into the cache via
  // applyMessageEventToCache for ALL sessions. These helpers carry sessionID so
  // they drive that reducer directly (simulating the global listener).
  const partFor = (mid: string, pid: string, text: string): SSEEvent =>
    ({ type: "message.part.updated", properties: { part: { type: "text", id: pid, messageID: mid, sessionID: "s1", text } } }) as unknown as SSEEvent
  const partUpdated = (text: string): SSEEvent => partFor("m1", "p1", text)
  const delta = (d: string): SSEEvent =>
    ({ type: "message.part.delta", properties: { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: d } }) as unknown as SSEEvent
  const snapshot = (text: string) => ({
    messages: [{ info: { id: "m1", sessionID: "s1", role: "assistant" }, parts: [{ type: "text", id: "p1", text }] }],
    cursor: undefined,
    hasMore: false,
  })
  const answerText = (msgs: ReturnType<typeof useSessionMessages>["messages"]): string => {
    const m = msgs.find((x) => x.info.id === "m1")
    return m ? m.parts.map((p) => ("text" in p ? (p as { text: string }).text : "")).join("") : ""
  }
  // The global listener only folds VIEWED sessions; register s1 first (the hook
  // does this on mount in production).
  beforeEach(() => registerMessageCacheSession("s1"))

  it("a lagging snapshot on switch-back does NOT shrink text the cache already has (no gap)", async () => {
    mockActiveIds = new Set(["s1"]) // turn in flight (busy)
    // Global listener folded the full streamed text into the cache.
    applyMessageEventToCache(partUpdated("ABC"))
    applyMessageEventToCache(delta("DEF")) // cache m1 = "ABCDEF"

    // Switch back: fetchHistory returns a LAGGING snapshot (only "ABC").
    connector.fetchHistory.mockResolvedValueOnce(snapshot("ABC"))
    const { result } = renderHook(() => useSessionMessages("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(answerText(result.current.messages)).toBe("ABCDEF") // pre-fix: "ABC"
    // A resumed delta continues from the full text — no missing middle.
    act(() => capturedHandler!(delta("GHI")))
    expect(answerText(result.current.messages)).toBe("ABCDEFGHI")
  })

  it("captures text that streamed WHILE the session was backgrounded (no away-period gap)", async () => {
    mockActiveIds = new Set(["s1"])
    // Viewing s1: streamed "ABC". Then the user switches AWAY — no s1 hook is
    // mounted, but the global listener keeps folding s1's deltas into the cache.
    applyMessageEventToCache(partUpdated("ABC"))
    applyMessageEventToCache(delta("DEF"))
    applyMessageEventToCache(delta("GHI")) // cache m1 = "ABCDEFGHI" (away-period text)

    // Switch BACK while the persisted snapshot still lags badly (only "AB").
    connector.fetchHistory.mockResolvedValueOnce(snapshot("AB"))
    const { result } = renderHook(() => useSessionMessages("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // The away-period text ("DEFGHI") is present — the whole point of the fix.
    expect(answerText(result.current.messages)).toBe("ABCDEFGHI")
  })

  it("does NOT resurrect or reorder a cached message the snapshot dropped (revert/pagination — F1/F2)", async () => {
    mockActiveIds = new Set(["s1"]) // even busy: membership comes from the snapshot, not the cache
    applyMessageEventToCache(partFor("m_old", "po", "old turn"))
    applyMessageEventToCache(partFor("m1", "p1", "new"))

    // Snapshot dropped m_old (reverted, or paged out of the first page).
    connector.fetchHistory.mockResolvedValueOnce(snapshot("new"))
    const { result } = renderHook(() => useSessionMessages("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.messages.map((m) => m.info.id)).toEqual(["m1"]) // no m_old, no reorder
  })

  it("text patch keeps a base tool part the cache is missing (SSE-reconnect drop — M2)", async () => {
    mockActiveIds = new Set(["s1"])
    // Cache has only the (longer) text part — it missed the tool part.
    applyMessageEventToCache(partUpdated("ABCDEF"))
    // Snapshot has BOTH a tool part and the (lagging) text part.
    connector.fetchHistory.mockResolvedValueOnce({
      messages: [{
        info: { id: "m1", sessionID: "s1", role: "assistant" },
        parts: [
          { type: "tool", id: "t1", tool: "read", state: { status: "completed" } },
          { type: "text", id: "p1", text: "ABC" },
        ],
      }],
      cursor: undefined,
      hasMore: false,
    })
    const { result } = renderHook(() => useSessionMessages("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const m1 = result.current.messages.find((m) => m.info.id === "m1")!
    // Tool part survives (not dropped) AND the text is upgraded from the cache.
    expect(m1.parts.map((p) => (p as any).type)).toEqual(["tool", "text"])
    expect(answerText(result.current.messages)).toBe("ABCDEF")
  })

  it("idle session trusts the snapshot (cache patch is busy-gated)", async () => {
    mockActiveIds = new Set() // idle
    applyMessageEventToCache(partUpdated("ABCDEF")) // stale/longer cache
    connector.fetchHistory.mockResolvedValueOnce(snapshot("AB")) // snapshot authoritative when idle
    const { result } = renderHook(() => useSessionMessages("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(answerText(result.current.messages)).toBe("AB")
  })
})

function activity(): SSEEvent {
  return {
    type: "message.part.updated",
    properties: { part: { messageID: "m1", sessionID: "s1", type: "text", text: "hi" } },
  } as unknown as SSEEvent
}

describe("useSessionMessages — Home→Session 8s safety timer", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("force-clears `sending` after 8s ONLY when the send never produced a turn (no activity)", () => {
    const { result } = renderHook(() => useSessionMessages("s1", { initialSending: true }))
    expect(result.current.sending).toBe(true)
    act(() => { vi.advanceTimersByTime(8000) })
    expect(result.current.sending).toBe(false) // safety fired — turn never started
  })

  it("does NOT clear `sending` at 8s once real SSE activity proves the turn is live", () => {
    const { result } = renderHook(() => useSessionMessages("s1", { initialSending: true }))
    expect(result.current.sending).toBe(true)

    // A real turn started (part streamed) → safety timer must be cancelled, so a
    // long turn (>8s) is NOT flipped to a false "completed" state mid-flight.
    act(() => capturedHandler!(activity()))
    act(() => { vi.advanceTimersByTime(20000) })
    expect(result.current.sending).toBe(true)
  })
})

describe("useSessionMessages — stopping when the backend refuses", () => {
  beforeEach(() => {
    toast.error.mockClear()
    connector.cancel.mockReset().mockResolvedValue(undefined)
    connector.revert.mockReset().mockResolvedValue(undefined)
  })

  it("a successful stop stays quiet and keeps the turn frozen", async () => {
    const { result } = renderHook(() => useSessionMessages("s1", { initialSending: true }))
    act(() => capturedHandler!(activity()))

    act(() => result.current.stopGeneration())

    await waitFor(() => expect(connector.cancel).toHaveBeenCalledWith("s1"))
    expect(result.current.stopped).toBe(true)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("tells the user when the stop FAILED, instead of pretending it worked", async () => {
    // The agent is still running and still spending tokens. Freezing the view
    // locally while saying nothing is the one outcome the user cannot act on.
    connector.cancel.mockRejectedValue(new Error("backend unreachable"))
    const { result } = renderHook(() => useSessionMessages("s1", { initialSending: true }))
    act(() => capturedHandler!(activity()))

    act(() => result.current.stopGeneration())

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("error.stopGeneration"))
  })

  it("un-freezes the view after a failed stop, so later output is still visible", async () => {
    // `stopped` gates EVERY later message event. Leaving it set after a failed
    // cancel would hide everything the still-running agent goes on to produce.
    connector.cancel.mockRejectedValue(new Error("backend unreachable"))
    const { result } = renderHook(() => useSessionMessages("s1", { initialSending: true }))
    act(() => capturedHandler!(activity()))

    act(() => result.current.stopGeneration())
    await waitFor(() => expect(result.current.stopped).toBe(false))

    // Proof it is not merely a flag: a later part actually lands in the list.
    act(() => capturedHandler!(activity()))
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0))
  })
})
