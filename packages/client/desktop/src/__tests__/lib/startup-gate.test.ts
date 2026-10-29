import { describe, expect, it, vi } from "vitest"
import { DEFAULT_BRAND, resolveIdentity } from "@agent/brand"
import { openStartupGate, type StartupGateDependencies } from "@/lib/startup-gate"

function setup(status: unknown): StartupGateDependencies {
  return {
    native: true,
    status: vi.fn().mockResolvedValue(status),
    ports: vi.fn().mockResolvedValue({}),
    credentials: vi.fn().mockResolvedValue({}),
  }
}

describe("native startup ownership gate", () => {
  it("does not load or create credentials/ports when the host blocks startup", async () => {
    const deps = setup({ state: "blocked", brand: DEFAULT_BRAND, reason: "Another owner is running" })
    expect((await openStartupGate(deps)).state).toBe("blocked")
    expect(deps.ports).not.toHaveBeenCalled()
    expect(deps.credentials).not.toHaveBeenCalled()
  })

  it.each([null, {}, { state: "ready" }, { state: "ready", brand: resolveIdentity({ brandId: "otherwork", productName: "OtherWork" }) }])("blocks malformed or cross-brand responses: %j", async (status) => {
    const deps = setup(status)
    expect((await openStartupGate(deps)).state).toBe("blocked")
    expect(deps.ports).not.toHaveBeenCalled()
    expect(deps.credentials).not.toHaveBeenCalled()
  })

  it("only loads native credentials after ownership is confirmed, using strict loaders", async () => {
    const deps = setup({ state: "ready", brand: DEFAULT_BRAND })
    expect((await openStartupGate(deps)).state).toBe("ready")
    expect(deps.ports).toHaveBeenCalledWith(true)
    expect(deps.credentials).toHaveBeenCalledWith(true)
  })

  it("blocks a failed native credential lookup instead of using browser defaults", async () => {
    const deps = setup({ state: "ready", brand: DEFAULT_BRAND })
    deps.credentials = vi.fn().mockRejectedValue(new Error("Credential ownership lost"))
    expect((await openStartupGate(deps)).state).toBe("blocked")
  })

  it("allows an explicit browser-only context without querying a native host", async () => {
    const deps = setup(null)
    deps.native = false
    expect((await openStartupGate(deps)).state).toBe("ready")
    expect(deps.status).not.toHaveBeenCalled()
    expect(deps.ports).toHaveBeenCalledWith(false)
  })
})
