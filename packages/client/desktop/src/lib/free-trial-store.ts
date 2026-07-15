/**
 * IO adapter wiring the free-trial consent state machine (free-trial.ts) to its real
 * boundaries: the Tauri commands over `free-trial-consent.json` and the api-client's
 * global-config endpoints. The seed/revoke *logic* lives in free-trial.ts (unit-tested);
 * this file is the thin, untested edge.
 */

import { invoke } from "@tauri-apps/api/core"
import type { ApiClient } from "@agent/api-client"
import type { FreeTrialConsentState, FreeTrialDeps } from "./free-trial"

/**
 * Read the consent flag. Validate the shape rather than trusting the call: a stub host
 * (the e2e Tauri shim, or an older build without the command) resolves `null` instead of
 * throwing, and treating that as consent would breach the privacy-off default.
 */
export async function getConsent(): Promise<FreeTrialConsentState> {
  const raw = await invoke<unknown>("get_free_trial_consent")
  if (typeof raw !== "object" || raw === null) return { consented: false }
  const r = raw as Record<string, unknown>
  return {
    consented: r.consented === true,
    seededModel: typeof r.seededModel === "string" ? r.seededModel : undefined,
    seededSmallModel: typeof r.seededSmallModel === "string" ? r.seededSmallModel : undefined,
  }
}

export async function setConsent(
  seededModel: string | undefined,
  seededSmallModel: string | undefined,
): Promise<void> {
  // Tauri maps JS camelCase args → Rust snake_case params; Option<String> takes null for None.
  await invoke("set_free_trial_consent", {
    seededModel: seededModel ?? null,
    seededSmallModel: seededSmallModel ?? null,
  })
}

export async function clearConsent(): Promise<void> {
  await invoke("clear_free_trial_consent")
}

/** Build `FreeTrialDeps` from a live api-client instance plus the Tauri consent store. */
export function makeFreeTrialDeps(api: ApiClient): FreeTrialDeps {
  return {
    patchGlobalConfig: (u) => api.patchGlobalConfig(u),
    getGlobalConfig: () => api.getGlobalConfig(),
    getConsent,
    setConsent,
    clearConsent,
  }
}
