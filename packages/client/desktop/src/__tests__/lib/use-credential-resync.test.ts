// A stale cached sidecar password locks the app out permanently, and the symptom
// — a disconnected banner whose retry never works — is indistinguishable from the
// reconnect bug ADR-071 fixes. So the recovery has to exist; but it rewrites the
// user's stored credentials, so it also has to stay narrow.
//
// These tests spend most of their weight on the cases where it must NOT fire.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

const invoke = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke }))

const state = vi.hoisted(() => ({
  config: { apiBaseUrl: "auto", apiUsername: "opencode", apiPassword: "stale" } as Record<string, string>,
  updateConfig: vi.fn(),
}))
vi.mock("@/lib/config-context", () => ({
  useConfig: () => ({ config: state.config, updateConfig: state.updateConfig }),
}))

import { useCredentialResync } from "@/lib/use-credential-resync"
import type { BackendLiveness } from "@/lib/use-backend-liveness"

function run(liveness: BackendLiveness) {
  return renderHook(({ l }: { l: BackendLiveness }) => useCredentialResync(l), {
    initialProps: { l: liveness },
  })
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ username: "opencode", password: "fresh" })
  state.updateConfig.mockReset()
  state.config = { apiBaseUrl: "auto", apiUsername: "opencode", apiPassword: "stale" }
})

describe("useCredentialResync — when it fires", () => {
  it("re-reads the host password on a 401 and adopts it", async () => {
    run("unauthorized")
    await waitFor(() =>
      expect(state.updateConfig).toHaveBeenCalledWith({
        apiPassword: "fresh",
        apiUsername: "opencode",
      }),
    )
  })
})

describe("useCredentialResync — when it must NOT fire", () => {
  it("ignores an ordinary disconnect", async () => {
    // A dropped socket says nothing about credentials. Re-reading them on every
    // disconnect would be noise at best.
    for (const l of ["absent", "listening", "unknown"] as BackendLiveness[]) {
      run(l)
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(invoke).not.toHaveBeenCalled()
    expect(state.updateConfig).not.toHaveBeenCalled()
  })

  it("leaves a user-configured endpoint alone", async () => {
    // Settings lets you point the app at your own opencode. Those credentials are
    // the user's, and silently replacing them with the LOCAL sidecar's would
    // destroy a deliberate configuration to fix a problem they do not have.
    state.config = {
      apiBaseUrl: "http://my-server:4096",
      apiUsername: "me",
      apiPassword: "mine",
    }
    run("unauthorized")
    await new Promise((r) => setTimeout(r, 50))
    expect(invoke).not.toHaveBeenCalled()
    expect(state.updateConfig).not.toHaveBeenCalled()
  })

  it("does not write back a password identical to the one it already has", async () => {
    // The host agrees with us, so the 401 is about something else. Writing it
    // back would rebuild the connector for no reason.
    invoke.mockResolvedValue({ username: "opencode", password: "stale" })
    run("unauthorized")
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(state.updateConfig).not.toHaveBeenCalled()
  })

  it("asks the host only once per password, however long the 401 persists", async () => {
    // The probe re-fires every 10s while disconnected; without the guard this
    // would re-invoke the host forever.
    const { rerender } = run("unauthorized")
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    rerender({ l: "listening" })
    rerender({ l: "unauthorized" })
    await new Promise((r) => setTimeout(r, 50))
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("survives a host that answers nothing usable", async () => {
    for (const bad of [null, {}, { password: "" }, { password: 42 }]) {
      invoke.mockReset().mockResolvedValue(bad)
      state.config = { ...state.config, apiPassword: `p${String(bad)}` }
      run("unauthorized")
      await waitFor(() => expect(invoke).toHaveBeenCalled())
    }
    expect(state.updateConfig).not.toHaveBeenCalled()
  })

  it("survives the host command failing outright", async () => {
    invoke.mockReset().mockRejectedValue(new Error("not in tauri"))
    run("unauthorized")
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(state.updateConfig).not.toHaveBeenCalled()
  })
})
