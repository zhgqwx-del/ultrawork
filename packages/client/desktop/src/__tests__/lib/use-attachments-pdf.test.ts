import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

const { mockInvoke, toast } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }),
}))
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...(args as [string, unknown])),
}))
vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/use-api", () => ({ useApi: () => ({}) }))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))

import { useAttachments } from "@/lib/use-attachments"
import { MAX_BYTES } from "@/lib/attachments"

const MB = 1024 * 1024

describe("useAttachments — large PDF routing (regression: >inline-cap must degrade to document, not reject)", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    toast.mockReset()
    toast.error.mockReset()
    toast.info.mockReset()
  })

  it("routes a PDF over the inline cap (but under the document cap) to a DOCUMENT, not a rejection", async () => {
    // 12 MB report: over MAX_BYTES.pdf (8 MB inline cap), well under MAX_BYTES.document (100 MB).
    // The design says this is attachable — copied into the workspace, read on demand — NOT
    // rejected outright. It must not even read the bytes (too big to page-count), so file_size
    // is the only Tauri call.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_size") return Promise.resolve(12 * MB)
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    const { result } = renderHook(() => useAttachments("some-model"))

    await act(async () => {
      await result.current.addPaths(["/tmp/big-report.pdf"])
    })

    await waitFor(() => expect(result.current.items).toHaveLength(1))
    const a = result.current.items[0]
    expect(a.kind).toBe("document") // degraded, not inlined, not rejected
    expect(a.filename).toBe("big-report.pdf")
    expect(a.wireUrl).toBe("") // documents carry no wire url — copied at send time
    expect(a.srcPath).toBe("/tmp/big-report.pdf")
    expect(toast.error).not.toHaveBeenCalled() // NOT rejected
    expect(toast.info).toHaveBeenCalled() // told it was placed in the workspace
    // Never read the bytes — too big to slurp for a page count.
    expect(mockInvoke).not.toHaveBeenCalledWith("read_file_bytes", expect.anything())
  })

  it("still rejects a PDF over the document cap (genuinely too big for either route)", async () => {
    const tooBig = MAX_BYTES.document + 5 * MB
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_size") return Promise.resolve(tooBig)
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    const { result } = renderHook(() => useAttachments("some-model"))

    await act(async () => {
      await result.current.addPaths(["/tmp/enormous.pdf"])
    })

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(result.current.items).toHaveLength(0) // rejected, nothing attached
  })
})
