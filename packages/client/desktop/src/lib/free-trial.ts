/**
 * Free-trial consent state machine (ADR-057 P2).
 *
 * Seeds a free OpenCode Zen model as the GLOBAL default (`model` + `small_model`) after the
 * user explicitly opts in, and revokes it with protection. The consent flag itself lives in a
 * separate file managed by Rust (`free-trial-consent.json`); the model values live in
 * opencode.json, written by the sidecar via `patchGlobalConfig` — this module coordinates the two.
 *
 * All I/O is injected via `FreeTrialDeps` so the seed/revoke logic is unit-testable without a
 * sidecar or Tauri runtime.
 */

import type { OpenCodeConfig } from "@agent/api-client"
import type { FreeCandidate } from "./free-model"

export interface FreeTrialConsentState {
  consented: boolean
  /** The `provider/model` we seeded as `model`, if any (used for revoke-with-protection). */
  seededModel?: string
  /** The `provider/model` we seeded as `small_model`, if any. */
  seededSmallModel?: string
}

/**
 * Injected boundaries. Real implementations:
 *  - `patchGlobalConfig`/`getGlobalConfig` → api-client (writes the sidecar's global opencode.json)
 *  - `getConsent`/`setConsent`/`clearConsent` → Tauri commands over `free-trial-consent.json`
 */
export interface FreeTrialDeps {
  patchGlobalConfig(updates: Partial<OpenCodeConfig>): Promise<unknown>
  getGlobalConfig(): Promise<OpenCodeConfig>
  getConsent(): Promise<FreeTrialConsentState>
  setConsent(seededModel: string | undefined, seededSmallModel: string | undefined): Promise<void>
  clearConsent(): Promise<void>
}

/** Build the `provider/model` id opencode expects (e.g. `opencode/big-pickle`). */
export function candidateModelString(c: FreeCandidate): string {
  return `${c.providerID}/${c.modelID}`
}

/**
 * Seed a free candidate as the global default and record consent.
 *
 * Seeds `small_model` too (D4): opencode's built-in title/summary model for the `opencode`
 * provider is `gpt-5-nano`, which 401s anonymously — pointing `small_model` at the same usable
 * free model keeps auto-title generation from silently failing.
 *
 * @returns the seeded `provider/model` id
 */
export async function enableFreeTrial(deps: FreeTrialDeps, candidate: FreeCandidate): Promise<string> {
  const modelId = candidateModelString(candidate)
  await deps.patchGlobalConfig({ model: modelId, small_model: modelId })
  await deps.setConsent(modelId, modelId)
  return modelId
}

/**
 * Revoke the free trial, clearing the seeded default WITH PROTECTION: only clear `model` /
 * `small_model` if they still equal what we seeded. If the user has since picked their own
 * model, leave it untouched — we must never clobber a deliberate user choice.
 *
 * opencode's global config is deep-merged with no key-delete, and its zod rejects `null`, so
 * "unset" is the empty string: falsy in both the client's `if (cfg.model)` and the server's
 * default-resolution `if (cfg.model)`, and `ModelId` is a plain `z.string()` that accepts it.
 */
export async function revokeFreeTrial(deps: FreeTrialDeps): Promise<void> {
  const consent = await deps.getConsent()
  const cfg = await deps.getGlobalConfig()

  const updates: Partial<OpenCodeConfig> = {}
  if (consent.seededModel && cfg.model === consent.seededModel) updates.model = ""
  if (consent.seededSmallModel && cfg.small_model === consent.seededSmallModel) updates.small_model = ""

  if (Object.keys(updates).length > 0) await deps.patchGlobalConfig(updates)
  await deps.clearConsent()
}
