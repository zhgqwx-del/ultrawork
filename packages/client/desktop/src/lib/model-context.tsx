import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react"
import { toast } from "sonner"
import { useApi } from "./use-api"
import { useI18n } from "./i18n-context"
import type { OpenCodeConfig, Provider } from "@agent/api-client"
import { orderedFreeCandidates, shouldOfferFreeTrial, nextFreeCandidate } from "./free-model"
import { enableFreeTrial as runEnableFreeTrial, revokeFreeTrial as runRevokeFreeTrial } from "./free-trial"
import { makeFreeTrialDeps, getConsent } from "./free-trial-store"
import { FreeTrialConsentDialog } from "@/components/chat/free-trial-consent-dialog"

interface ModelContextValue {
  currentModel: string
  setModel: (model: string) => Promise<void>
  /** Whether the user has opted into the free OpenCode Zen trial default (ADR-057). */
  freeTrialConsent: boolean
  /** Revoke the free trial (settings toggle). Clears the seeded default with protection. */
  revokeFreeTrial: () => Promise<void>
  /**
   * Pre-dispatch gate: call at the TOP of every send path. When the only usable models are free
   * Zen models and the user hasn't opted in, this opens the consent card and returns `true`
   * (the caller MUST abort its send — dispatching would let the server silently route the user's
   * code to a free model without consent). Otherwise returns `false` and the caller proceeds.
   * On consent it seeds a model and invokes `retry` to resume the original send.
   */
  maybeOfferFreeTrial: (retry: () => void) => Promise<boolean>
  /**
   * A seeded free model failed to authenticate (ADR-057 P4). Re-seed the NEXT free candidate and
   * return its `provider/model` id, or `null` when the list is exhausted (caller should guide the
   * user to configure their own key). No-op returning `null` if the free trial isn't active.
   */
  advanceFreeTrialModel: () => Promise<string | null>
}

const ModelContext = createContext<ModelContextValue | undefined>(undefined)

