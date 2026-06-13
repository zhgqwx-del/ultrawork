import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { SSEProvider, useConnector, useSSEConnected } from "@/lib/sse-context"

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
    mockFetch.mockResolvedValue({ ok: true, body: openStream() })
    holder.workspacePath = null
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
    const url = mockFetch.mock.calls[0][0] as string
    // dev mode (import.meta.env.DEV stubbed true) -> relative URL + directory query
    expect(url).toBe(`/event?${new URLSearchParams({ directory: "/w1" }).toString()}`)
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
})
