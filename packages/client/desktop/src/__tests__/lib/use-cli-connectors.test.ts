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
    expect(mockToast.success).toHaveBeenCalledWith("cliConnector.lark.toastInstalled")
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

  it("configure keeps polling through transient probe errors, then errors out at the deadline", async () => {
    vi.useFakeTimers()
    mockInvoke.mockResolvedValueOnce([NOT_CONFIGURED])
    const { result } = renderHook(() => useCliConnectors())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const ERRORED: CliConnectorStatus = { ...NOT_CONFIGURED, state: "error", detail: "probe timeout" }
    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "start_office_cli_config") return "https://open.feishu.cn/page/cli?user_code=AB-CD"
      if (cmd === "check_cli_connectors") return [ERRORED] // transient probe failure forever
      throw new Error(`unexpected: ${String(cmd)}`)
    })

    let done!: Promise<void>
    act(() => {
      done = result.current.configure("lark")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // A transient "error" probe is NOT completion — still configuring.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(result.current.phases["lark"]).toBe("configuring")

    // Deadline (10min) passes without progress → explicit error, no silent snap-back.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
      await done
    })
    expect(result.current.phases["lark"]).toBe("idle")
    expect(result.current.errors["lark"]).toBe("cliConnector.configTimeout")
    expect(result.current.pendingUrls["lark"]).toBeNull()
  })

  it("refresh(id) clears only that connector's error — a sibling's banner survives", async () => {
    mockInvoke.mockResolvedValueOnce([NOT_INSTALLED])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    // Seed errors on two connectors via failed installs (hook is id-generic).
    mockInvoke.mockRejectedValueOnce(new Error("lark boom"))
    await act(async () => {
      await result.current.install("lark")
    })
    mockInvoke.mockRejectedValueOnce(new Error("dingtalk boom"))
    await act(async () => {
      await result.current.install("dingtalk")
    })
    expect(result.current.errors["lark"]).toContain("lark boom")
    expect(result.current.errors["dingtalk"]).toContain("dingtalk boom")

    // Per-card refresh (the Retry button path) touches only its own error.
    mockInvoke.mockResolvedValue([NOT_INSTALLED])
    await act(async () => {
      await result.current.refresh("lark")
    })
    expect(result.current.errors["lark"]).toBeNull()
    expect(result.current.errors["dingtalk"]).toContain("dingtalk boom")
  })

  it("refresh clears stale flow errors once the user re-checks", async () => {
    mockInvoke.mockResolvedValueOnce([NOT_INSTALLED])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    mockInvoke.mockRejectedValueOnce(new Error("boom"))
    await act(async () => {
      await result.current.install("lark")
    })
    expect(result.current.errors["lark"]).toContain("boom")

    mockInvoke.mockResolvedValue([CONNECTED])
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.errors["lark"]).toBeUndefined()
    expect(result.current.statuses["lark"]).toEqual(CONNECTED)
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
    expect(mockToast.success).toHaveBeenCalledWith("cliConnector.lark.toastConnected")
  })

  it("authorize that completes without a user identity surfaces an explicit error", async () => {
    mockInvoke.mockResolvedValueOnce([NOT_AUTHORIZED])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "start_office_cli_auth") return { device_code: "dc1", verification_uri: "https://v" }
      // Rust accepts authorization_complete then probes: user identity absent.
      if (cmd === "complete_office_cli_auth") return { ...NOT_AUTHORIZED, detail: null }
      throw new Error(`unexpected: ${String(cmd)}`)
    })

    await act(async () => {
      await result.current.authorize("lark")
    })

    // No silent snap-back: a generic explanation lands in errors.
    expect(result.current.errors["lark"]).toBe("cliConnector.authIncomplete")
    expect(mockToast.success).not.toHaveBeenCalled()
    expect(result.current.phases["lark"]).toBe("idle")
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

  // ── DingTalk (dws) specifics ──

  it("dingtalk authorize passes a null deviceCode (the parked child is the flow)", async () => {
    const DT_NOT_AUTH: CliConnectorStatus = {
      id: "dingtalk", state: "not_authorized", path: "/x/dws", version: "1.0.47",
    }
    mockInvoke.mockResolvedValueOnce([DT_NOT_AUTH])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "start_office_cli_auth") {
        // Real dws shape: no device_code, verification URL from the stderr box.
        return {
          device_code: null,
          user_code: "BRPX-DJXX",
          verification_uri:
            "https://login.dingtalk.com/oauth2/device/verify.htm?user_code=BRPX-DJXX",
          expires_in: 900,
          interval: 5,
        }
      }
      if (cmd === "complete_office_cli_auth")
        return { ...DT_NOT_AUTH, state: "connected", detail: "张三 · 某公司" }
      throw new Error(`unexpected: ${String(cmd)}`)
    })

    await act(async () => {
      await result.current.authorize("dingtalk")
    })

    expect(mockOpenUrl).toHaveBeenCalledWith(
      "https://login.dingtalk.com/oauth2/device/verify.htm?user_code=BRPX-DJXX",
    )
    expect(mockInvoke).toHaveBeenLastCalledWith("complete_office_cli_auth", {
      id: "dingtalk",
      deviceCode: null,
      expiresIn: 900,
    })
    expect(result.current.statuses["dingtalk"]?.state).toBe("connected")
    expect(mockToast.success).toHaveBeenCalledWith("cliConnector.dingtalk.toastConnected")
  })

  it("dingtalk not_enabled completion is a guided status, not a flow error", async () => {
    const DT_NOT_AUTH: CliConnectorStatus = {
      id: "dingtalk", state: "not_authorized", path: "/x/dws", version: "1.0.47",
    }
    const DT_NOT_ENABLED: CliConnectorStatus = {
      id: "dingtalk",
      state: "not_enabled",
      path: "/x/dws",
      version: "1.0.47",
      detail:
        "device authorization failed: CLI data access is not enabled for this organization, please contact admin to enable it\n组织主管理员：张三",
      action_url: "https://open-dev.dingtalk.com/fe/old#/developerSettings",
    }
    mockInvoke.mockResolvedValueOnce([DT_NOT_AUTH])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    mockInvoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "start_office_cli_auth")
        return { device_code: null, verification_uri: "https://v?user_code=X", expires_in: 900 }
      if (cmd === "complete_office_cli_auth") return DT_NOT_ENABLED
      throw new Error(`unexpected: ${String(cmd)}`)
    })

    await act(async () => {
      await result.current.authorize("dingtalk")
    })

    // The card renders the amber guidance banner off the status itself — no
    // red flow-error on top, no success toast.
    expect(result.current.statuses["dingtalk"]).toEqual(DT_NOT_ENABLED)
    expect(result.current.errors["dingtalk"] ?? null).toBeNull()
    expect(mockToast.success).not.toHaveBeenCalled()
    expect(result.current.phases["dingtalk"]).toBe("idle")
  })

  it("per-connector generations: a dingtalk flow does not cancel lark's pending flow", async () => {
    mockInvoke.mockResolvedValueOnce([NOT_AUTHORIZED])
    const { result } = renderHook(() => useCliConnectors())
    await waitFor(() => expect(result.current.checking).toBe(false))

    let resolveLark: ((v: unknown) => void) | undefined
    mockInvoke.mockImplementation(async (cmd: unknown, args?: unknown) => {
      const id = (args as { id?: string } | undefined)?.id
      if (cmd === "start_office_cli_auth")
        return { device_code: id === "lark" ? "dc1" : null, verification_uri: "https://v?user_code=X" }
      if (cmd === "complete_office_cli_auth") {
        if (id === "lark") return new Promise((r) => { resolveLark = r })
        return { id: "dingtalk", state: "connected", detail: "钉" }
      }
      throw new Error(`unexpected: ${String(cmd)}`)
    })

    // Start lark's flow (blocks on complete), then run dingtalk's to the end.
    let larkFlow!: Promise<void>
    await act(async () => {
      larkFlow = result.current.authorize("lark")
      await result.current.authorize("dingtalk")
    })
    expect(result.current.statuses["dingtalk"]?.state).toBe("connected")

    // Lark's flow finishes AFTER dingtalk bumped its own generation — it must
    // still land (the old global counter would have swallowed it).
    await act(async () => {
      resolveLark?.(CONNECTED)
      await larkFlow
    })
    expect(result.current.statuses["lark"]).toEqual(CONNECTED)
    expect(result.current.phases["lark"]).toBe("idle")
  })
})
