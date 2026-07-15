/**
 * Which input modalities the currently-selected model accepts.
 *
 * Gate on `capabilities.input.image` / `.pdf` and nothing else: vendor
 * `provider/transform.ts` checks exactly those before handing a file part to the model,
 * and when they're false it silently swaps the attachment for
 * "ERROR: Cannot read <file> (this model does not support image input)" — so an ungated
 * send doesn't fail, it makes the model apologise for something the user can't see.
 * (`capabilities.attachment` is a coarser, different flag. Do not gate on it.)
 *
 * `GET /provider` is ~4 MB (the whole models.dev catalogue), so this is loaded lazily —
 * only when the user actually attaches something — and cached for the app session.
 */

import type { ApiClient, Provider } from "@agent/api-client"

export interface ModelInputSupport {
  image: boolean
  pdf: boolean
}

let cache: Promise<Provider[]> | null = null

function loadProviders(api: ApiClient): Promise<Provider[]> {
  if (!cache) {
    cache = api.getProviders().catch((err) => {
      cache = null // don't cache a failure — the sidecar may just have been booting
      throw err
    })
  }
  return cache
}

/** Call after the user edits provider/model config, so the next gate check refetches. */
export function invalidateModelCapabilities(): void {
  cache = null
}

function supportOf(providers: Provider[], modelKey: string): ModelInputSupport | null {
  const slash = modelKey.indexOf("/")
  if (slash <= 0) return null
  const providerId = modelKey.slice(0, slash)
  const modelId = modelKey.slice(slash + 1)
  const model = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId)
  if (!model) return null
  const input = model.capabilities?.input
  return { image: Boolean(input?.image), pdf: Boolean(input?.pdf) }
}

/**
 * Modalities the given "providerID/modelID" accepts.
 *
 * Returns null when the model isn't in the catalogue (a hand-rolled custom model, say).
 * Callers must treat null as "unknown, let it through" rather than "unsupported": blocking
 * a user's own custom vision model because we couldn't find it in a list would be worse
 * than letting the server have the last word.
 */
export async function modelInputSupport(
  api: ApiClient,
  modelKey: string | null | undefined,
): Promise<ModelInputSupport | null> {
  if (!modelKey) return null
  const providers = await loadProviders(api)
  return supportOf(providers, modelKey)
}

/** Up to `limit` connected models that accept images — for "switch to one of these". */
export async function imageCapableModels(api: ApiClient, limit = 3): Promise<string[]> {
  const providers = await loadProviders(api).catch(() => [] as Provider[])
  const out: string[] = []
  for (const p of providers) {
    // Only suggest models the user can actually reach right now.
    const reachable = new Set(p.connected)
    for (const m of p.models) {
      if (!reachable.has(m.id)) continue
      if (!m.capabilities?.input?.image) continue
      out.push(`${p.id}/${m.id}`)
      if (out.length >= limit) return out
    }
  }
  return out
}
