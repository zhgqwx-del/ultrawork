import { describe, it, expect, vi, beforeEach } from "vitest"
import { modelInputSupport, imageCapableModels, invalidateModelCapabilities } from "@/lib/model-capabilities"
import type { ApiClient, Provider } from "@agent/api-client"

/**
 * The gate MUST read capabilities.input.image / .pdf — the same field vendor
 * transform.ts checks. It must NOT read capabilities.attachment, which is a coarser flag
 * that says nothing about which modality the model can actually see (discussions/039 §3.1).
 */
const providers: Provider[] = [
  {
    id: "myqwen",
    name: "MyQwen",
    connected: ["qwen3.7-max"],
    models: [
      {
        id: "qwen3.7-max",
        name: "Qwen 3.7 Max",
        // The trap: attachment=true but no image input. Gating on `attachment` would let
        // an image through and the model would apologise for a file it never saw.
        capabilities: { attachment: true, input: { text: true, image: false, pdf: false } },
      },
    ],
  },
  {
    id: "alibaba-cn",
    name: "Alibaba",
    connected: ["qwen3.7-plus", "qwen-text-only"],
    models: [
      {
        id: "qwen3.7-plus",
        name: "Qwen 3.7 Plus",
        capabilities: { attachment: true, input: { text: true, image: true, pdf: true } },
      },
      {
        id: "qwen-text-only",
        name: "Text only",
        capabilities: { input: { text: true, image: false } },
      },
    ],
  },
  {
    id: "offline",
    name: "Not connected",
    connected: [], // no credentials — must never be suggested
    models: [
      { id: "vision-x", name: "Vision X", capabilities: { input: { text: true, image: true } } },
    ],
  },
]

const api = { getProviders: vi.fn(async () => providers) } as unknown as ApiClient

beforeEach(() => {
  invalidateModelCapabilities()
  vi.mocked(api.getProviders).mockClear()
})

describe("modelInputSupport", () => {
  it("reports image:false for a model whose input.image is false, even when attachment=true", () => {
    return expect(modelInputSupport(api, "myqwen/qwen3.7-max")).resolves.toEqual({ image: false, pdf: false })
  })

  it("reports image+pdf for a vision model", () => {
    return expect(modelInputSupport(api, "alibaba-cn/qwen3.7-plus")).resolves.toEqual({ image: true, pdf: true })
  })

  it("returns null for an unknown model so the server, not us, has the last word", () => {
    // A hand-rolled custom model isn't in the catalogue. Blocking it would be worse than
    // letting the send through and surfacing whatever the server says.
    return expect(modelInputSupport(api, "custom/whatever")).resolves.toBeNull()
  })

  it("returns null when no model is selected", () => {
    return expect(modelInputSupport(api, null)).resolves.toBeNull()
  })

  it("fetches the 4 MB provider catalogue at most once", async () => {
    await modelInputSupport(api, "myqwen/qwen3.7-max")
    await modelInputSupport(api, "alibaba-cn/qwen3.7-plus")
    expect(api.getProviders).toHaveBeenCalledTimes(1)
  })
})

describe("imageCapableModels", () => {
  it("suggests only connected models that actually accept images", async () => {
    const suggestions = await imageCapableModels(api)
    expect(suggestions).toEqual(["alibaba-cn/qwen3.7-plus"])
    // Not the text-only one, and not the vision model behind a provider with no credentials.
    expect(suggestions).not.toContain("offline/vision-x")
    expect(suggestions).not.toContain("alibaba-cn/qwen-text-only")
  })
})
