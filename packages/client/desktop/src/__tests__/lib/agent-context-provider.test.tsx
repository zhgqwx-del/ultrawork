import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, act, screen } from "@testing-library/react"

// discussions/042 — end-to-end proof of the self-healing ACP availability loop.
// The ACP sidecar (:4099) is spawned in a non-blocking thread AFTER the renderer
// gate opens, so AgentProvider's first health probe reliably loses the race and
// returns false. This drives the REAL provider through its tick loop under a
// virtual clock to prove: (a) it re-probes with fast backoff and flips
// acpAvailable → true automatically once the sidecar comes up (previously it
// stayed false until a manual dropdown open — the reported bug), and (b) a
// once-healthy sidecar that dies downgrades only after the debounce, not on a
// single transient blip. Deterministic vitest fake timers — no rAF, no headless
// hang.

const http = {
  health: vi.fn<() => Promise<boolean>>(),
  listAgents: vi.fn<() => Promise<Array<{ id: string; label: string; status: string }>>>(),
  listSessions: vi.fn<() => Promise<unknown[]>>(),
}

const connector = {
  getBackend: () => ({ http }),
  bindings: {
    hydrate: vi.fn(),
    get: () => "",
    bind: vi.fn(),
    onChange: () => () => {},
    version: 0,
  },
}

vi.mock("@/lib/sse-context", () => ({
  useConnector: () => connector,
  useSSEConnected: () => true,
}))

import { AgentProvider, useAgents } from "@/lib/agent-context"

function Probe() {
  const { acpAvailable, agents } = useAgents()
  return (
    <>
      <div data-testid="avail">{String(acpAvailable)}</div>
      <div data-testid="acp-count">{agents.filter((a) => a.source === "acp").length}</div>
    </>
  )
}

const avail = () => screen.getByTestId("avail").textContent
const acpCount = () => screen.getByTestId("acp-count").textContent

describe("AgentProvider self-healing ACP availability (integration)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    http.health.mockReset()
    http.listAgents.mockReset().mockResolvedValue([{ id: "claude", label: "Claude", status: "available" }])
    http.listSessions.mockReset().mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  it("recovers automatically: false at cold boot, flips true once the sidecar comes up (no manual open)", async () => {
    // Sidecar still spawning → first two health probes fail, then it's up.
    http.health.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true)

    render(
      <AgentProvider>
        <Probe />
      </AgentProvider>,
    )

    // Mount fires the first probe immediately → unavailable.
    await advance(0)
    expect(http.health).toHaveBeenCalledTimes(1)
    expect(avail()).toBe("false")

    // Fast backoff, NOT a full 4s steady wait: 2nd probe fires at ~1s (still false).
    await advance(999)
    expect(http.health).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(http.health).toHaveBeenCalledTimes(2)
    expect(avail()).toBe("false")

    // 3rd probe at ~2s → sidecar healthy → acpAvailable flips true ON ITS OWN.
    await advance(2000)
    expect(http.health).toHaveBeenCalledTimes(3)
    expect(avail()).toBe("true")
    // Roster populated on (re)connect.
    expect(http.listAgents).toHaveBeenCalled()
  })

  it("does not flicker off on a single transient failure, downgrades after DOWN_THRESHOLD", async () => {
    // Connect cleanly first.
    http.health.mockResolvedValue(true)
    render(
      <AgentProvider>
        <Probe />
      </AgentProvider>,
    )
    await advance(0)
    expect(avail()).toBe("true")

    // Now the steady poll uses listAgents() as the liveness signal. One transient
    // failure must NOT flip Team off (debounce); it schedules a fast recheck.
    http.listAgents.mockRejectedValueOnce(new Error("blip"))
    await advance(4000) // steady interval → first steady tick fails
    expect(avail()).toBe("true") // debounced, still available

    // A recovery within the debounce window clears the streak — no downgrade.
    // (listAgents default resolves again after the one rejection.)
    await advance(1000) // fast recheck (~1s) succeeds
    expect(avail()).toBe("true")
  })

  it("downgrades to false after two consecutive steady failures", async () => {
    http.health.mockResolvedValue(true)
    render(
      <AgentProvider>
        <Probe />
      </AgentProvider>,
    )
    await advance(0)
    expect(avail()).toBe("true")

    // Sidecar dies: listAgents keeps failing.
    http.listAgents.mockRejectedValue(new Error("down"))
    await advance(4000) // 1st steady failure → still available (debounce), fast recheck queued
    expect(avail()).toBe("true")
    await advance(1000) // 2nd consecutive failure → downgrade
    expect(avail()).toBe("false")
  })

  it("steady reconcile reflects server-side roster changes (add + remove), not just status (F1/F2)", async () => {
    http.health.mockResolvedValue(true)
    http.listAgents.mockResolvedValue([{ id: "claude", label: "Claude", status: "available" }])
    render(
      <AgentProvider>
        <Probe />
      </AgentProvider>,
    )
    await advance(0)
    expect(avail()).toBe("true")
    expect(acpCount()).toBe("1")

    // A second ACP agent appears server-side. A status-only merge would MISS it;
    // the reconcile must add it on the next steady tick.
    http.listAgents.mockResolvedValue([
      { id: "claude", label: "Claude", status: "available" },
      { id: "gemini", label: "Gemini", status: "available" },
    ])
    await advance(4000)
    expect(acpCount()).toBe("2")

    // An agent is removed server-side → reconcile drops it.
    http.listAgents.mockResolvedValue([{ id: "gemini", label: "Gemini", status: "available" }])
    await advance(4000)
    expect(acpCount()).toBe("1")
    expect(avail()).toBe("true")
  })

  it("stops polling after unmount (no leaked timer / setState-after-unmount)", async () => {
    http.health.mockResolvedValue(false)
    const { unmount } = render(
      <AgentProvider>
        <Probe />
      </AgentProvider>,
    )
    await advance(0)
    expect(http.health).toHaveBeenCalledTimes(1)
    unmount()
    await advance(60_000)
    expect(http.health).toHaveBeenCalledTimes(1)
  })
})
