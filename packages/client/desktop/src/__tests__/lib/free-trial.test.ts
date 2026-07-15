import { describe, it, expect, vi } from "vitest"
import type { OpenCodeConfig } from "@agent/api-client"
import {
  enableFreeTrial,
  revokeFreeTrial,
  candidateModelString,
  type FreeTrialDeps,
  type FreeTrialConsentState,
} from "@/lib/free-trial"

function makeDeps(overrides: {
  config?: OpenCodeConfig
  consent?: FreeTrialConsentState
}): FreeTrialDeps & {
  patched: Partial<OpenCodeConfig>[]
  setCalls: Array<[string | undefined, string | undefined]>
  clearCalls: number
} {
  const patched: Partial<OpenCodeConfig>[] = []
  const setCalls: Array<[string | undefined, string | undefined]> = []
  let clearCalls = 0
  return {
    patched,
    setCalls,
    get clearCalls() {
      return clearCalls
    },
    patchGlobalConfig: vi.fn(async (u: Partial<OpenCodeConfig>) => {
      patched.push(u)
      return {}
    }),
    getGlobalConfig: vi.fn(async () => overrides.config ?? {}),
    getConsent: vi.fn(async () => overrides.consent ?? { consented: false }),
    setConsent: vi.fn(async (m: string | undefined, s: string | undefined) => {
      setCalls.push([m, s])
    }),
    clearConsent: vi.fn(async () => {
      clearCalls++
    }),
  }
}

describe("candidateModelString", () => {
  it("joins provider and model", () => {
    expect(candidateModelString({ providerID: "opencode", modelID: "big-pickle" })).toBe("opencode/big-pickle")
  })
})

describe("enableFreeTrial", () => {
  it("seeds both model and small_model, and records consent with the seeded value", async () => {
    const deps = makeDeps({})
    const seeded = await enableFreeTrial(deps, { providerID: "opencode", modelID: "big-pickle" })

    expect(seeded).toBe("opencode/big-pickle")
    expect(deps.patched).toEqual([{ model: "opencode/big-pickle", small_model: "opencode/big-pickle" }])
    expect(deps.setCalls).toEqual([["opencode/big-pickle", "opencode/big-pickle"]])
  })
})

describe("revokeFreeTrial (with protection)", () => {
  it("clears model and small_model when they still equal the seeded values", async () => {
    const deps = makeDeps({
      config: { model: "opencode/big-pickle", small_model: "opencode/big-pickle" },
      consent: { consented: true, seededModel: "opencode/big-pickle", seededSmallModel: "opencode/big-pickle" },
    })
    await revokeFreeTrial(deps)

    expect(deps.patched).toEqual([{ model: "", small_model: "" }])
    expect(deps.clearCalls).toBe(1)
  })

  it("does NOT clobber a model the user has since chosen", async () => {
    // User enabled trial (seeded big-pickle), later added a key and picked their own model.
    const deps = makeDeps({
      config: { model: "anthropic/claude-sonnet-5", small_model: "opencode/big-pickle" },
      consent: { consented: true, seededModel: "opencode/big-pickle", seededSmallModel: "opencode/big-pickle" },
    })
    await revokeFreeTrial(deps)

    // model left untouched; only the still-ours small_model cleared.
    expect(deps.patched).toEqual([{ small_model: "" }])
    expect(deps.clearCalls).toBe(1)
  })

  it("patches nothing when neither field is still ours, but still clears the flag", async () => {
    const deps = makeDeps({
      config: { model: "anthropic/claude-sonnet-5", small_model: "anthropic/claude-haiku-4-5" },
      consent: { consented: true, seededModel: "opencode/big-pickle", seededSmallModel: "opencode/big-pickle" },
    })
    await revokeFreeTrial(deps)

    expect(deps.patched).toEqual([])
    expect(deps.clearCalls).toBe(1)
  })

  it("patches nothing when there were no seeded values recorded", async () => {
    const deps = makeDeps({
      config: { model: "opencode/big-pickle" },
      consent: { consented: true }, // no seededModel recorded
    })
    await revokeFreeTrial(deps)

    expect(deps.patched).toEqual([])
    expect(deps.clearCalls).toBe(1)
  })
})
