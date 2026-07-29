// The opencode event stream has no replay. A `session.status:idle` emitted while
// the stream was down was simply lost, and nothing else ever cleared the busy
// marker — so the session spun forever in the sidebar and sendMessage's busy
// guard kept the composer locked, with no way out but restarting the app.
// These tests pin the recovery: on reconnect, busy is re-derived from the
// server's own map rather than from events we may never have seen.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

const listSessions = vi.hoisted(() => vi.fn())
const getSessionStatuses = vi.hoisted(() => vi.fn())
const api = vi.hoisted(() => ({
  listSessions: (...a: unknown[]) => listSessions(...a),
  getSessionStatuses: (...a: unknown[]) => getSessionStatuses(...a),
  getSession: vi.fn(),
}))

// Which backend each session is bound to — the reconciliation must only speak
// for opencode sessions.
const backends = vi.hoisted(() => ({ map: new Map<string, string>() }))
const epoch = vi.hoisted(() => ({ value: 0 }))

vi.mock("@/lib/use-api", () => ({ useApi: () => api }))
vi.mock("@/lib/workspace-context", () => ({ useWorkspace: () => ({ workspacePath: "/ws" }) }))
vi.mock("@/lib/sse-context", () => ({
  useConnector: () => ({
    capabilitiesOf: () => ({}),
    deleteSession: vi.fn(),
    bindings: { backendOf: (id: string) => backends.map.get(id) ?? "opencode" },
  }),
  useSSESubscribe: () => {},
  useSSEReconnectEpoch: () => epoch.value,
}))
vi.mock("@/lib/team-sessions-context", () => ({
  useTeamSessions: () => ({ entries: [], isTeamSession: () => false, removeEntry: vi.fn() }),
}))
vi.mock("@/lib/orchestration-client", () => ({ deleteTeamSession: vi.fn() }))
vi.mock("@/lib/use-session-messages", () => ({
  applyMessageEventToCache: vi.fn(),
  forgetMessageCacheSession: vi.fn(),
}))
vi.mock("@/lib/use-unread", () => ({ forgetSessionRead: vi.fn() }))

import { useSessions } from "@/lib/use-sessions"

beforeEach(() => {
  listSessions.mockReset().mockResolvedValue([])
  getSessionStatuses.mockReset().mockResolvedValue({})
  backends.map.clear()
  epoch.value = 0
})

async function mounted() {
  const hook = renderHook(() => useSessions())
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

describe("busy markers after an SSE recovery", () => {
  it("clears a marker whose idle event fell in the gap", async () => {
    const { result, rerender } = await mounted()
    act(() => result.current.markSessionActive("ses_a"))
    expect(result.current.activeSessionIds.has("ses_a")).toBe(true)

    // Server says nothing is busy — its map DELETES a session on idle, so an
    // absent key means idle, not unknown.
    getSessionStatuses.mockResolvedValue({})
    epoch.value = 1
    rerender()

    await waitFor(() => expect(result.current.activeSessionIds.has("ses_a")).toBe(false))
  })

  it("keeps a marker for a turn that really is still running", async () => {
    const { result, rerender } = await mounted()
    act(() => result.current.markSessionActive("ses_a"))

    getSessionStatuses.mockResolvedValue({ ses_a: { type: "busy" } })
    epoch.value = 1
    rerender()

    await waitFor(() => expect(getSessionStatuses).toHaveBeenCalled())
    expect(result.current.activeSessionIds.has("ses_a")).toBe(true)
  })

  it("adopts a turn that STARTED during the gap", async () => {
    // The busy event is just as losable as the idle one.
    const { result, rerender } = await mounted()
    getSessionStatuses.mockResolvedValue({ ses_new: { type: "busy" } })
    epoch.value = 1
    rerender()

    await waitFor(() => expect(result.current.activeSessionIds.has("ses_new")).toBe(true))
  })

  it("leaves ACP sessions alone — they re-announce their own busy set", async () => {
    const { result, rerender } = await mounted()
    backends.map.set("ses_acp", "acp")
    act(() => result.current.markSessionActive("ses_acp"))

    getSessionStatuses.mockResolvedValue({}) // opencode knows nothing of it
    epoch.value = 1
    rerender()

    await waitFor(() => expect(getSessionStatuses).toHaveBeenCalled())
    expect(result.current.activeSessionIds.has("ses_acp")).toBe(true)
  })

  it("does not reconcile on the FIRST connect (epoch 0)", async () => {
    // Nothing was missed before the stream ever opened; querying then would only
    // add a request to every cold start.
    await mounted()
    expect(getSessionStatuses).not.toHaveBeenCalled()
  })

  it("survives the status endpoint failing", async () => {
    const { result, rerender } = await mounted()
    act(() => result.current.markSessionActive("ses_a"))

    getSessionStatuses.mockRejectedValue(new Error("backend still wedged"))
    epoch.value = 1
    rerender()

    await waitFor(() => expect(getSessionStatuses).toHaveBeenCalled())
    // Best-effort: a failed probe must not wipe markers it could not verify.
    expect(result.current.activeSessionIds.has("ses_a")).toBe(true)
  })

  it("refetches the session list, since titles and new sessions also came as events", async () => {
    const { rerender } = await mounted()
    const before = listSessions.mock.calls.length

    epoch.value = 1
    rerender()

    await waitFor(() => expect(listSessions.mock.calls.length).toBeGreaterThan(before))
  })
})
