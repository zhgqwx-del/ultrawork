// F1b — the stream gap that spans the end of a turn (docs/discussions/058).
//
// The opencode event stream has no replay. Text that streams while the socket is
// down is gone; while the turn is still running the events that follow carry the
// full part text back, so an in-turn outage self-heals (measured: 8s and 20s lose
// nothing). An outage that spans the END of the turn does not — nothing more is
// ever emitted, so the message stays frozen mid-word forever (measured: 293 of
// 300 markers lost). This suite pins the repair: on a reconnect, an IDLE session
// re-fetches the server snapshot and MERGES it in place.
//
// "In place" is the whole risk surface, so it gets its own assertions: the merge
// must not re-seed (that would reset the paginated window and reorder history) and
// must not drop messages the snapshot lacks (that would undo a revert).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { SendMessageResponse } from "@agent/api-client"
import type { SSEEvent } from "@agent/connector"

// --- Mocks ---------------------------------------------------------------

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), message: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

let mockActiveIds = new Set<string>()
vi.mock("@/lib/sessions-context", () => ({
  useSessionsContext: () => ({
    sessions: [],
    activeSessionIds: mockActiveIds,
    updateSession: vi.fn(),
    markSessionActive: vi.fn(),
    markSessionIdle: vi.fn(),
  }),
}))

const connector = {
  capabilitiesOf: () => ({ sessionStatus: true, globalEvents: true, revert: true }),
  fetchHistory: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined),
  revert: vi.fn().mockResolvedValue(undefined),
  prompt: vi.fn().mockResolvedValue(undefined),
}

let capturedHandler: ((e: SSEEvent) => void) | null = null
let mockEpoch = 0
vi.mock("@/lib/sse-context", () => ({
  useConnector: () => connector,
  useSessionSubscribe: (_sid: string | undefined, handler: (e: SSEEvent) => void) => {
    capturedHandler = handler
  },
  useSSEReconnectEpoch: () => mockEpoch,
}))

import { useSessionMessages, mergeSnapshotInPlace, __resetMessageCache } from "@/lib/use-session-messages"

// --- Fixtures ------------------------------------------------------------

function msg(
  id: string,
  role: "user" | "assistant",
  parts: { id: string; text: string }[],
  extra: Record<string, unknown> = {},
): SendMessageResponse {
  return {
    info: { id, sessionID: "s1", role, time: { created: 1 }, ...extra } as any,
    parts: parts.map((p) => ({ type: "text", id: p.id, text: p.text }) as any),
  }
}
/** A part the snapshot never carries — tool/structure parts must survive a merge. */
function withTool(m: SendMessageResponse, toolId: string): SendMessageResponse {
  return { ...m, parts: [...m.parts, { type: "tool", id: toolId, state: { status: "completed" } } as any] }
}

const TRUNCATED = "M1 M2 M3"
const FULL = "M1 M2 M3 M4 M5 M6 M7 M8 M9"

