/**
 * Free OpenCode Zen model selection for the first-run "free trial" entry point (ADR-057).
 *
 * Background (docs/discussions/040): the vendor `opencode` provider (OpenCode Zen gateway)
 * auto-loads its free models with an anonymous `apiKey: "public"` when the user has no key
 * (`vendor/.../provider/provider.ts:178-198` strips paid models, keeps `cost.input === 0`).
 * So on a fresh install `GET /provider` already lists these free models as *connected* — we
 * can pick a candidate to seed as the default (after explicit consent; see model-context).
 *
 * Two hard facts drive the design here:
 *  1. "Listed" ≠ "anonymously usable": the connected free set is a *superset* of what the
 *     live gateway actually serves anonymously (e.g. `mimo-v2.5-free` is listed but 401s;
 *     `gpt-5-nano` too). So we never trust a single id — we return an *ordered candidate
 *     list* and let the caller handle actual authentication/availability failures (ADR-057 P4).
 *  2. The free set drifts (models.dev refreshes at runtime; models get deprecated/rotated).
 *     So the preference list is only an *ordering hint*, never a whitelist: any connected
 *     free model not in the preference list is still appended as a lower-priority candidate.
 *
 * This module is pure (no network, no React) so it can be unit-tested in isolation.
 */

import type { Provider, ProviderModel } from "@agent/api-client"

/** The provider id under which OpenCode Zen models are registered (not the string "zen"). */
export const OPENCODE_ZEN_PROVIDER_ID = "opencode"

/**
 * Preferred free Zen models, best-first, aligned with the current official catalog.
 * This is a sorting hint, not proof of anonymous access or a whitelist. Unknown connected
 * free models are still candidates; actual requests determine their availability.
 */
export const FREE_MODEL_PREFERENCE: readonly string[] = [
  "big-pickle",
  "mimo-v2.6-flash-free",
  "deepseek-v4.1-flash-free",
  "nemotron-3.5-lightning-free",
  "glm-5.3-flash-free",
]

export interface FreeCandidate {
  /** Always `OPENCODE_ZEN_PROVIDER_ID`; kept explicit so callers build `provider/model` ids uniformly. */
  providerID: string
  modelID: string
}

/**
 * A model counts as free only when both input and output costs are exactly 0. This matters
 * in the *has-key* case: once the user adds an OpenCode key, the `opencode` provider's
 * `connected` list also includes paid models — we must never seed one of those as a "free
 * trial". A missing `cost` is treated as "not confirmed free" and excluded (conservative:
 * better to skip than to silently seed a billable model).
 */
export function isFreeZenModel(model: ProviderModel | undefined): boolean {
  return model?.cost?.input === 0 && model.cost.output === 0
}

/**
 * Ordered list of free Zen candidates to try seeding as the default model, best-first.
 *
 * @param providers the flattened `GET /provider` response
 * @returns `[{providerID:"opencode", modelID}, ...]`; empty when no free Zen model is connected
 */
export function orderedFreeCandidates(providers: Provider[]): FreeCandidate[] {
  const zen = providers.find((p) => p.id === OPENCODE_ZEN_PROVIDER_ID)
  if (!zen) return []

  // Agent candidates must also have confirmed tool support and remain in the active catalog.
  const freeConnected = [...new Set(zen.connected)].filter((modelId) => {
    const model = zen.models.find((m) => m.id === modelId)
    return isFreeZenModel(model) && model?.status !== "deprecated" && model?.capabilities?.toolcall === true
  })

  const inPreference = FREE_MODEL_PREFERENCE.filter((id) => freeConnected.includes(id))
  const rest = freeConnected.filter((id) => !FREE_MODEL_PREFERENCE.includes(id))

  return [...inPreference, ...rest].map((modelID) => ({
    providerID: OPENCODE_ZEN_PROVIDER_ID,
    modelID,
  }))
}

/**
 * Whether the first-run free-trial consent card should be offered *instead of* dispatching a
 * message. True only in the fresh-install shape:
 *   - no model is currently selected, and
 *   - the user has not already consented, and
 *   - free Zen candidates exist, and
 *   - there is NO other usable connected model.
 *
 * The last clause is what keeps the card from popping for a user who configured their own key:
 * if any non-free model is connected, opencode's server-side default resolution
 * (`provider.ts:1582-1610`, sort priority `gpt-5 > claude-sonnet-4 > big-pickle > …`) will pick
 * *that* over a free Zen model, so dispatching an empty-model message is safe (no free-model
 * leak) and a "free trial" card would be wrong.
 *
 * Caveat: a provider that auto-connects without being usable (e.g. `amazon-bedrock` without AWS
 * creds) would be counted as a "non-free connected" option and suppress the card. Empirically
 * (docs/discussions/040, fresh sidecar) bedrock does NOT appear in the fresh-install connected
 * set — only `opencode` does — so this does not arise in practice; documented as a known edge.
 */
