import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { TeamSessionsProvider, useTeamSessions } from "@/lib/team-sessions-context"

const bindSessionAgent = vi.fn()

vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ workspacePath: "/ws" }),
}))
vi.mock("@/lib/agent-context", () => ({
  useAgents: () => ({ bindSessionAgent }),
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

afterEach(() => {
  vi.restoreAllMocks()
  bindSessionAgent.mockClear()
})

describe("TeamSessionsProvider", () => {
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

  it("degrades to an empty registry when the sidecar is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    const { result } = setup()
    await waitFor(() => expect(result.current.loading).toBe(false))
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
