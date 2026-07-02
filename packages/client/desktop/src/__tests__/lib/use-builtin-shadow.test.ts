import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

const mockInvoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { useBuiltinShadow } from "@/lib/use-builtin-shadow"

const STATUS = {
  bundled: ["ppt-master", "doc-edit"],
  shadowed: ["ppt-master"],
  changed: false,
}

describe("useBuiltinShadow", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it("reconciles on mount and exposes the filesystem shadow status", async () => {
    mockInvoke.mockResolvedValue(STATUS)
    const { result } = renderHook(() => useBuiltinShadow())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockInvoke).toHaveBeenCalledWith("refresh_builtin_skills")
    expect(result.current.status).toEqual(STATUS)
  })

  it("surfaces the changed flag so the owner can chain a soft refresh", async () => {
    const changed = { ...STATUS, changed: true }
    mockInvoke.mockResolvedValue(changed)
    const { result } = renderHook(() => useBuiltinShadow())

    await waitFor(() => expect(result.current.status.changed).toBe(true))
    // reconcile() also RETURNS the fresh status (callers mark it handled).
    let returned: unknown
    await act(async () => {
      returned = await result.current.reconcile()
    })
    expect(returned).toEqual(changed)
  })

  it("degrades to empty lists outside Tauri (invoke rejects)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockRejectedValue(new Error("no bridge"))
    const { result } = renderHook(() => useBuiltinShadow())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status).toEqual({ bundled: [], shadowed: [], changed: false })
    warn.mockRestore()
  })

  it("ignores malformed command results (e2e invoke shims return null)", async () => {
    mockInvoke.mockResolvedValue(null)
    const { result } = renderHook(() => useBuiltinShadow())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status).toEqual({ bundled: [], shadowed: [], changed: false })
  })

  it("removeOverride forwards the name and applies + returns the fresh status", async () => {
    mockInvoke.mockResolvedValue(STATUS)
    const { result } = renderHook(() => useBuiltinShadow())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const restored = { bundled: STATUS.bundled, shadowed: [], changed: true }
    mockInvoke.mockResolvedValue(restored)
    let returned: unknown
    await act(async () => {
      returned = await result.current.removeOverride("ppt-master")
    })

    expect(mockInvoke).toHaveBeenLastCalledWith("remove_user_skill_override", { name: "ppt-master" })
    expect(result.current.status).toEqual(restored)
    expect(returned).toEqual(restored)
  })

  it("removeOverride rejects a malformed result instead of faking success", async () => {
    mockInvoke.mockResolvedValue(STATUS)
    const { result } = renderHook(() => useBuiltinShadow())
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockInvoke.mockResolvedValue(null)
    await expect(result.current.removeOverride("ppt-master")).rejects.toThrow("malformed")
    // Status untouched — a success toast over a stale card is impossible.
    expect(result.current.status).toEqual(STATUS)
  })

  it("removeOverride propagates failures (caller shows the error toast)", async () => {
    mockInvoke.mockResolvedValue(STATUS)
    const { result } = renderHook(() => useBuiltinShadow())
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockInvoke.mockRejectedValue(new Error("not shadowed"))
    await expect(result.current.removeOverride("doc-edit")).rejects.toThrow("not shadowed")
    // Status is untouched on failure.
    expect(result.current.status).toEqual(STATUS)
  })
})
