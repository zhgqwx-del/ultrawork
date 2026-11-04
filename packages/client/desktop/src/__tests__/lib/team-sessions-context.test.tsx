import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, act, cleanup } from "@testing-library/react"
import { TeamSessionsProvider, useTeamSessions } from "@/lib/team-sessions-context"
import { __emitSidecarPortsForTest, __resetSidecarPortsForTest, sidecarPorts } from "@/lib/sidecar-ports"

const bindSessionAgent = vi.fn()
let workspacePath: string | null = "/ws"
let acpAvailable = true

vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ workspacePath }),
}))
vi.mock("@/lib/agent-context", () => ({
  useAgents: () => ({ bindSessionAgent, acpAvailable }),
}))

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const ENTRIES = [
  { id: "ses_acp", workspace: "/ws", leaderAgentId: "acp:claude", members: ["acp:claude"], createdAt: 2 },
  { id: "ses_oc", workspace: "/ws", leaderAgentId: "opencode:default", members: [], createdAt: 1 },
]

function setup() {
  return renderHook(() => useTeamSessions(), {
    wrapper: ({ children }) => <TeamSessionsProvider>{children}</TeamSessionsProvider>,
  })
}

beforeEach(() => {
  workspacePath = "/ws"
  acpAvailable = true
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  __resetSidecarPortsForTest()
  vi.restoreAllMocks()
  bindSessionAgent.mockClear()
})

