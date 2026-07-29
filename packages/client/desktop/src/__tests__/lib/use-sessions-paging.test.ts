// The sidebar used to request a fixed newest-50 and filter the search box over
// that array. On a workspace with more sessions than that, everything older was
// unreachable AND the search reported "no match" for sessions that existed —
// which reads as data loss, not as a window. These tests pin the two halves of
// the fix: the query reaches the SERVER, and the window can grow.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

const listSessions = vi.hoisted(() => vi.fn())
const api = vi.hoisted(() => ({
  listSessions: (...args: unknown[]) => listSessions(...args),
  getSession: vi.fn(),
}))

vi.mock("@/lib/use-api", () => ({ useApi: () => api }))
vi.mock("@/lib/workspace-context", () => ({ useWorkspace: () => ({ workspacePath: "/ws" }) }))
vi.mock("@/lib/sse-context", () => ({
  useConnector: () => ({
    capabilitiesOf: () => ({}),
    deleteSession: vi.fn(),
    bindings: { backendOf: () => "opencode" },
  }),
  useSSESubscribe: () => {},
  // Paging is orthogonal to recovery; the reconnect path has its own suite.
  useSSEReconnectEpoch: () => 0,
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

/** N sessions in the mocked workspace, newest first. */
function page(n: number, prefix = "s") {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    title: `${prefix} title ${i}`,
    directory: "/ws",
    time: { created: 0, updated: 1000 - i },
  }))
}

function lastCall() {
  return listSessions.mock.calls[listSessions.mock.calls.length - 1][0]
}

beforeEach(() => {
  listSessions.mockReset()
})

describe("useSessions windowing", () => {
  it("asks the server for the first page and reports more when it comes back full", async () => {
    listSessions.mockResolvedValue(page(50))
    const { result } = renderHook(() => useSessions())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(lastCall()).toMatchObject({ roots: true, limit: 50, directory: "/ws" })
    expect(result.current.sessions).toHaveLength(50)
    expect(result.current.hasMore).toBe(true)
  })

  it("a short page means the end — no 'load more' offered", async () => {
    listSessions.mockResolvedValue(page(12))
    const { result } = renderHook(() => useSessions())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasMore).toBe(false)
  })

  it("loadMore widens the window and reaches sessions past the first page", async () => {
    listSessions.mockResolvedValueOnce(page(50)).mockResolvedValueOnce(page(90))
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.sessions).toHaveLength(50))

    act(() => result.current.loadMore())

    await waitFor(() => expect(result.current.sessions).toHaveLength(90))
    expect(lastCall()).toMatchObject({ limit: 100 })
    // A full window grew into a short one: nothing further to fetch.
    expect(result.current.hasMore).toBe(false)
  })
})

describe("useSessions search", () => {
  it("sends the query to the server rather than filtering the loaded window", async () => {
    listSessions.mockResolvedValue(page(50))
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.loading).toBe(false))

    listSessions.mockResolvedValue(page(3, "hit"))
    act(() => result.current.setSearch("invoice"))

    await waitFor(() => expect(lastCall()).toMatchObject({ search: "invoice" }))
    await waitFor(() => expect(result.current.sessions).toHaveLength(3))
  })

  it("debounces typing into a single request", async () => {
    listSessions.mockResolvedValue(page(5))
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = listSessions.mock.calls.length

    act(() => result.current.setSearch("i"))
    act(() => result.current.setSearch("in"))
    act(() => result.current.setSearch("inv"))

    await waitFor(() => expect(lastCall()).toMatchObject({ search: "inv" }))
    // One request for the settled query, not one per keystroke.
    expect(listSessions.mock.calls.length - before).toBe(1)
  })

  it("a new query restarts paging (a grown window must not leak into the search)", async () => {
    listSessions.mockResolvedValue(page(50))
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.sessions).toHaveLength(50))

    act(() => result.current.loadMore())
    await waitFor(() => expect(lastCall()).toMatchObject({ limit: 100 }))

    const before = listSessions.mock.calls.length
    act(() => result.current.setSearch("report"))
    await waitFor(() => expect(lastCall()).toMatchObject({ search: "report", limit: 50 }))
    // Resetting the window and applying the query must collapse into ONE request,
    // not fire an extra round-trip at the stale limit first.
    expect(listSessions.mock.calls.length - before).toBe(1)
  })

  it("clearing the box goes back to the unfiltered window", async () => {
    listSessions.mockResolvedValue(page(20))
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setSearch("x"))
    await waitFor(() => expect(lastCall()).toMatchObject({ search: "x" }))

    act(() => result.current.setSearch(""))
    await waitFor(() => expect(lastCall().search).toBeUndefined())
  })
})
