/**
 * Free OpenCode Zen model selection for the first-run "free trial" entry point (ADR-057).
 *
 * Background (docs/discussions/040): the vendor `opencode` provider (OpenCode Zen gateway)
 * auto-loads its free models with an anonymous `apiKey: "public"` when the user has no key
 * (`vendor/.../provider/provider.ts:178-198` strips paid models, keeps `cost.input === 0`).
 * So on a fresh install `GET /provider` already lists these free models as *connected* — we
 * just need to pick one to seed as the default (after explicit consent; see model-context).
 *
 * Two hard facts drive the design here:
 *  1. "Listed" ≠ "anonymously usable": the connected free set is a *superset* of what the
 *     live gateway actually serves anonymously (e.g. `mimo-v2.5-free` is listed but 401s;
 *     `gpt-5-nano` too). So we never trust a single id — we return an *ordered candidate
 *     list* and let the caller fall back on the first real 401 (ADR-057 P4).
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
 * Preferred free Zen models, best-first. Every entry was empirically confirmed on the live
 * gateway (2026-07-15, docs/discussions/040) to (a) run anonymously with `apiKey:"public"`
 * and (b) support tool calling — the hard prerequisite for an agent app. Ordering is a hint,
 * not a whitelist: unknown connected free models are still tried after these.
 */
export const FREE_MODEL_PREFERENCE: readonly string[] = [
  "big-pickle",
  "deepseek-v4-flash-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
  "hy3-free",
]

export interface FreeCandidate {
  /** Always `OPENCODE_ZEN_PROVIDER_ID`; kept explicit so callers build `provider/model` ids uniformly. */
  providerID: string
  modelID: string
}

/**
 * A model counts as a free Zen candidate only when its input cost is exactly 0. This matters
 * in the *has-key* case: once the user adds an OpenCode key, the `opencode` provider's
 * `connected` list also includes paid models — we must never seed one of those as a "free
 * trial". A missing `cost` is treated as "not confirmed free" and excluded (conservative:
 * better to skip than to silently seed a billable model).
 */
export function isFreeZenModel(model: ProviderModel | undefined): boolean {
  return model?.cost?.input === 0
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

  // Only connected models that are actually confirmed free (cost.input === 0).
  const freeConnected = zen.connected.filter((modelId) =>
    isFreeZenModel(zen.models.find((m) => m.id === modelId)),
  )

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

export type ZenErrorKind = "quota" | "auth" | "other"

/**
 * Classify a Zen gateway error message from a `session.error` event (ADR-057 P4). Drives the
 * fallback/guidance branch:
 *  - `quota` → free allowance exhausted (`FreeUsageLimitError`): guide to key/upgrade, no fallback.
 *  - `auth`  → the seeded free model is not anonymously usable (401 / missing key / no provider):
 *              advance to the next candidate.
 *  - `other` → unrelated error: leave existing handling untouched.
 */
export function classifyZenError(message: string | undefined): ZenErrorKind {
  const m = (message ?? "").toLowerCase()
  if (/freeusagelimiterror|free usage exceeded|usage exceeded|quota/.test(m)) return "quota"
  if (/missing api key|autherror|unauthorized|\b401\b|no provider available/.test(m)) return "auth"
  return "other"
}

/**
 * The next free candidate to try after `currentModelId` fails, or `null` when the list is
 * exhausted. `currentModelId` is the full `provider/model` id (e.g. `opencode/big-pickle`); an
 * unknown/absent current id starts from the top.
 */
export function nextFreeCandidate(providers: Provider[], currentModelId: string): FreeCandidate | null {
  const candidates = orderedFreeCandidates(providers)
  if (candidates.length === 0) return null
  const currentModel = currentModelId.split("/").slice(1).join("/")
  const idx = candidates.findIndex((c) => c.modelID === currentModel)
  return candidates[idx + 1] ?? null
}