export function shouldOfferFreeTrial(
  providers: Provider[],
  currentModel: string,
  consented: boolean,
): boolean {
  if (currentModel) return false
  if (consented) return false
  if (orderedFreeCandidates(providers).length === 0) return false

  const hasUsableNonFreeModel = providers.some((p) =>
    p.connected.some((modelId) => {
      // A connected opencode model that is NOT free means the user added a Zen key (paid models
      // appear). Any connected model from a different provider is likewise a real, chosen option.
      if (p.id === OPENCODE_ZEN_PROVIDER_ID) {
        return !isFreeZenModel(p.models.find((m) => m.id === modelId))
      }
      return true
    }),
  )
  return !hasUsableNonFreeModel
}

/** Whether a `provider/model` id refers to the OpenCode Zen provider (free-trial models live here). */
export function isZenModelId(modelId: string): boolean {
  return modelId.startsWith(`${OPENCODE_ZEN_PROVIDER_ID}/`)
}

export type ZenErrorKind = "quota" | "auth" | "unavailable" | "other"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function errorData(error: unknown) {
  const outer = record(error)
  const data = record(outer?.data) ?? outer
  let body: unknown = data?.responseBody
  if (typeof body === "string") {
    try { body = JSON.parse(body) } catch { /* The original message remains available. */ }
  }
  const parsed = record(body)
  const remote = record(parsed?.error) ?? parsed ?? record(outer?.error)
  const text = [error, outer?.name, outer?.message, data?.message, data?.type, remote?.type, remote?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
  const status = data?.statusCode ?? outer?.status
  return { text, status, type: typeof remote?.type === "string" ? remote.type : undefined, headers: record(data?.responseHeaders) }
}

/**
 * Read the structured APIError, including the gateway's JSON responseBody. The display message
 * alone can be just "Too Many Requests", while the body identifies a free-access restriction.
 * `quota` covers that restriction as well as allowance limits; it never promises a reset time.
 * Ordinary transient 429s and parameter/context errors stay `other` rather than changing models.
 */
export function classifyZenError(error: unknown): ZenErrorKind {
  const { text, status, type } = errorData(error)
  if (type === "FreeUsageLimitError" || type === "FreeTierError" ||
    (!type && /freeusagelimiterror|freetiererror|free usage (?:exceeded|limit)|free[- ]tier (?:limit|restrict)/.test(text))) return "quota"
  if (/providermodelnotfounderror|model[ _-](?:not[ _-]found|unavailable)|model (?:is |was )?(?:unavailable|not available|not found)|unknown model/.test(text)) return "unavailable"
  if (status === 401 || /missing api key|autherror|unauthorized|\b401\b|no provider available/.test(text)) return "auth"
  return "other"
}

/** Suggested retry time from the server, not a guarantee that free access will resume. */
export function zenRetryAt(error: unknown, nowMs = Date.now()): number | undefined {
  const { headers } = errorData(error)
  if (!headers) return undefined
  const values = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  const milliseconds = values.get("retry-after-ms")
  const seconds = values.get("retry-after")
  const numeric = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }
  const ms = numeric(milliseconds)
  if (ms !== undefined) return nowMs + ms
  const sec = numeric(seconds)
  if (sec !== undefined) return nowMs + sec * 1000
  if (typeof seconds !== "string") return undefined
  const timestamp = Date.parse(seconds)
  return Number.isFinite(timestamp) && timestamp >= nowMs ? timestamp : undefined
}

/**
 * Pick a connected free model that this turn has not attempted. A caller passing its full
 * attempt history is safe against catalog reordering/removal; the two-argument form retains
 * the historical "next after current" behavior.
 */
export function nextFreeCandidate(
  providers: Provider[],
  currentModelId: string,
  attemptedModels?: readonly string[],
): FreeCandidate | null {
  const candidates = orderedFreeCandidates(providers)
  if (attemptedModels) {
    const attempted = new Set([...attemptedModels, currentModelId])
    return candidates.find((candidate) => !attempted.has(`${candidate.providerID}/${candidate.modelID}`)) ?? null
  }
  const currentModel = currentModelId.split("/").slice(1).join("/")
  const idx = candidates.findIndex((candidate) => candidate.modelID === currentModel)
  return candidates[idx + 1] ?? null
}