describe("TeamSessionsProvider", () => {
  it("retries immediately against a changed native ACP port", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("old port closed"))
      .mockResolvedValueOnce(jsonResponse({ sessions: ENTRIES }))
    const { result } = setup()
    await act(async () => {})
    act(() => __emitSidecarPortsForTest({ ...sidecarPorts(), acp: 42019 }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(String(fetchMock.mock.calls[1][0])).toContain(":42019/")
    expect(result.current.isTeamSession("ses_oc")).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("recovers the native cold-boot race when the ACP host becomes available", async () => {
    acpAvailable = false
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ACP has not started listening"))
      .mockResolvedValueOnce(jsonResponse({ sessions: ENTRIES }))
    const { result, rerender } = setup()
    await act(async () => {})
    expect(result.current.loading).toBe(true)
    expect(result.current.entryOf("ses_oc")).toBeUndefined()

    acpAvailable = true
    rerender()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.isTeamSession("ses_oc")).toBe(true)
    expect(bindSessionAgent).toHaveBeenCalledWith("ses_acp", "acp:claude")
  })

  it("backs off failed reads and stops scheduling after an authoritative success", async () => {
    vi.useFakeTimers()
    let healthy = false
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (!healthy) throw new Error("registry temporarily unavailable")
      return jsonResponse({ sessions: ENTRIES })
    })
    const { result } = setup()
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      const before = fetchMock.mock.calls.length
      await act(() => vi.advanceTimersByTimeAsync(delay - 1))
      expect(fetchMock).toHaveBeenCalledTimes(before)
      await act(() => vi.advanceTimersByTimeAsync(1))
      expect(fetchMock).toHaveBeenCalledTimes(before + 1)
    }
    healthy = true
    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(result.current.isTeamSession("ses_oc")).toBe(true)
    expect(result.current.loading).toBe(false)
    const afterSuccess = fetchMock.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(120_000))
    expect(fetchMock).toHaveBeenCalledTimes(afterSuccess)
  })

  it("aborts a stalled read, then retries rather than wedging unknown Team routing", async () => {
    vi.useFakeTimers()
    let initialSignal: AbortSignal | undefined
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        initialSignal = init?.signal ?? undefined
        initialSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      }))
      .mockResolvedValueOnce(jsonResponse({ sessions: ENTRIES }))
    const { result } = setup()
    await act(() => vi.advanceTimersByTimeAsync(9_999))
    expect(initialSignal?.aborted).toBe(false)
    expect(result.current.loading).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(initialSignal?.aborted).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(result.current.isTeamSession("ses_oc")).toBe(true)
  })

  it("retains known Team roles through failed refreshes and ACP downtime", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ sessions: ENTRIES }))
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchMock.mockRejectedValue(new Error("ACP down"))
    await act(() => result.current.refresh())
    acpAvailable = false
    rerender()
    await act(async () => {})
    expect(result.current.isTeamSession("ses_oc")).toBe(true)
    expect(result.current.loading).toBe(false)
  })

  it("isolates a changed workspace immediately and ignores a late manual refresh", async () => {
    let resolveOld!: (response: Response) => void
    const other = { ...ENTRIES[0], id: "team_other", workspace: "/other", leaderAgentId: "acp:gemini" }
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ sessions: ENTRIES }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [other] }))
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.loading).toBe(false))
    let oldRefresh!: Promise<void>
    act(() => { oldRefresh = result.current.refresh() })
    workspacePath = "/other"
    rerender()
    expect(result.current.entryOf("ses_oc")).toBeUndefined()
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.entryOf("team_other")).toEqual(other))
    expect((fetchMock.mock.calls[1][1]?.signal as AbortSignal).aborted).toBe(true)
    await act(async () => { resolveOld(jsonResponse({ sessions: ENTRIES })); await oldRefresh })
    expect(result.current.entries).toEqual([other])
    expect(bindSessionAgent.mock.calls.at(-1)).toEqual(["team_other", "acp:gemini"])
  })

  it("keeps optimistic Team edits newer than an in-flight registry snapshot", async () => {
    let resolveRead!: (response: Response) => void
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve }))
    const { result } = setup()
    const created = { ...ENTRIES[1], id: "created_team" }
    act(() => { result.current.addEntry(created); result.current.removeEntry("ses_acp") })
    // The creation response already identifies this new Team, while other
    // persisted sessions still need the authoritative registry read.
    expect(result.current.entryOf(created.id)).toEqual(created)
    expect(result.current.loading).toBe(true)
    await act(async () => { resolveRead(jsonResponse({ sessions: ENTRIES })) })
    expect(result.current.entryOf(created.id)).toEqual(created)
    expect(result.current.entryOf("ses_acp")).toBeUndefined()
    expect(result.current.entryOf("ses_oc")).toEqual(ENTRIES[1])
    expect(result.current.loading).toBe(false)
  })

  it("cancels a queued retry when unmounted", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    const { unmount } = setup()
    await act(async () => {})
    unmount()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("aborts an in-flight read and clears its deadline on unmount", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise(() => {})
    })
    const { unmount } = setup()
    unmount()
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("waits for a workspace rather than loading every workspace's Team registry", async () => {
    workspacePath = null
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ sessions: ENTRIES }))
    const { rerender } = setup()
    expect(fetchMock).not.toHaveBeenCalled()
    workspacePath = "/ws"
    rerender()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })
  it("loads the workspace-scoped registry and eagerly binds ACP leaders", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ sessions: ENTRIES }))
    const { result } = setup()
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(String(fetchMock.mock.calls[0][0])).toContain("workspace=%2Fws")
    expect(result.current.entries).toHaveLength(2)
    expect(result.current.entryOf("ses_oc")?.leaderAgentId).toBe("opencode:default")
    expect(result.current.isTeamSession("ses_acp")).toBe(true)
    expect(result.current.isTeamSession("other")).toBe(false)
    // Only the ACP leader gets a binding; opencode leaders need none.
    expect(bindSessionAgent.mock.calls).toEqual([["ses_acp", "acp:claude"]])
  })

  it("keeps an unreachable initial registry unknown until recovery", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    const { result } = setup()
    await act(async () => {})
    expect(result.current.loading).toBe(true)
    expect(result.current.entries).toEqual([])
    expect(result.current.entryOf("ses_acp")).toBeUndefined()
  })

  it("addEntry is optimistic and dedups; removeEntry drops the entry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ sessions: [] }))
    const { result } = setup()
    await waitFor(() => expect(result.current.loading).toBe(false))

    const entry = { id: "ses_new", workspace: "/ws", leaderAgentId: "opencode:default", members: [], createdAt: 3 }
    act(() => result.current.addEntry(entry))
    act(() => result.current.addEntry(entry))
    expect(result.current.entries).toHaveLength(1)
    expect(result.current.isTeamSession("ses_new")).toBe(true)

    act(() => result.current.removeEntry("ses_new"))
    expect(result.current.entries).toHaveLength(0)
  })

  it("refresh reloads and re-binds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ sessions: [] }))
      .mockResolvedValueOnce(jsonResponse({ sessions: ENTRIES }))
    const { result } = setup()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.entries).toHaveLength(0)

    await act(() => result.current.refresh())
    expect(result.current.entries).toHaveLength(2)
    expect(bindSessionAgent).toHaveBeenCalledWith("ses_acp", "acp:claude")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
