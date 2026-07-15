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

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))

import { useScreenshot } from "@/lib/use-screenshot"

/** Route an invoke by command name so tests read as a script of platform outcomes. */
function routeInvoke(handlers: Record<string, (arg: unknown) => unknown>) {
  mockInvoke.mockImplementation((cmd: string, arg: unknown) => {
    const h = handlers[cmd]
    if (!h) return Promise.reject(new Error(`unexpected invoke: ${cmd}`))
    return Promise.resolve(h(arg))
  })
}

describe("useScreenshot", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    toast.mockReset()
    toast.error.mockReset()
    toast.info.mockReset()
  })

  it("routes a captured screenshot through add() and then discards the temp file", async () => {
    const png = new Uint8Array([137, 80, 78, 71]).buffer // "\x89PNG"
    const calls: string[] = []
    routeInvoke({
      screenshot_capability: () => ({ available: true }),
      capture_screenshot: () => {
        calls.push("capture")
        return { outcome: "captured", path: "/tmp/ultrawork-screenshots/shot-1-0.png" }
      },
      read_file_bytes: () => {
        calls.push("read")
        return png
      },
      discard_temp_file: (arg) => {
        calls.push("discard")
        expect(arg).toEqual({ path: "/tmp/ultrawork-screenshots/shot-1-0.png" })
        return null
      },
    })
    const add = vi.fn()
    const { result } = renderHook(() => useScreenshot(add))
    await waitFor(() => expect(result.current.available).toBe(true))

    await act(async () => {
      result.current.capture(true)
    })
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))

    // The bytes became a real image/png File named after the temp path.
    const [files] = add.mock.calls[0] as [File[]]
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0].type).toBe("image/png")
    expect(files[0].name).toBe("shot-1-0.png")
    // Read BEFORE discard — a discard-first ordering would delete the bytes we need.
    expect(calls).toEqual(["capture", "read", "discard"])
  })

  it("never calls add() when macOS reports needs_permission, and offers the grant action", async () => {
    routeInvoke({
      screenshot_capability: () => ({ available: true }),
      capture_screenshot: () => ({ outcome: "needs_permission" }),
    })
    const add = vi.fn()
    const { result } = renderHook(() => useScreenshot(add))
    await waitFor(() => expect(result.current.available).toBe(true))

    await act(async () => {
      result.current.capture(true)
    })
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(add).not.toHaveBeenCalled()
    // A guided fallback, not a dead end: the toast carries a "grant" action.
    const opts = toast.mock.calls[0]?.[1] as { action?: { onClick: () => void } }
    expect(opts?.action).toBeTruthy()
  })

  it("disables the button (available=false) when the platform has no tool", async () => {
    routeInvoke({ screenshot_capability: () => ({ available: false }) })
    const { result } = renderHook(() => useScreenshot(vi.fn()))
    await waitFor(() => expect(result.current.available).toBe(false))
  })

  it("ignores a second click while a capture is already in flight", async () => {
    let resolveCapture: (v: unknown) => void = () => {}
    const captureStarted = vi.fn()
    routeInvoke({
      screenshot_capability: () => ({ available: true }),
      capture_screenshot: () => {
        captureStarted()
        return new Promise((res) => {
          resolveCapture = res
        })
      },
    })
    const { result } = renderHook(() => useScreenshot(vi.fn()))
    await waitFor(() => expect(result.current.available).toBe(true))

    await act(async () => {
      result.current.capture(true)
    })
    await waitFor(() => expect(result.current.busy).toBe(true))
    // Second click while busy: must not launch a second selector.
    act(() => {
      result.current.capture(true)
    })
    expect(captureStarted).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCapture({ outcome: "cancelled" })
    })
    await waitFor(() => expect(result.current.busy).toBe(false))
  })
})
