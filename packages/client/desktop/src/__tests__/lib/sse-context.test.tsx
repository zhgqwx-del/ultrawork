import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { SSEProvider, useConnector, useSSEConnected } from "@/lib/sse-context"
import { PREFERRED_PORTS, __emitSidecarPortsForTest, __resetSidecarPortsForTest } from "@/lib/sidecar-ports"

// Mutable holders so the mocked hooks can change between rerenders
const holder = {
  config: { apiBaseUrl: "http://localhost:4096", apiUsername: "opencode", apiPassword: "pw" },
  workspacePath: null as string | null,
}

vi.mock("@/lib/config-context", () => ({
  useConfig: () => ({ config: holder.config }),
}))
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ workspacePath: holder.workspacePath }),
}))

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function openStream() {
  return new ReadableStream<Uint8Array>({ start() {} })
}

function Probe() {
  const connector = useConnector()
  const connected = useSSEConnected()
  return (
    <div>
      <span data-testid="has-connector">{connector ? "yes" : "no"}</span>
      <span data-testid="connected">{String(connected)}</span>
    </div>
  )
}

describe("SSEProvider (ConnectorProvider)", () => {
  beforeEach(() => {
    mockFetch.mockReset()
    // Fresh stream per call: the global subscription now opens TWO streams
    // (opencode /event + ACP /acp/global/events), and a shared ReadableStream
    // body would lock on the second reader.
    mockFetch.mockImplementation(async () => ({ ok: true, body: openStream() }))
    holder.workspacePath = null
    __resetSidecarPortsForTest()
  })

  it("provides a connector but does NOT connect SSE when no workspace is selected", () => {
    render(
      <SSEProvider>
        <Probe />
      </SSEProvider>,
    )
    expect(screen.getByTestId("has-connector").textContent).toBe("yes")
    expect(screen.getByTestId("connected").textContent).toBe("false")
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("connects the global /event stream once a workspace is selected", async () => {
    holder.workspacePath = "/w1"
    render(
      <SSEProvider>
        <Probe />
      </SSEProvider>,
    )

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    const urls = mockFetch.mock.calls.map((c) => c[0] as string)
    // dev mode (import.meta.env.DEV stubbed true) -> relative URL + directory query.
    // The global subscription fans out to BOTH backends now: opencode's /event
    // AND the ACP sidecar's lifecycle stream (ACP globalEvents=true, discussions/022).
    expect(urls).toContain(`/event?${new URLSearchParams({ directory: "/w1" }).toString()}`)
    expect(urls.some((u) => u.includes("/acp/global/events"))).toBe(true)
    await waitFor(() => expect(screen.getByTestId("connected").textContent).toBe("true"))
  })

  it("rebuilds the connector and reconnects when the workspace changes", async () => {
    holder.workspacePath = "/w1"
    const view = render(
      <SSEProvider>
        <Probe />
      </SSEProvider>,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    const callsForW1 = mockFetch.mock.calls.length

    holder.workspacePath = "/w2"
    await act(async () => {
      view.rerender(
        <SSEProvider>
          <Probe />
        </SSEProvider>,
      )
    })

    await waitFor(() => {
      const urls = mockFetch.mock.calls.slice(callsForW1).map((c) => c[0] as string)
      expect(urls.some((u) => u.includes(encodeURIComponent("/w2")))).toBe(true)
    })
  })
  // A sidecar that loses a bind race moves to a new port AFTER the startup gate has
  // published the old one. The host emits `sidecar-ports-changed`; without the
  // `portsVersion` dep in the connector's useMemo the ACP backend keeps its old base
  // URL and talks to a port nobody is listening on — and every existing test here
  // stays green, because they only ever change the workspace.
  it("rebuilds the connector against the new ACP port when the host moves it", async () => {
    holder.workspacePath = "/w1"
    render(
      <SSEProvider>
        <Probe />
      </SSEProvider>,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    const before = mockFetch.mock.calls.map((c) => c[0] as string)
    expect(before.some((u) => u.includes(`localhost:${PREFERRED_PORTS.acp}/acp/global/events`))).toBe(true)
    const callsBefore = mockFetch.mock.calls.length

    // The host reports a new ACP port.
    await act(async () => {
      __emitSidecarPortsForTest({ ...PREFERRED_PORTS, acp: 51237 })
    })

    await waitFor(() => {
      const after = mockFetch.mock.calls.slice(callsBefore).map((c) => c[0] as string)
      expect(after.some((u) => u.includes("localhost:51237/acp/global/events"))).toBe(true)
    })
  })
})
