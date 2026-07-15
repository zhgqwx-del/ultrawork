import { describe, it, expect } from "vitest"
import type { Provider, ProviderModel } from "@agent/api-client"
import {
  orderedFreeCandidates,
  isFreeZenModel,
  shouldOfferFreeTrial,
  isZenModelId,
  classifyZenError,
  nextFreeCandidate,
  FREE_MODEL_PREFERENCE,
  OPENCODE_ZEN_PROVIDER_ID,
} from "@/lib/free-model"

// Minimal ProviderModel factory: only the fields free-model.ts reads.
function model(id: string, costInput?: number): ProviderModel {
  return { id, name: id, cost: costInput === undefined ? undefined : { input: costInput } }
}

function zenProvider(models: ProviderModel[], connected: string[]): Provider {
  return {
    id: OPENCODE_ZEN_PROVIDER_ID,
    name: "OpenCode Zen",
    models,
    connected,
  }
}

describe("orderedFreeCandidates", () => {
  it("returns empty when the opencode provider is absent", () => {
    const anthropic: Provider = { id: "anthropic", name: "Anthropic", models: [model("claude", 3)], connected: [] }
    expect(orderedFreeCandidates([anthropic])).toEqual([])
  })

  it("orders preference-list models best-first", () => {
    // Connected order deliberately scrambled vs the preference order.
    const providers = [
      zenProvider(
        [model("hy3-free", 0), model("big-pickle", 0), model("nemotron-3-ultra-free", 0)],
        ["hy3-free", "big-pickle", "nemotron-3-ultra-free"],
      ),
    ]
    expect(orderedFreeCandidates(providers).map((c) => c.modelID)).toEqual([
      "big-pickle",
      "nemotron-3-ultra-free",
      "hy3-free",
    ])
  })

  it("appends connected free models not in the preference list, after preferred ones", () => {
    const providers = [
      zenProvider(
        [model("some-new-free", 0), model("big-pickle", 0)],
        ["some-new-free", "big-pickle"],
      ),
    ]
    // big-pickle (preferred) first, then the drift-in unknown free model.
    expect(orderedFreeCandidates(providers).map((c) => c.modelID)).toEqual(["big-pickle", "some-new-free"])
  })

  it("excludes paid models even if connected (has-key case)", () => {
    // With a key, opencode connects paid models too — those must never be seeded as "free".
    const providers = [
      zenProvider(
        [model("big-pickle", 0), model("claude-opus-4-8", 15)],
        ["big-pickle", "claude-opus-4-8"],
      ),
    ]
    expect(orderedFreeCandidates(providers).map((c) => c.modelID)).toEqual(["big-pickle"])
  })

  it("excludes models with unknown (missing) cost — not confirmed free", () => {
    const providers = [zenProvider([model("mystery")], ["mystery"])]
    expect(orderedFreeCandidates(providers)).toEqual([])
  })

  it("returns empty when opencode has no connected free models", () => {
    const providers = [zenProvider([model("big-pickle", 0)], [])]
    expect(orderedFreeCandidates(providers)).toEqual([])
  })

  it("stamps every candidate with the opencode provider id", () => {
    const providers = [zenProvider([model("big-pickle", 0)], ["big-pickle"])]
    expect(orderedFreeCandidates(providers)).toEqual([
      { providerID: OPENCODE_ZEN_PROVIDER_ID, modelID: "big-pickle" },
    ])
  })
})

describe("isFreeZenModel", () => {
  it("is true only for input cost exactly 0", () => {
    expect(isFreeZenModel(model("x", 0))).toBe(true)
    expect(isFreeZenModel(model("x", 0.5))).toBe(false)
    expect(isFreeZenModel(model("x"))).toBe(false)
    expect(isFreeZenModel(undefined)).toBe(false)
  })
})

