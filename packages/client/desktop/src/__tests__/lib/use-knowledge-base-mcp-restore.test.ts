import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

// --- Mocks -----------------------------------------------------------------

// Stable `t` reference — a fresh function each render would make the hook's
// SSE/fetch useCallbacks unstable and re-run their mount effect every render.
const stableT = (key: string) => key
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: stableT }),
}))

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const mockInvoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Stable mocked OpenCode api surface returned by useApi()
const mockApi = {
  getMCP: vi.fn(),
  createMCP: vi.fn(),
  connectMCP: vi.fn(),
}
vi.mock("@/lib/use-api", () => ({
  useApi: () => mockApi,
}))

// The hook's SSE now goes through the connector's fetch-reader transport. Stub it:
// left real it would consume the mocked `fetch`, fail to find a stream body, and
// leave a pending 5s reconnect behind. This test only exercises MCP auto-restore.
const mockTransport = { connect: vi.fn().mockResolvedValue(undefined), close: vi.fn(), forceReconnect: vi.fn(), getStatus: () => "open" as const }
vi.mock("@agent/connector", () => ({
  createSseTransport: () => mockTransport,
}))

import { useKnowledgeBase } from "@/lib/use-knowledge-base"

const mockFetch = vi.fn()

beforeEach(() => {
  mockInvoke.mockReset()
  mockApi.getMCP.mockReset()
  mockApi.createMCP.mockReset()
  mockApi.connectMCP.mockReset()
  mockFetch.mockReset()
  vi.stubGlobal("fetch", mockFetch)
  // Default invoke behaviour for the registration path.
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "get_sidecar_path") return Promise.resolve("/path/to/knowledge-sidecar")
    if (cmd === "write_mcp_config") return Promise.resolve(undefined)
    return Promise.resolve(undefined)
  })
  mockApi.createMCP.mockResolvedValue({})
  mockApi.connectMCP.mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Mock the GET /sources call made by fetchSources() on mount. */
function mockSources(sources: unknown[]) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ sources })),
  })
}

const IMA_SOURCE = {
  id: 1,
  type: "ima",
  name: "My IMA",
  config: { module: "notes" },
  enabled: true,
  status: "connected",
}

describe("useKnowledgeBase — MCP auto-restore", () => {
  it("registers the knowledge MCP when an IMA-only source exists but MCP is not connected", async () => {
    mockSources([IMA_SOURCE])
    mockApi.getMCP.mockResolvedValue({}) // knowledge-base not present/connected

    renderHook(() => useKnowledgeBase())

    await waitFor(() => {
      expect(mockApi.createMCP).toHaveBeenCalledWith(
        "knowledge-base",
        expect.objectContaining({ type: "local", command: ["/path/to/knowledge-sidecar", "mcp-stdio"] }),
      )
    })
    expect(mockApi.connectMCP).toHaveBeenCalledWith("knowledge-base")
    expect(mockInvoke).toHaveBeenCalledWith("write_mcp_config", expect.objectContaining({ name: "knowledge-base" }))
  })

  it("does not re-register when the knowledge MCP is already connected", async () => {
    mockSources([IMA_SOURCE])
    mockApi.getMCP.mockResolvedValue({ "knowledge-base": { status: "connected" } })

    renderHook(() => useKnowledgeBase())

    // getMCP runs once sources have loaded; give the effect a chance to run.
    await waitFor(() => expect(mockApi.getMCP).toHaveBeenCalled())
    expect(mockApi.createMCP).not.toHaveBeenCalled()
    expect(mockApi.connectMCP).not.toHaveBeenCalled()
  })

  it("retries when getMCP fails transiently (OpenCode still booting), then registers", async () => {
    mockSources([IMA_SOURCE])
    // First attempt rejects (OpenCode not reachable yet), second resolves empty.
    mockApi.getMCP
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({})

    renderHook(() => useKnowledgeBase())

    // Second attempt fires after the first backoff (~1.5s); allow margin.
    await waitFor(
      () => expect(mockApi.createMCP).toHaveBeenCalledWith("knowledge-base", expect.any(Object)),
      { timeout: 4000 },
    )
    expect(mockApi.getMCP.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("does nothing when there are no knowledge sources", async () => {
    mockSources([])
    mockApi.getMCP.mockResolvedValue({})

    const { result } = renderHook(() => useKnowledgeBase())

    await waitFor(() => expect(result.current.loading).toBe(false))
    // No sources → auto-restore must not even query MCP status or register.
    expect(mockApi.getMCP).not.toHaveBeenCalled()
    expect(mockApi.createMCP).not.toHaveBeenCalled()
  })
})
