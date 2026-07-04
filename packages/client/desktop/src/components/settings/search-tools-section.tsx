import { useState, useEffect, useRef, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import { toast } from "sonner"
import { Search, Loader2, CheckCircle2, ExternalLink, ChevronRight, Plug, Trash2, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { EXTERNAL_LINKS } from "@/lib/external-links"
import { cn } from "@/lib/utils"
import { SEARCH_AUTH_IDS, type WebsearchConfig, type WebsearchProviderId } from "@agent/api-client"

/** The two BYOK key providers shown as cards (Exa is keyless → advanced toggle). */
type KeyProviderId = "tavily" | "aliyun-iqs"

const KEY_PROVIDERS: {
  id: KeyProviderId
  /** i18n key prefix: `tools.websearch.provider.<key>.*` */
  key: "tavily" | "iqs"
  consoleUrl: string
  placeholder: string
  recommended?: boolean
}[] = [
  { id: "tavily", key: "tavily", consoleUrl: EXTERNAL_LINKS.tavilyConsole, placeholder: "tvly-...", recommended: true },
  { id: "aliyun-iqs", key: "iqs", consoleUrl: EXTERNAL_LINKS.aliyunIqsKeys, placeholder: "IQS API Key" },
]

interface SearchTestResult {
  ok: boolean
  status: number
  message: string
}

/**
 * Settings → Tools: BYOK web search (ADR-042 / discussions/026).
 *
 * Keys go to auth.json via `PUT /auth/search-*` (read fresh by the sidecar every
 * step — no refresh needed); toggles go to global `experimental.websearch` via
 * `PATCH /global/config?refresh=soft` (tool registration is in the soft-refresh
 * cache set). Both take effect on the agent's next step — no restart. With no
 * provider configured the websearch tool simply isn't registered (degrades to
 * the pre-existing behavior).
 */
export function SearchToolsSection() {
  const api = useApi()
  const { t } = useI18n()

  const [loading, setLoading] = useState(true)
  const [cfg, setCfg] = useState<WebsearchConfig>({})
  const [configured, setConfigured] = useState<Record<KeyProviderId, boolean>>({
    tavily: false,
    "aliyun-iqs": false,
  })
  const [keyInputs, setKeyInputs] = useState<Record<KeyProviderId, string>>({ tavily: "", "aliyun-iqs": "" })
  const [saving, setSaving] = useState<KeyProviderId | null>(null)
  const [testing, setTesting] = useState<KeyProviderId | null>(null)
  const [removing, setRemoving] = useState<KeyProviderId | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<KeyProviderId | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [patchingCfg, setPatchingCfg] = useState(false)

  // Reset in the SETUP, not just cleanup (StrictMode runs setup→cleanup→setup;
  // a cleanup-only reset leaves the ref false and skips every post-await setState).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const [config, tavilyStatus, iqsStatus] = await Promise.all([
        api.getGlobalConfig(),
        api.getAuthStatus(SEARCH_AUTH_IDS.tavily),
        api.getAuthStatus(SEARCH_AUTH_IDS["aliyun-iqs"]),
      ])
      if (!mountedRef.current) return
      setCfg(config.experimental?.websearch ?? {})
      setConfigured({ tavily: tavilyStatus.configured, "aliyun-iqs": iqsStatus.configured })
    } catch (err) {
      console.error("Failed to load search tools state:", err)
      if (mountedRef.current) toast.error(t("tools.websearch.loadError"))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [api, t])

  useEffect(() => {
    void load()
  }, [load])

  /** PATCH only the delta; server merges (and soft-refreshes tool registration). */
  const patchCfg = async (delta: Partial<WebsearchConfig>) => {
    setPatchingCfg(true)
    const prev = cfg
    setCfg({ ...cfg, ...delta })
    try {
      await api.patchGlobalConfig({ experimental: { websearch: delta } })
    } catch (err) {
      console.error("Failed to update websearch config:", err)
      if (mountedRef.current) {
        setCfg(prev)
        toast.error(t("tools.websearch.saveError"))
      }
    } finally {
      if (mountedRef.current) setPatchingCfg(false)
    }
  }

  const handleSaveKey = async (pid: KeyProviderId) => {
    const key = keyInputs[pid].trim()
    if (!key) return
    setSaving(pid)
    try {
      await api.putProviderAuth(SEARCH_AUTH_IDS[pid], key)
      if (!mountedRef.current) return
      setConfigured((c) => ({ ...c, [pid]: true }))
      setKeyInputs((k) => ({ ...k, [pid]: "" }))
      toast.success(t("tools.websearch.saved"))
    } catch (err) {
      console.error("Failed to save search key:", err)
      if (mountedRef.current) toast.error(t("tools.websearch.saveError"))
    } finally {
      // Functional clear: never wipe a spinner some OTHER card set meanwhile.
      if (mountedRef.current) setSaving((s) => (s === pid ? null : s))
    }
  }

  const handleRemoveKey = async (pid: KeyProviderId) => {
    setRemoving(pid)
    setConfirmRemove(null)
    try {
      await api.deleteProviderAuth(SEARCH_AUTH_IDS[pid])
      if (!mountedRef.current) return
      setConfigured((c) => ({ ...c, [pid]: false }))
      toast.success(t("tools.websearch.removed"))
      // A removed key can't stay the preferred provider — clear the stale
      // explicit choice (backend already degrades; this keeps the Select honest).
      if (cfg.provider === pid) await patchCfg({ provider: "auto" })
    } catch (err) {
      console.error("Failed to remove search key:", err)
      if (mountedRef.current) toast.error(t("tools.websearch.saveError"))
    } finally {
      if (mountedRef.current) setRemoving((r) => (r === pid ? null : r))
    }
  }

  /**
   * Probe with the key currently in the input (test-before-save, same as the
   * custom-provider form — the stored key never re-enters the renderer). Runs a
   * minimal real search via Rust curl (webview CORS blocks a direct fetch to the
   * provider hosts, and the key stays out of the renderer's network log).
   */
  const handleTest = async (pid: KeyProviderId) => {
    const key = keyInputs[pid].trim()
    if (!key) return
    setTesting(pid)
    try {
      const res = await invoke<SearchTestResult>("test_search_provider", { provider: pid, apiKey: key })
      if (!mountedRef.current) return
      const suffix = res.status ? ` (${res.status})` : ""
      if (res.ok) {
        toast.success(t("tools.websearch.test.ok"))
      } else if (res.message === "auth") {
        // IQS auth failures get the dedicated hint: IQS key ≠ DashScope key, and
        // a freshly created key takes ~5 minutes to activate.
        toast.error(`${t(pid === "aliyun-iqs" ? "tools.websearch.test.authIqs" : "tools.websearch.test.authTavily")}${suffix}`, {
          duration: 8000,
        })
      } else if (res.message === "network") {
        toast.error(`${t("tools.websearch.test.network")}${suffix}`)
      } else {
        toast.error(`${t("tools.websearch.test.http")}${suffix}`)
      }
    } catch (err) {
      console.error("Search provider test failed:", err)
      if (mountedRef.current) toast.error(t("tools.websearch.test.network"))
    } finally {
      if (mountedRef.current) setTesting((x) => (x === pid ? null : x))
    }
  }

  const enabled = cfg.enabled !== false
  const anyProvider = configured.tavily || configured["aliyun-iqs"] || cfg.exa === true
  const active = enabled && anyProvider
  const preferred = cfg.provider ?? "auto"

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-[var(--color-fg-muted)]" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("settingsPage.tools")}</h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t("tools.desc")}</p>
      </div>

      {/* Web search */}
      <div className="rounded-lg border border-[var(--color-border)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "mt-0.5 flex size-8 items-center justify-center rounded-lg",
                active ? "bg-green-500/10" : "bg-[var(--color-accent)]",
              )}
            >
              <Search className={cn("size-4", active ? "text-green-500" : "text-[var(--color-fg-muted)]")} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("tools.websearch.title")}</h3>
                {active && (
                  <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-px text-[10px] font-medium text-green-600 dark:text-green-400">
                    <CheckCircle2 className="mr-1 size-3" />
                    {t("tools.websearch.active")}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{t("tools.websearch.desc")}</p>
            </div>
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={enabled}
              disabled={patchingCfg}
              onChange={(e) => void patchCfg({ enabled: e.target.checked })}
              className="size-3.5 accent-[var(--color-brand)]"
            />
            {t("tools.websearch.enable")}
          </label>
        </div>

        {/* Provider key cards */}
        <div className="mt-4 space-y-3">
          {KEY_PROVIDERS.map((p) => {
            const isConfigured = configured[p.id]
            const input = keyInputs[p.id]
            // Serialize mutating ops ACROSS cards too: a save on card A while a
            // remove runs on card B would let auth.json writes race.
            const busy = saving !== null || testing !== null || removing !== null
            return (
              <div key={p.id} className="rounded-md border border-[var(--color-border)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--color-fg)]">
                      {t(`tools.websearch.provider.${p.key}.title`)}
                    </span>
                    {p.recommended && (
                      <span className="rounded bg-[var(--color-brand)]/10 px-1 py-px text-[9px] font-medium text-[var(--color-brand)]">
                        {t("tools.websearch.recommended")}
                      </span>
                    )}
                    {isConfigured ? (
                      <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-px text-[10px] font-medium text-green-600 dark:text-green-400">
                        <CheckCircle2 className="mr-1 size-3" />
                        {t("tools.websearch.configured")}
                      </span>
                    ) : (
                      <span className="rounded-full bg-[var(--color-accent)] px-2 py-px text-[10px] font-medium text-[var(--color-fg-muted)]">
                        {t("tools.websearch.notConfigured")}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void openUrl(p.consoleUrl)}
                    className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-brand)] hover:underline"
                  >
                    {t("tools.websearch.getKey")}
                    <ExternalLink className="size-3" />
                  </button>
                </div>
                <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                  {t(`tools.websearch.provider.${p.key}.desc`)}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="password"
                    value={input}
                    onChange={(e) => setKeyInputs((k) => ({ ...k, [p.id]: e.target.value }))}
                    placeholder={isConfigured ? t("tools.websearch.replacePlaceholder") : p.placeholder}
                    aria-label={t(`tools.websearch.provider.${p.key}.title`)}
                    className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleTest(p.id)}
                    disabled={!input.trim() || busy}
                    title={!input.trim() ? t("tools.websearch.testNeedsKey") : undefined}
                  >
                    {testing === p.id ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <Plug className="mr-1.5 size-3.5" />
                    )}
                    {t("tools.websearch.test")}
                  </Button>
                  <Button size="sm" onClick={() => void handleSaveKey(p.id)} disabled={!input.trim() || busy}>
                    {saving === p.id ? <Loader2 className="size-3.5 animate-spin" /> : t("button.save")}
                  </Button>
                  {isConfigured &&
                    (removing === p.id ? (
                      <Loader2 className="size-4 animate-spin text-[var(--color-fg-muted)]" />
                    ) : confirmRemove === p.id ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={t("tools.websearch.removeConfirm")}
                          disabled={busy}
                          onClick={() => void handleRemoveKey(p.id)}
                          className="flex size-7 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                        >
                          <Check className="size-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={t("button.cancel")}
                          onClick={() => setConfirmRemove(null)}
                          className="flex size-7 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)]"
                        >
                          <X className="size-4" />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={t("tools.websearch.remove")}
                        title={t("tools.websearch.remove")}
                        disabled={busy}
                        onClick={() => setConfirmRemove(p.id)}
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    ))}
                </div>
                <p className="mt-1.5 text-[10px] text-[var(--color-fg-muted)]">{t("tools.websearch.testCostNote")}</p>
              </div>
            )
          })}
        </div>

        {/* Preferred provider */}
        <div className="mt-4 flex items-center justify-between gap-3">
          <div>
            <label className="text-xs font-medium text-[var(--color-fg)]">{t("tools.websearch.defaultProvider")}</label>
            <p className="text-[10px] text-[var(--color-fg-muted)]">{t("tools.websearch.defaultProvider.hint")}</p>
          </div>
          <Select
            value={preferred}
            onValueChange={(v) => void patchCfg({ provider: v as WebsearchProviderId | "auto" })}
            disabled={patchingCfg}
          >
            <SelectTrigger className="w-52" aria-label={t("tools.websearch.defaultProvider")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("tools.websearch.defaultProvider.auto")}</SelectItem>
              {configured.tavily && <SelectItem value="tavily">Tavily</SelectItem>}
              {configured["aliyun-iqs"] && (
                <SelectItem value="aliyun-iqs">{t("tools.websearch.provider.iqs.title")}</SelectItem>
              )}
              {cfg.exa === true && <SelectItem value="exa">Exa</SelectItem>}
            </SelectContent>
          </Select>
        </div>

        {/* Advanced: Exa keyless endpoint (off by default; reachability in CN is questionable) */}
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", advancedOpen && "rotate-90")} />
            {t("tools.websearch.advanced")}
          </button>
          {advancedOpen && (
            <div className="mt-2 rounded-md border border-[var(--color-border)] p-3">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={cfg.exa === true}
                  disabled={patchingCfg}
                  onChange={(e) => void patchCfg({ exa: e.target.checked })}
                  className="mt-0.5 size-3.5 accent-[var(--color-brand)]"
                />
                <span>
                  <span className="block text-xs font-medium text-[var(--color-fg)]">
                    {t("tools.websearch.exa.title")}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-[var(--color-fg-muted)]">
                    {t("tools.websearch.exa.desc")}
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>

        <p className="mt-3 text-[10px] text-[var(--color-fg-muted)]">{t("tools.websearch.effectNote")}</p>
      </div>
    </div>
  )
}