beforeEach(() => {
  mockActiveIds = new Set()
  mockEpoch = 0
  capturedHandler = null
  __resetMessageCache()
  connector.fetchHistory.mockReset()
  toast.error.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// =========================================================================
// The merge itself — the part that must not re-seed.
// =========================================================================
describe("mergeSnapshotInPlace", () => {
  it("upgrades a message truncated by the gap, in place", () => {
    const prev = [msg("u1", "user", [{ id: "pu", text: "hi" }]), msg("a1", "assistant", [{ id: "p1", text: TRUNCATED }])]
    const snap = [msg("u1", "user", [{ id: "pu", text: "hi" }]), msg("a1", "assistant", [{ id: "p1", text: FULL }])]
    const out = mergeSnapshotInPlace(prev, snap)
    expect(out.map((m) => m.info.id)).toEqual(["u1", "a1"])
    expect((out[1].parts[0] as any).text).toBe(FULL)
  })

  it("keeps parts the snapshot lacks and appends parts only the snapshot has", () => {
    const prev = [withTool(msg("a1", "assistant", [{ id: "p1", text: TRUNCATED }]), "t1")]
    const snap = [
      {
        ...msg("a1", "assistant", [{ id: "p1", text: FULL }]),
        parts: [
          { type: "text", id: "p1", text: FULL },
          { type: "text", id: "p2", text: " tail born during the gap" },
        ] as any,
      },
    ]
    const out = mergeSnapshotInPlace(prev, snap)
    const ids = out[0].parts.map((p: any) => p.id)
    expect(ids).toEqual(["p1", "t1", "p2"]) // upgraded, tool kept, snapshot-only appended
  })

  it("NEVER drops a message the snapshot lacks (a reverted turn stays reverted-out, an SSE-only message stays)", () => {
    // `sseOnly` exists locally but not in the snapshot; removing it here is what a
    // re-seed would do, and it is the failure the initial-load merge warns about.
    const prev = [msg("a1", "assistant", [{ id: "p1", text: TRUNCATED }]), msg("sseOnly", "assistant", [{ id: "p9", text: "X" }])]
    const snap = [msg("a1", "assistant", [{ id: "p1", text: FULL }])]
    const out = mergeSnapshotInPlace(prev, snap)
    expect(out.map((m) => m.info.id)).toEqual(["a1", "sseOnly"])
  })

  it("does NOT prepend snapshot messages older than everything on screen (paginated window is not reordered)", () => {
    // The user has scrolled back, so `prev` starts at o1 — but the snapshot is the
    // latest page and starts at a2. Nothing before the first known id may be added.
    const prev = [msg("o1", "user", [{ id: "po", text: "old" }]), msg("a2", "assistant", [{ id: "p2", text: TRUNCATED }])]
    const snap = [
      msg("older-unseen", "user", [{ id: "pz", text: "not requested" }]),
      msg("a2", "assistant", [{ id: "p2", text: FULL }]),
    ]
    const out = mergeSnapshotInPlace(prev, snap)
    expect(out.map((m) => m.info.id)).toEqual(["o1", "a2"])
    expect((out[1].parts[0] as any).text).toBe(FULL)
  })

  it("inserts a snapshot-only message directly after its anchor, in server order", () => {
    const prev = [msg("u1", "user", [{ id: "pu", text: "hi" }]), msg("tail", "assistant", [{ id: "pt", text: "T" }])]
    const snap = [
      msg("u1", "user", [{ id: "pu", text: "hi" }]),
      msg("new1", "assistant", [{ id: "pn1", text: "N1" }]),
      msg("new2", "assistant", [{ id: "pn2", text: "N2" }]),
      msg("tail", "assistant", [{ id: "pt", text: "T" }]),
    ]
    const out = mergeSnapshotInPlace(prev, snap)
    expect(out.map((m) => m.info.id)).toEqual(["u1", "new1", "new2", "tail"])
  })

  it("refreshes info (finish/tokens) — the fields a gap over the turn end swallows", () => {
    const prev = [msg("a1", "assistant", [{ id: "p1", text: FULL }])]
    const snap = [msg("a1", "assistant", [{ id: "p1", text: FULL }], { finish: "stop", tokens: { output: 42 } })]
    const out = mergeSnapshotInPlace(prev, snap)
    expect((out[0].info as any).finish).toBe("stop")
  })

  it("returns `prev` BY REFERENCE when the snapshot adds nothing (a no-op resync can't scroll-jump the list)", () => {
    const prev = [msg("u1", "user", [{ id: "pu", text: "hi" }]), msg("a1", "assistant", [{ id: "p1", text: FULL }])]
    const snap = [msg("u1", "user", [{ id: "pu", text: "hi" }]), msg("a1", "assistant", [{ id: "p1", text: FULL }])]
    expect(mergeSnapshotInPlace(prev, snap)).toBe(prev)
  })

  it("keeps untouched messages by reference so only the repaired one re-renders", () => {
    const untouched = msg("u1", "user", [{ id: "pu", text: "hi" }])
    const prev = [untouched, msg("a1", "assistant", [{ id: "p1", text: TRUNCATED }])]
    const snap = [msg("u1", "user", [{ id: "pu", text: "hi" }]), msg("a1", "assistant", [{ id: "p1", text: FULL }])]
    const out = mergeSnapshotInPlace(prev, snap)
    expect(out[0]).toBe(untouched)
    expect(out[1]).not.toBe(prev[1])
  })

  it("an empty snapshot changes nothing; an empty list takes the snapshot (failed initial load)", () => {
    const prev = [msg("a1", "assistant", [{ id: "p1", text: FULL }])]
    expect(mergeSnapshotInPlace(prev, [])).toBe(prev)
    const snap = [msg("a1", "assistant", [{ id: "p1", text: FULL }])]
    expect(mergeSnapshotInPlace([], snap)).toBe(snap)
  })
})

// =========================================================================
// The hook — when the resync is allowed to run.
// =========================================================================
describe("useSessionMessages — reconnect resync gating", () => {
  /** Initial load: an assistant answer truncated where the socket died, plus a
   *  paginated window the resync must not disturb (hasMore/cursor set). */
  function mountWithTruncated() {
    connector.fetchHistory.mockResolvedValue({
      messages: [msg("u1", "user", [{ id: "pu", text: "go" }]), msg("a1", "assistant", [{ id: "p1", text: TRUNCATED }])],
      cursor: "cursor-1",
      hasMore: true,
    })
    return renderHook(() => useSessionMessages("s1"))
  }
  /** What the server actually has once the turn finished off-stream. */
  function serverHasFullAnswer() {
    connector.fetchHistory.mockResolvedValue({
      messages: [msg("u1", "user", [{ id: "pu", text: "go" }]), msg("a1", "assistant", [{ id: "p1", text: FULL }], { finish: "stop" })],
      // Deliberately DIFFERENT from the initial page: if the hook re-seeded, these
      // would overwrite the window the user is looking at.
      cursor: undefined,
      hasMore: false,
    })
  }
  const answerOf = (r: { current: ReturnType<typeof useSessionMessages> }) =>
    (r.current.messages.find((m) => m.info.id === "a1")?.parts[0] as any)?.text

  it("repairs the truncated answer when the stream recovers on an IDLE session", async () => {
    const { result, rerender } = mountWithTruncated()
    await waitFor(() => expect(answerOf(result)).toBe(TRUNCATED))

    serverHasFullAnswer()
    mockEpoch = 1
    await act(async () => { rerender() })

    await waitFor(() => expect(answerOf(result)).toBe(FULL))
    expect(connector.fetchHistory).toHaveBeenCalledTimes(2)
  })

  it("does NOT reset the paginated window while repairing (merge, not re-seed)", async () => {
    const { result, rerender } = mountWithTruncated()
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    serverHasFullAnswer()
    mockEpoch = 1
    await act(async () => { rerender() })
    await waitFor(() => expect(answerOf(result)).toBe(FULL))

    // The resync page said hasMore:false — a re-seed would have taken it and
    // silently removed the user's way back to older history.
    expect(result.current.hasMore).toBe(true)
  })

  it("does NOT resync while the turn is still in flight (an in-turn gap self-heals from the stream)", async () => {
    const { result, rerender } = mountWithTruncated()
    await waitFor(() => expect(answerOf(result)).toBe(TRUNCATED))

    mockActiveIds = new Set(["s1"])
    serverHasFullAnswer()
    mockEpoch = 1
    await act(async () => { rerender() })
    await act(async () => { await Promise.resolve() })

    expect(connector.fetchHistory).toHaveBeenCalledTimes(1)
    expect(answerOf(result)).toBe(TRUNCATED)
  })

  it("resyncs once the busy-map reconciliation lands and clears the session (the real F1b ordering)", async () => {
    // At reconnect the app still believes the session is busy; use-sessions then
    // re-derives the busy map from the server and drops it. The resync must fire
    // on THAT change, not be swallowed by the epoch it already saw.
    const { result, rerender } = mountWithTruncated()
    await waitFor(() => expect(answerOf(result)).toBe(TRUNCATED))

    mockActiveIds = new Set(["s1"])
    serverHasFullAnswer()
    mockEpoch = 1
    await act(async () => { rerender() })
    expect(connector.fetchHistory).toHaveBeenCalledTimes(1)

    mockActiveIds = new Set()
    await act(async () => { rerender() })
    await waitFor(() => expect(answerOf(result)).toBe(FULL))
    expect(connector.fetchHistory).toHaveBeenCalledTimes(2)
  })

  it("resyncs at most once per recovery", async () => {
    const { result, rerender } = mountWithTruncated()
    await waitFor(() => expect(answerOf(result)).toBe(TRUNCATED))

    serverHasFullAnswer()
    mockEpoch = 1
    await act(async () => { rerender() })
    await waitFor(() => expect(connector.fetchHistory).toHaveBeenCalledTimes(2))

    // Unrelated busy-map churn on the same epoch must not re-fetch.
    mockActiveIds = new Set(["other"])
    await act(async () => { rerender() })
    await act(async () => { await Promise.resolve() })
    expect(connector.fetchHistory).toHaveBeenCalledTimes(2)

    // A second recovery is a new gap and does get its own resync.
    mockEpoch = 2
    await act(async () => { rerender() })
    await waitFor(() => expect(connector.fetchHistory).toHaveBeenCalledTimes(3))
  })

  it("stays silent and leaves the list alone when the resync fetch fails", async () => {
    const { result, rerender } = mountWithTruncated()
    await waitFor(() => expect(answerOf(result)).toBe(TRUNCATED))

    connector.fetchHistory.mockRejectedValueOnce(new Error("still down"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockEpoch = 1
    await act(async () => { rerender() })
    await act(async () => { await Promise.resolve() })

    expect(answerOf(result)).toBe(TRUNCATED)
    expect(toast.error).not.toHaveBeenCalled()

    // The epoch was un-consumed, so the next dep change retries.
    serverHasFullAnswer()
    mockActiveIds = new Set(["nudge"])
    await act(async () => { rerender() })
    await waitFor(() => expect(answerOf(result)).toBe(FULL))
  })

  it("does NOT un-stop a turn the user froze with Stop", async () => {
    const { result, rerender } = mountWithTruncated()
    await waitFor(() => expect(answerOf(result)).toBe(TRUNCATED))

    act(() => { result.current.stopGeneration() })
    await waitFor(() => expect(result.current.stopped).toBe(true))

    serverHasFullAnswer()
    mockEpoch = 1
    await act(async () => { rerender() })
    await act(async () => { await Promise.resolve() })

    // Backends without revert (ACP) still hold the agent's full answer; pulling it
    // in would visibly undo the Stop the user just pressed.
    expect(connector.fetchHistory).toHaveBeenCalledTimes(1)
    expect(answerOf(result)).toBe(TRUNCATED)
  })

  it("never resyncs when the stream has not recovered (epoch 0 = first connect)", async () => {
    const { result } = mountWithTruncated()
    await waitFor(() => expect(answerOf(result)).toBe(TRUNCATED))
    expect(connector.fetchHistory).toHaveBeenCalledTimes(1)
    expect(capturedHandler).not.toBeNull()
  })
})
