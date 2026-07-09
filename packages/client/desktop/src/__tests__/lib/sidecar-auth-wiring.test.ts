// Every renderer client of the three protected sidecars must send Authorization.
//
// `sidecarAuthHeaders()` returns `{}` when no credential is loaded — which is the
// default in unit tests — so deleting the header spread from any of these call sites
// leaves the rest of the suite green while the real app 401s on every request. These
// tests pin the wiring itself, in both directions.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (k: string) => k }) }))

import { __setSidecarCredentialsForTest } from "@/lib/sidecar-auth"
import { __resetSidecarPortsForTest } from "@/lib/sidecar-ports"
import { kbFetch } from "@/lib/kb-client"
import { listRuns, listDelegates, createRun, cancelRun } from "@/lib/orchestration-client"

const CREDS = { username: "opencode", password: "s3cret" }
const EXPECTED = `Basic ${btoa("opencode:s3cret")}`

const fetchMock = vi.fn()

/** Headers of the Nth fetch, normalized to a plain record. */
function headersOf(call = 0): Record<string, string> {
  const init = fetchMock.mock.calls[call]?.[1]
  return (init?.headers ?? {}) as Record<string, string>
}

describe("renderer auth wiring", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sources: [], runs: [], delegates: [], run: {}, ok: true }),
      json: async () => ({ sources: [], runs: [], delegates: [], run: {}, ok: true }),
    })
    vi.stubGlobal("fetch", fetchMock)
    __resetSidecarPortsForTest()
    __setSidecarCredentialsForTest(CREDS)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    __setSidecarCredentialsForTest(null)
  })

  describe("knowledge sidecar (kb-client)", () => {
    it("sends Authorization on GET", async () => {
      await kbFetch("/sources")
      expect(headersOf().Authorization).toBe(EXPECTED)
    })

    it("sends Authorization on a POST with a body", async () => {
      await kbFetch("/sources", { method: "POST", body: "{}" })
      expect(headersOf().Authorization).toBe(EXPECTED)
      expect(headersOf()["Content-Type"]).toBe("application/json")
    })

    it("sends no Authorization when no credential is loaded", async () => {
      __setSidecarCredentialsForTest(null)
      await kbFetch("/sources")
      expect(headersOf().Authorization).toBeUndefined()
    })
  })

  describe("ACP sidecar (orchestration-client)", () => {
    it.each([
      ["listRuns", () => listRuns()],
      ["listDelegates", () => listDelegates()],
      ["createRun", () => createRun({ steps: [] } as never)],
      ["cancelRun", () => cancelRun("run_1")],
    ])("%s sends Authorization", async (_label, call) => {
      await call()
      expect(headersOf().Authorization).toBe(EXPECTED)
    })

    it("omits Authorization when no credential is loaded", async () => {
      __setSidecarCredentialsForTest(null)
      await listRuns()
      expect(headersOf().Authorization).toBeUndefined()
    })
  })

  describe("gateway (use-channels)", () => {
    it("sends Authorization from gatewayFetch", async () => {
      // useChannels' fetch path is exercised through its exported hook elsewhere; here we
      // drive the module's fetch directly via its first call on mount.
      const { useChannels } = await import("@/lib/use-channels")
      const { renderHook, waitFor } = await import("@testing-library/react")
      renderHook(() => useChannels())
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(headersOf().Authorization).toBe(EXPECTED)
    })
  })
})
