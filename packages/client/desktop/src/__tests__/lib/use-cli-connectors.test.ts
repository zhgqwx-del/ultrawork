import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

// Stable mock references (gotchas §13): factories run hoisted, so capture fns
// created inside and re-read them via the module-level consts below.
const mockInvoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))
const mockOpenUrl = vi.fn()
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}))
const mockToast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn() }
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => mockToast.success(...a),
    error: (...a: unknown[]) => mockToast.error(...a),
    info: (...a: unknown[]) => mockToast.info(...a),
    loading: (...a: unknown[]) => mockToast.loading(...a),
  },
}))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ language: "zh", t: (k: string) => k, setLanguage: () => {} }),
}))

import { useCliConnectors, type CliConnectorStatus } from "@/lib/use-cli-connectors"

const NOT_INSTALLED: CliConnectorStatus = { id: "lark", state: "not_installed" }
const NOT_CONFIGURED: CliConnectorStatus = {
  id: "lark", state: "not_configured", path: "/x/lark-cli", version: "1.0.65",
}
const NOT_AUTHORIZED: CliConnectorStatus = { ...NOT_CONFIGURED, state: "not_authorized" }
const CONNECTED: CliConnectorStatus = { ...NOT_CONFIGURED, state: "connected", detail: "张三" }

describe("useCliConnectors", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockOpenUrl.mockReset()
    mockOpenUrl.mockResolvedValue(undefined)
    for (const fn of Object.values(mockToast)) fn.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("probes on mount and exposes statuses keyed by id", async () => {
    mockInvoke.mockResolvedValue([NOT_CONFIGURED])
    const { result } = renderHook(() => useCliConnectors())

    await waitFor(() => expect(result.current.checking).toBe(false))
    expect(mockInvoke).toHaveBeenCalledWith("check_cli_connectors")
    expect(result.current.statuses["lark"]).toEqual(NOT_CONFIGURED)
  })

  it("degrades outside Tauri (invoke rejects) without crashing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockRejectedValue(new Error("no bridge"))
    const { result } = renderHook(() => useCliConnectors())

    await waitFor(() => expect(result.current.checking).toBe(false))
    expect(result.current.statuses).toEqual({})
    warn.mockRestore()
  })

  it("install forwards the id, applies the returned status and toasts", async () => {
    mockInvoke.mockResolvedValueOnce([NOT_INSTALLED])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    mockInvoke.mockResolvedValueOnce(NOT_CONFIGURED)
    await act(async () => {
      await result.current.install("lark")
    })

    expect(mockInvoke).toHaveBeenLastCalledWith("install_office_cli", { id: "lark" })
    expect(result.current.statuses["lark"]).toEqual(NOT_CONFIGURED)
    expect(result.current.phases["lark"]).toBe("idle")
    expect(mockToast.success).toHaveBeenCalledWith("cliConnector.toastInstalled")
  })

  it("install failure surfaces the error and returns to idle", async () => {
    mockInvoke.mockResolvedValueOnce([NOT_INSTALLED])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    mockInvoke.mockRejectedValueOnce(new Error("checksum mismatch"))
    await act(async () => {
      await result.current.install("lark")
    })

    expect(result.current.errors["lark"]).toContain("checksum mismatch")
    expect(result.current.phases["lark"]).toBe("idle")
    expect(mockToast.error).toHaveBeenCalled()
    // Probed status is untouched by a failed install.
    expect(result.current.statuses["lark"]).toEqual(NOT_INSTALLED)
  })

  it("configure opens the hosted URL and polls until the state moves", async () => {
    vi.useFakeTimers()
    mockInvoke.mockResolvedValueOnce([NOT_CONFIGURED])
    const { result } = renderHook(() => useCliConnectors())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.checking).toBe(false)

    const url = "https://open.feishu.cn/page/cli?user_code=AB-CD"
    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "start_office_cli_config") return url
      if (cmd === "check_cli_connectors") return [NOT_AUTHORIZED] // user finished in browser
      throw new Error(`unexpected: ${String(cmd)}`)
    })

    let done!: Promise<void>
    act(() => {
      done = result.current.configure("lark")
    })
    // Let start_office_cli_config resolve → openUrl fires, pendingUrl set.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockInvoke).toHaveBeenCalledWith("start_office_cli_config", { id: "lark", lang: "zh" })
    expect(mockOpenUrl).toHaveBeenCalledWith(url)
    expect(result.current.pendingUrls["lark"]).toBe(url)
    expect(result.current.phases["lark"]).toBe("configuring")

    // First 3s poll sees the flipped state → flow finishes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      await done
    })
    expect(result.current.statuses["lark"]).toEqual(NOT_AUTHORIZED)
    expect(result.current.pendingUrls["lark"]).toBeNull()
    expect(result.current.phases["lark"]).toBe("idle")
  })

  it("authorize runs the device flow: open URL, complete with device code", async () => {
    mockInvoke.mockResolvedValueOnce([NOT_AUTHORIZED])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "start_office_cli_auth") {
        return {
          device_code: "dc123",
          verification_uri: "https://v",
          verification_uri_complete: "https://v?u=AB-CD",
          expires_in: 300,
          interval: 5,
        }
      }
      if (cmd === "complete_office_cli_auth") return CONNECTED
      throw new Error(`unexpected: ${String(cmd)}`)
    })

    await act(async () => {
      await result.current.authorize("lark")
    })

    // Prefers the pre-filled verification URL.
    expect(mockOpenUrl).toHaveBeenCalledWith("https://v?u=AB-CD")
    expect(mockInvoke).toHaveBeenLastCalledWith("complete_office_cli_auth", {
      id: "lark",
      deviceCode: "dc123",
      expiresIn: 300,
    })
    expect(result.current.statuses["lark"]).toEqual(CONNECTED)
    expect(result.current.phases["lark"]).toBe("idle")
    expect(mockToast.success).toHaveBeenCalledWith("cliConnector.toastConnected")
  })

  it("authorize failure (expired/denied) lands in errors, not a fake success", async () => {
    mockInvoke.mockResolvedValueOnce([NOT_AUTHORIZED])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "start_office_cli_auth") {
        return { device_code: "dc123", verification_uri: "https://v" }
      }
      if (cmd === "complete_office_cli_auth") throw new Error("authorization expired")
      throw new Error(`unexpected: ${String(cmd)}`)
    })

    await act(async () => {
      await result.current.authorize("lark")
    })

    expect(result.current.errors["lark"]).toContain("authorization expired")
    expect(result.current.phases["lark"]).toBe("idle")
    expect(mockToast.success).not.toHaveBeenCalled()
    expect(result.current.statuses["lark"]).toEqual(NOT_AUTHORIZED)
  })
})
