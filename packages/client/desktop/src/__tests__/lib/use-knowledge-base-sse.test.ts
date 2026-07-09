// The knowledge stream's frames are distinguished ONLY by their SSE event name:
// `status` is a full snapshot of a source, `indexing`/`complete`/`error` are
// progress ticks. Both carry the source's own `status` field in the payload, so a
// migration that dropped the name would re-toast every already-complete or
// already-failed source on each reconnect. These tests pin the distinction.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

const stableT = (key: string) => key
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: stableT }) }))

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/use-api", () => ({
  useApi: () => ({ getMCP: vi.fn().mockResolvedValue({}), createMCP: vi.fn(), connectMCP: vi.fn() }),
}))

// Capture the transport options so a test can drive `onEvent` directly.
const captured = vi.hoisted(() => ({ onEvent: undefined as undefined | ((e: any, name?: string) => void) }))
const transport = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn(),
  forceReconnect: vi.fn(),
  getStatus: () => "open" as const,
}))
vi.mock("@agent/connector", () => ({
  createSseTransport: (opts: any) => {
    captured.onEvent = opts.onEvent
    return transport
  },
}))

import { useKnowledgeBase } from "@/lib/use-knowledge-base"

const mockFetch = vi.fn()

function progress(status: string, over: Record<string, unknown> = {}) {
  return {
    folderPath: "/w/docs",
    status,
    totalFiles: 10,
    indexedFiles: 10,
    skippedFiles: 0,
    ...over,
  }
}

describe("useKnowledgeBase — knowledge SSE", () => {
  beforeEach(() => {
    toast.error.mockReset()
    toast.success.mockReset()
    transport.connect.mockClear()
    transport.close.mockClear()
    captured.onEvent = undefined
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ sources: [] }) })
    vi.stubGlobal("fetch", mockFetch)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function mounted() {
    const hook = renderHook(() => useKnowledgeBase())
    await waitFor(() => expect(captured.onEvent).toBeDefined())
    return hook
  }

  it("connects a transport on mount and closes it on unmount", async () => {
    const { unmount } = await mounted()
    expect(transport.connect).toHaveBeenCalledTimes(1)
    unmount()
    expect(transport.close).toHaveBeenCalledTimes(1)
  })

  it("toasts on a `complete` progress tick", async () => {
    await mounted()
    captured.onEvent!(progress("complete"), "complete")
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("toasts on an `error` progress tick", async () => {
    await mounted()
    captured.onEvent!(progress("error", { error: "boom" }), "error")
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  // The regression this file exists for. A `status` snapshot carries the source's
  // own status — which is very often "complete" or "error" — and must stay silent.
  it.each(["complete", "error"])(
    "stays silent on a `status` snapshot whose payload status is %j",
    async (payloadStatus) => {
      await mounted()
      captured.onEvent!(progress(payloadStatus, { error: "boom" }), "status")
      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
    },
  )

  it("stays silent on an `indexing` tick", async () => {
    await mounted()
    captured.onEvent!(progress("indexing", { indexedFiles: 3 }), "indexing")
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
