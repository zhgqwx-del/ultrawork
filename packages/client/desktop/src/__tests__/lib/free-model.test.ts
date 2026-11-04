import { describe, it, expect } from "vitest"
import type { Provider, ProviderModel } from "@agent/api-client"
import {
  orderedFreeCandidates,
  isFreeZenModel,
  shouldOfferFreeTrial,
  isZenModelId,
  classifyZenError,
  nextFreeCandidate,
  zenRetryAt,
  FREE_MODEL_PREFERENCE,
  OPENCODE_ZEN_PROVIDER_ID,
} from "@/lib/free-model"

// Minimal ProviderModel factory: only the fields free-model.ts reads.
function model(id: string, costInput?: number): ProviderModel {
  return { id, name: id, cost: costInput === undefined ? undefined : { input: costInput, output: 0 }, capabilities: { toolcall: true } }
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
        [model("glm-5.3-flash-free", 0), model("big-pickle", 0), model("mimo-v2.6-flash-free", 0)],
        ["glm-5.3-flash-free", "big-pickle", "mimo-v2.6-flash-free"],
      ),
    ]
    expect(orderedFreeCandidates(providers).map((c) => c.modelID)).toEqual([
      "big-pickle",
      "mimo-v2.6-flash-free",
      "glm-5.3-flash-free",
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
  it("is true only for confirmed zero input and output costs", () => {
    expect(isFreeZenModel(model("x", 0))).toBe(true)
    expect(isFreeZenModel(model("x", 0.5))).toBe(false)
    expect(isFreeZenModel(model("x"))).toBe(false)
    expect(isFreeZenModel(undefined)).toBe(false)
    expect(isFreeZenModel({ id: "x", name: "x", cost: { input: 0 } })).toBe(false)
    expect(isFreeZenModel({ id: "x", name: "x", cost: { input: 0, output: 1 } })).toBe(false)
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


describe("free candidate constraints", () => {
  it("excludes deprecated models and unconfirmed tool support, without excluding new models", () => {
    const deprecated = { ...model("retired", 0), status: "deprecated" as const }
    const noTools = { ...model("no-tools", 0), capabilities: { toolcall: false } }
    const unknownTools = { ...model("unknown-tools", 0), capabilities: undefined }
    const outputPaid = { ...model("output-paid", 0), cost: { input: 0, output: 0.1 } }
    const eligible = model("new-free", 0)
    const models = [deprecated, noTools, unknownTools, outputPaid, eligible]
    expect(orderedFreeCandidates([zenProvider(models, models.map((m) => m.id))])).toEqual([
      { providerID: "opencode", modelID: "new-free" },
    ])
  })

  it("does not repeat candidates after catalog reordering or removal of the failed model", () => {
    const providers = [zenProvider([model("new-free", 0), model("big-pickle", 0)], ["new-free", "big-pickle", "big-pickle"])]
    expect(nextFreeCandidate(providers, "opencode/removed-free", ["opencode/big-pickle", "opencode/removed-free"])).toEqual({ providerID: "opencode", modelID: "new-free" })
    expect(nextFreeCandidate(providers, "opencode/removed-free", ["opencode/big-pickle", "opencode/new-free"])).toBeNull()
    expect(orderedFreeCandidates(providers)).toHaveLength(2)
  })
})

describe("structured Zen errors", () => {
  const apiError = (statusCode: number, body: unknown, message = "Request failed") => ({
    name: "APIError", data: { statusCode, message, responseBody: JSON.stringify(body) },
  })
  it("uses the structured type rather than a quoted free-limit name in an ordinary error", () => {
    expect(classifyZenError(apiError(503, { error: { type: "server_error", message: "Example type: FreeUsageLimitError" } }))).toBe("other")
    expect(classifyZenError({ name: "UnknownError", data: { message: "ProviderModelNotFoundError" } })).toBe("unavailable")
  })

  it("recognizes free access restrictions behind a generic 429 message", () => {
    expect(classifyZenError(apiError(429, { error: { type: "FreeUsageLimitError", message: "Free usage limit reached" } }, "Too Many Requests"))).toBe("quota")
    expect(classifyZenError(apiError(403, { error: { type: "FreeTierError", message: "Only available in OpenCode" } }))).toBe("quota")
    expect(classifyZenError("Free usage limit reached. Free models work in OpenCode.")).toBe("quota")
    expect(classifyZenError({ error: { type: "FreeUsageLimitError" } })).toBe("quota")
  })

  it("distinguishes unavailable models from ordinary 400s and transient 429s", () => {
    expect(classifyZenError(apiError(400, { error: { type: "server_error", message: "Upstream request failed: Model is unavailable." } }))).toBe("unavailable")
    expect(classifyZenError(apiError(404, { error: { type: "model_not_found" } }))).toBe("unavailable")
    expect(classifyZenError(apiError(400, { error: { message: "Invalid model parameter: max_tokens" } }))).toBe("other")
    expect(classifyZenError(apiError(400, { error: { message: "Input data may contain inappropriate content" } }))).toBe("other")
    expect(classifyZenError(apiError(429, { error: { type: "server_error", message: "Rate limit exceeded" } }))).toBe("other")
    expect(classifyZenError(apiError(401, { error: { message: "Invalid credential" } }))).toBe("auth")
  })

  it("tolerates invalid or absent error bodies", () => {
    expect(classifyZenError({ name: "APIError", data: { responseBody: "<html>bad gateway</html>" } })).toBe("other")
    expect(classifyZenError(null)).toBe("other")
    expect(classifyZenError(429)).toBe("other")
  })
})

describe("zenRetryAt", () => {
  const now = Date.UTC(2026, 10, 3, 4)
  const withHeaders = (responseHeaders: Record<string, string>) => ({ data: { responseHeaders } })
  it("keeps long suggested waits and accepts milliseconds, seconds and HTTP dates", () => {
    expect(zenRetryAt(withHeaders({ "retry-after": "69553" }), now)).toBe(now + 69_553_000)
    expect(zenRetryAt(withHeaders({ "Retry-After-Ms": "1500", "retry-after": "3" }), now)).toBe(now + 1500)
    const later = now + 60_000
    expect(zenRetryAt(withHeaders({ "retry-after": new Date(later).toUTCString() }), now)).toBe(later)
  })
  it("rejects invalid, negative and past suggestions", () => {
    for (const value of ["", "-1", "Infinity", "garbage", new Date(now - 1000).toUTCString()]) {
      expect(zenRetryAt(withHeaders({ "retry-after": value }), now)).toBeUndefined()
    }
    expect(zenRetryAt(undefined, now)).toBeUndefined()
  })
})