export function ModelProvider({ children }: { children: React.ReactNode }) {
  const [currentModel, setCurrentModel] = useState("")
  const [freeTrialConsent, setFreeTrialConsent] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  const [enabling, setEnabling] = useState(false)
  // The send to resume once the user consents (captured by maybeOfferFreeTrial).
  const pendingRetryRef = useRef<(() => void) | null>(null)
  // Live mirrors of consent + model. The post-consent auto-retry (handleEnable → retry) runs a
  // closure captured from the render BEFORE enable, so a state-based gate would still see the old
  // "" / false and re-open the card. handleEnable updates these refs synchronously before calling
  // retry, so maybeOfferFreeTrial (reading refs) sees the just-seeded model and lets the send through.
  const currentModelRef = useRef(currentModel)
  currentModelRef.current = currentModel
  const freeTrialConsentRef = useRef(freeTrialConsent)
  freeTrialConsentRef.current = freeTrialConsent
  const api = useApi()
  const { t } = useI18n()

  // Load current model + consent state from persisted config on mount.
  useEffect(() => {
    let cancelled = false
    api.getConfig()
      .then((cfg: OpenCodeConfig) => {
        if (!cancelled && cfg.model) setCurrentModel(cfg.model)
      })
      .catch(() => { /* ignore — server may not be ready */ })
    getConsent()
      .then((c) => { if (!cancelled) setFreeTrialConsent(c.consented) })
      .catch(() => { /* stub host / missing command → treat as not consented */ })
    return () => { cancelled = true }
  }, [api])

  const setModel = useCallback(async (model: string) => {
    try {
      await api.patchConfig({ model })
      currentModelRef.current = model
      setCurrentModel(model)
      toast.success(t("model.switchSuccess"))
    } catch {
      toast.error(t("error.switchModel"))
    }
  }, [api, t])

  const revokeFreeTrial = useCallback(async () => {
    try {
      await runRevokeFreeTrial(makeFreeTrialDeps(api))
      freeTrialConsentRef.current = false
      setFreeTrialConsent(false)
      // Reflect the cleared default in the selector (server default-resolution takes over).
      const cfg = await api.getConfig().catch(() => ({}) as OpenCodeConfig)
      currentModelRef.current = cfg.model ?? ""
      setCurrentModel(cfg.model ?? "")
    } catch {
      toast.error(t("error.switchModel"))
    }
  }, [api, t])

  const maybeOfferFreeTrial = useCallback(async (retry: () => void): Promise<boolean> => {
    // Read refs, not captured state: the post-consent retry re-enters this from a stale closure,
    // and the refs reflect the just-seeded model/consent so we correctly let that send through.
    if (currentModelRef.current) return false
    if (freeTrialConsentRef.current) return false
    let providers: Provider[]
    try {
      providers = await api.getProviders()
    } catch {
      // Can't tell — don't block the send; let the existing path surface any error.
      return false
    }
    if (!shouldOfferFreeTrial(providers, currentModelRef.current, freeTrialConsentRef.current)) return false
    pendingRetryRef.current = retry
    setCardOpen(true)
    return true
  }, [api])

  const handleEnable = useCallback(async () => {
    setEnabling(true)
    try {
      const providers = await api.getProviders()
      const candidates = orderedFreeCandidates(providers)
      if (candidates.length === 0) {
        // No usable free model (channel closed / all stripped). Guide to key (P4 stub).
        toast.error(t("freeTrial.unavailable"))
        pendingRetryRef.current = null
        setCardOpen(false)
        return
      }
      const seeded = await runEnableFreeTrial(makeFreeTrialDeps(api), candidates[0])
      // Update the refs SYNCHRONOUSLY (before retry) so the stale retry closure's gate re-entry
      // sees the seeded model / consent and lets the send through instead of re-opening the card.
      currentModelRef.current = seeded
      freeTrialConsentRef.current = true
      setCurrentModel(seeded)
      setFreeTrialConsent(true)
      setCardOpen(false)
      // Resume the send that triggered the card. Empty-model dispatch now resolves to the
      // seeded default server-side, so a stale captured closure is still correct.
      const retry = pendingRetryRef.current
      pendingRetryRef.current = null
      retry?.()
    } catch {
      toast.error(t("freeTrial.unavailable"))
      pendingRetryRef.current = null
      setCardOpen(false)
    } finally {
      setEnabling(false)
    }
  }, [api, t])

  const advanceFreeTrialModel = useCallback(async (): Promise<string | null> => {
    // Refs, not state: this is called from the SSE handler, which holds a stale render's closure.
    if (!freeTrialConsentRef.current) return null
    try {
      const providers = await api.getProviders()
      const next = nextFreeCandidate(providers, currentModelRef.current)
      if (!next) {
        // Exhausted every free candidate — clear the dead seed so the user isn't left with a
        // selected-but-unusable model, and revert to the privacy-off default.
        await runRevokeFreeTrial(makeFreeTrialDeps(api))
        freeTrialConsentRef.current = false
        currentModelRef.current = ""
        setFreeTrialConsent(false)
        setCurrentModel("")
        return null
      }
      const seeded = await runEnableFreeTrial(makeFreeTrialDeps(api), next)
      currentModelRef.current = seeded
      setCurrentModel(seeded)
      return seeded
    } catch {
      return null
    }
  }, [api])

  const handleUseOwnKey = useCallback(() => {
    pendingRetryRef.current = null
    setCardOpen(false)
    // Take the user to Settings → Models to add their own provider (composer text is preserved).
    // Dynamic import of the router singleton: ModelProvider sits ABOVE RouterProvider, so
    // useNavigate isn't available here, and a static `@/router` import would create a cycle
    // (router → pages → useModel). By click time the router module is already loaded.
    void import("@/router").then(({ router }) => {
      void router.navigate("/settings", { state: { section: "models" } })
    })
  }, [])

  const value = useMemo(() => ({
    currentModel, setModel, freeTrialConsent, revokeFreeTrial, maybeOfferFreeTrial, advanceFreeTrialModel,
  }), [currentModel, setModel, freeTrialConsent, revokeFreeTrial, maybeOfferFreeTrial, advanceFreeTrialModel])

  return (
    <ModelContext.Provider value={value}>
      {children}
      <FreeTrialConsentDialog
        open={cardOpen}
        onOpenChange={(o) => { if (!o) { pendingRetryRef.current = null; setCardOpen(false) } }}
        onEnable={handleEnable}
        onUseOwnKey={handleUseOwnKey}
        busy={enabling}
      />
    </ModelContext.Provider>
  )
}

export function useModel() {
  const context = useContext(ModelContext)
  if (!context) {
    throw new Error("useModel must be used within ModelProvider")
  }
  return context
}

/**
 * Like {@link useModel} but returns `undefined` instead of throwing when there is no
 * `ModelProvider` above. Used by hooks (e.g. use-session-messages) that must remain renderable in
 * isolation (unit tests) where wiring the full provider tree would be disproportionate — they just
 * skip free-trial handling when the context is absent.
 */
export function useModelOptional() {
  return useContext(ModelContext)
}