describe("shouldOfferFreeTrial", () => {
  const freshInstall = [zenProvider([model("big-pickle", 0)], ["big-pickle"])]

  it("offers on a fresh install (only free zen connected, no model, no consent)", () => {
    expect(shouldOfferFreeTrial(freshInstall, "", false)).toBe(true)
  })

  it("does not offer when a model is already selected", () => {
    expect(shouldOfferFreeTrial(freshInstall, "opencode/big-pickle", false)).toBe(false)
  })

  it("does not offer once consented", () => {
    expect(shouldOfferFreeTrial(freshInstall, "", true)).toBe(false)
  })

  it("does not offer when no free zen model is connected", () => {
    const noFree = [zenProvider([model("big-pickle", 0)], [])]
    expect(shouldOfferFreeTrial(noFree, "", false)).toBe(false)
  })

  it("does not offer when the user has a real (non-free) provider connected", () => {
    const withKey = [
      zenProvider([model("big-pickle", 0)], ["big-pickle"]),
      { id: "anthropic", name: "Anthropic", models: [model("claude-sonnet-5", 3)], connected: ["claude-sonnet-5"] },
    ]
    expect(shouldOfferFreeTrial(withKey, "", false)).toBe(false)
  })

  it("does not offer when opencode has a paid model connected (user added a Zen key)", () => {
    const zenWithKey = [
      zenProvider([model("big-pickle", 0), model("claude-opus-4-8", 15)], ["big-pickle", "claude-opus-4-8"]),
    ]
    expect(shouldOfferFreeTrial(zenWithKey, "", false)).toBe(false)
  })
})

describe("isZenModelId", () => {
  it("recognizes opencode-prefixed ids only", () => {
    expect(isZenModelId("opencode/big-pickle")).toBe(true)
    expect(isZenModelId("anthropic/claude-sonnet-5")).toBe(false)
    expect(isZenModelId("")).toBe(false)
  })
})

describe("classifyZenError", () => {
  it("classifies quota errors", () => {
    expect(classifyZenError("FreeUsageLimitError")).toBe("quota")
    expect(classifyZenError("Free usage exceeded, subscribe to Go")).toBe("quota")
  })
  it("classifies auth/availability errors", () => {
    expect(classifyZenError("Missing API key.")).toBe("auth")
    expect(classifyZenError("AuthError")).toBe("auth")
    expect(classifyZenError("No provider available")).toBe("auth")
    expect(classifyZenError("Request failed with status 401")).toBe("auth")
  })
  it("classifies everything else as other", () => {
    expect(classifyZenError("context length exceeded")).toBe("other")
    expect(classifyZenError(undefined)).toBe("other")
    expect(classifyZenError("")).toBe("other")
  })
})

describe("nextFreeCandidate", () => {
  const providers = [
    zenProvider(
      [model("big-pickle", 0), model("deepseek-v4-flash-free", 0), model("hy3-free", 0)],
      ["big-pickle", "deepseek-v4-flash-free", "hy3-free"],
    ),
  ]

  it("returns the next candidate after the current model", () => {
    expect(nextFreeCandidate(providers, "opencode/big-pickle")?.modelID).toBe("deepseek-v4-flash-free")
    expect(nextFreeCandidate(providers, "opencode/deepseek-v4-flash-free")?.modelID).toBe("hy3-free")
  })

  it("returns null when the current model is the last candidate", () => {
    expect(nextFreeCandidate(providers, "opencode/hy3-free")).toBeNull()
  })

  it("starts from the top for an unknown current id", () => {
    expect(nextFreeCandidate(providers, "opencode/unknown")?.modelID).toBe("big-pickle")
  })

  it("returns null when there are no candidates", () => {
    expect(nextFreeCandidate([], "opencode/big-pickle")).toBeNull()
  })
})

describe("FREE_MODEL_PREFERENCE", () => {
  it("has no duplicates", () => {
    expect(new Set(FREE_MODEL_PREFERENCE).size).toBe(FREE_MODEL_PREFERENCE.length)
  })
})
