import { useState, useEffect, useCallback, useRef, type ReactNode } from "react"
import { Search, Check, ChevronRight, Plus, Loader2, Key, ArrowLeft, Trash2, X, Sparkles, Plug, ExternalLink } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import { EXTERNAL_LINKS } from "@/lib/external-links"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { useModel } from "@/lib/model-context"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { clearModelCache } from "@/components/chat/model-selector"
import type { Provider, ProviderAuthInfo, CustomProviderProtocol, CustomProviderModelDef, CustomProviderDef } from "@agent/api-client"

/**
 * A user-created custom provider (deletable). `source === "config"` alone is too
 * broad — it also matches a *built-in* provider that the user merely gave a Base
 * URL override (existing configure flow), which would wrongly show a delete
 * button that disables the real built-in. Built-ins retain their models.dev
 * `env` (e.g. ["OPENAI_API_KEY"]); our custom providers have none. Empirically
 * verified — see discussion 006 §11.9.
 */
const isCustomProvider = (p: Provider) => p.source === "config" && !(p.env && p.env.length > 0)

/**
 * Heuristic: does this provider look like Aliyun DashScope (百炼)? Gates the
 * per-model "built-in web search" toggle (`enable_search` is DashScope-only —
 * other OpenAI-compatible hosts may reject the unknown body key). Matches the
 * built-in alibaba/alibaba-cn providers by id/name and custom providers by
 * their DashScope base URL. A model with the flag already set in config always
 * shows the toggle (never strand an "on" you can't turn off).
 */
const isDashScopeLike = (p: Provider) => {
  const hay = `${p.id} ${p.name} ${String(p.options?.["baseURL"] ?? "")}`.toLowerCase()
  return /dashscope|aliyun|alibaba|bailian|qwen/.test(hay)
}

interface CustomModelRow {
  /** Stable React key so removing a middle row doesn't shift focus/IME. */
  key: number
  id: string
  name: string
  context: string
  output: string
  /** Capability flags. toolCall defaults to true (most models support tools). */
  toolCall: boolean
  reasoning: boolean
  attachment: boolean
  vision: boolean
  /** DashScope model-native web search (`options.enable_search`, ADR-042). */
  builtinSearch: boolean
  /** Raw "advanced (JSON)" escape hatch; "" when unused. */
  advanced: string
  /** Whether the advanced JSON editor is expanded for this row. */
  advancedOpen: boolean
}

let modelRowSeq = 0
const blankModelRow = (): CustomModelRow => ({
  key: modelRowSeq++,
  id: "",
  name: "",
  context: "",
  output: "",
  toolCall: true,
  reasoning: false,
  attachment: false,
  vision: false,
  builtinSearch: false,
  advanced: "",
  advancedOpen: false,
})

/** Parse a user-entered positive integer; "" / non-finite / ≤0 / fractional → undefined. */
const parsePositiveInt = (s: string): number | undefined => {
  const t = s.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * Validate the "advanced (JSON)" field. Empty → valid (no extra). Must parse to
 * a plain JSON object (not array/scalar) since it deep-merges into the model
 * config. Returns `error: true` on bad input so the form can block save + flag
 * the textarea.
 */
const parseAdvanced = (
  s: string,
): { ok: boolean; value?: Record<string, unknown>; error?: boolean } => {
  const t = s.trim()
  if (!t) return { ok: true }
  try {
    const v = JSON.parse(t)
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: true }
    return { ok: true, value: v as Record<string, unknown> }
  } catch {
    return { ok: false, error: true }
  }
}

/**
 * Icon button whose label appears INSTANTLY on hover via CSS group-hover (no
 * native-`title` delay). `aria-label` keeps it accessible/testable. Used for the
 * ambiguous ✓/✗ inline delete-confirm icons.
 */
function HoverLabelButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string
  onClick: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "group/tip relative flex shrink-0 items-center justify-center rounded-md transition-colors",
        className,
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--color-fg)] px-1.5 py-0.5 text-[10px] text-[var(--color-bg)] opacity-0 transition-opacity duration-75 group-hover/tip:opacity-100"
      >
        {label}
      </span>
    </button>
  )
}


/**
 * Model provider management as a Settings section.
 * Aligned with the services/channels section pattern (header + cards + inline form).
 * Replaces the former global ModelDialog modal.
 */
export function ModelsSection() {
  const { currentModel, setModel } = useModel()
  const [providers, setProviders] = useState<Provider[]>([])
  const [authInfos, setAuthInfos] = useState<ProviderAuthInfo[]>([])
  const [search, setSearch] = useState("")
  // Start in the loading state: the section fetches on mount, so a `false`
  // initial value flashes the empty ("no providers") state for one frame.
  const [loading, setLoading] = useState(true)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  // "list" shows connected providers; "configure" shows the add/configure flow
  const [configuring, setConfiguring] = useState(false)
  const api = useApi()
  const { t } = useI18n()

  // Configure provider form state
  const [configSearch, setConfigSearch] = useState("")
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null)
  const [configApiKey, setConfigApiKey] = useState("")
  const [configBaseUrl, setConfigBaseUrl] = useState("")
  const [saving, setSaving] = useState(false)
  // Guards against post-await side effects after the section unmounts — the user
  // can switch the settings nav to another section while a save is in flight.
  const mountedRef = useRef(true)
  // Reset in the SETUP, not just cleanup: React StrictMode (dev) runs effects
  // setup→cleanup→setup, so a cleanup-only reset leaves the ref false after mount
  // → post-await guards skip setSaving(false) and the spinner spins forever.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Custom provider form state (separate "customMode" sub-view)
  const [customMode, setCustomMode] = useState(false)
  const [customId, setCustomId] = useState("")
  const [customName, setCustomName] = useState("")
  const [customProtocol, setCustomProtocol] = useState<CustomProviderProtocol>("openai")
  const [customBaseUrl, setCustomBaseUrl] = useState("")
  const [customApiKey, setCustomApiKey] = useState("")
  const [customModels, setCustomModels] = useState<CustomModelRow[]>([blankModelRow()])
  // "test connection" probe in flight (custom-provider form).
  const [testing, setTesting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // Inline two-step delete confirm (avoids the unstyled native window.confirm in
  // the Tauri webview; matches the app's inline-action convention).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Model-native web search (DashScope `enable_search`, ADR-042): per-model flag
  // living in the GLOBAL config `provider.<pid>.models.<mid>.options.enable_search`.
  // Keyed "pid/mid". Loaded with the provider list; toggled via patchGlobalConfig.
  const [builtinSearchMap, setBuiltinSearchMap] = useState<Record<string, boolean>>({})
  const [togglingSearch, setTogglingSearch] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [provs, auths, globalCfg] = await Promise.all([
        api.getProviders(),
        api.getProviderAuth(),
        api.getGlobalConfig().catch(() => null),
      ])
      setProviders(provs)
      setAuthInfos(auths)
      if (globalCfg) {
        const map: Record<string, boolean> = {}
        for (const [pid, pcfg] of Object.entries(globalCfg.provider ?? {})) {
          for (const [mid, mcfg] of Object.entries(pcfg.models ?? {})) {
            const es = mcfg.options?.["enable_search"]
            if (typeof es === "boolean") map[`${pid}/${mid}`] = es
          }
        }
        setBuiltinSearchMap(map)
      }
    } catch (err) {
      console.error("Failed to fetch providers:", err)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  /**
   * Flip a model's built-in web search. Writes the GLOBAL config (soft refresh →
   * the next turn picks it up, no restart). PATCH merge can't delete keys, so
   * "off" writes `false` rather than removing the entry. `id` is forced to the
   * map key (see upsertCustomProvider) so the entry never desyncs.
   */
  const handleToggleBuiltinSearch = async (pid: string, mid: string, next: boolean) => {
    const key = `${pid}/${mid}`
    setTogglingSearch(key)
    try {
      await api.patchGlobalConfig({
        provider: { [pid]: { models: { [mid]: { id: mid, options: { enable_search: next } } } } },
      })
      if (!mountedRef.current) return
      setBuiltinSearchMap((m) => ({ ...m, [key]: next }))
      toast.success(t(next ? "model.builtinSearch.on" : "model.builtinSearch.off"))
    } catch (err) {
      console.error("Failed to toggle builtin search:", err)
      if (mountedRef.current) toast.error(t("model.builtinSearch.err"))
    } finally {
      if (mountedRef.current) setTogglingSearch(null)
    }
  }

  const handleShowConfig = () => {
    setConfigSearch("")
    setSelectedProvider(null)
    setConfigApiKey("")
    setConfigBaseUrl("")
    setConfiguring(true)
  }

  const handleBackToList = () => {
    setConfiguring(false)
  }

  const connectedCount = providers.filter((p) => p.connected.length > 0).length

  // --- List view: show connected providers, search all ---

  const filteredProviders = providers
    .filter((p) => {
      if (!search) return p.connected.length > 0
      const q = search.toLowerCase()
      // Only show providers that have at least one connected model matching the query
      return p.connected.some((modelId) => {
        const modelInfo = p.models.find((m) => m.id === modelId)
        return (
          modelId.toLowerCase().includes(q) ||
          (modelInfo?.name ?? "").toLowerCase().includes(q)
        )
      })
    })
    // The filter above guarantees every survivor has connected models, so a
    // "connected-first" sort would be a no-op here — order by name only.
    .sort((a, b) => a.name.localeCompare(b.name))

  const getAuthInfo = (pid: string) => {
    return authInfos.find((a) => a.id === pid || a.name.toLowerCase() === pid.toLowerCase())
  }

  const handleSelectModel = (pid: string, modelId: string) => {
    setModel(`${pid}/${modelId}`)
  }

  // --- Configure view: pick from all providers, set API key + base URL ---

  const configFilteredProviders = providers.filter((p) => {
    if (!configSearch) return true
    const q = configSearch.toLowerCase()
    return p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
  }).sort((a, b) => {
    // Already connected first
    const ac = a.connected.length > 0 ? 1 : 0
    const bc = b.connected.length > 0 ? 1 : 0
    if (ac !== bc) return bc - ac
    return a.name.localeCompare(b.name)
  })

  const handleSaveConfig = async () => {
    if (!selectedProvider) return
    setSaving(true)
    try {
      if (configApiKey.trim()) {
        await api.putProviderAuth(selectedProvider.id, configApiKey.trim())
      }
      if (configBaseUrl.trim()) {
        // Global scope (ADR-039): write the provider override to the global
        // config so it applies in every workspace and goes live immediately.
        await api.patchGlobalConfig({
          provider: {
            [selectedProvider.id]: {
              options: {
                baseURL: configBaseUrl.trim(),
              },
            },
          },
        })
      }
      // Invalidate ModelSelector cache so it picks up new provider immediately —
      // safe to run regardless of mount state (module-level cache).
      clearModelCache()
      if (!mountedRef.current) return
      toast.success(t("model.addProvider.success"))
      // Back to list; clear search so the new provider appears in the default view
      setSearch("")
      setConfiguring(false)
      fetchData()
    } catch (err) {
      console.error("Failed to configure provider:", err)
      if (mountedRef.current) toast.error(t("model.addProvider.error"))
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  // --- Custom provider form ---

  const handleShowCustom = () => {
    setCustomId("")
    setCustomName("")
    setCustomProtocol("openai")
    setCustomBaseUrl("")
    setCustomApiKey("")
    setCustomModels([blankModelRow()])
    setCustomMode(true)
  }

  const closeCustom = () => setCustomMode(false)

  const updateModelRow = (idx: number, patch: Partial<CustomModelRow>) => {
    setCustomModels((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }
  const addModelRow = () => setCustomModels((rows) => [...rows, blankModelRow()])
  const removeModelRow = (idx: number) =>
    setCustomModels((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== idx)))

  /**
   * Best-effort connectivity + auth probe against the entered Base URL. Runs a
   * Rust `curl` command (no webview CORS, key stays out of the renderer's
   * network log) hitting the provider's model-list endpoint.
   */
  const handleTestConnection = async () => {
    if (!/^https?:\/\/.+/.test(customBaseUrl.trim())) {
      return toast.error(t("model.customProvider.err.baseUrl"))
    }
    const hadKey = Boolean(customApiKey.trim())
    setTesting(true)
    try {
      const res = await invoke<{ ok: boolean; status: number; message: string }>(
        "test_provider_connection",
        {
          baseUrl: customBaseUrl.trim(),
          apiKey: customApiKey.trim(),
          protocol: customProtocol,
        },
      )
      // The probe can take up to 15s (curl timeout); bail if the form unmounted
      // meanwhile (user hit Cancel) so we don't toast/setState on a dead view.
      if (!mountedRef.current) return
      const suffix = res.status ? ` (${res.status})` : ""
      if (res.ok) {
        toast.success(t("model.customProvider.test.ok"))
      } else if (res.message === "auth") {
        // 401/403 with no key entered isn't a "wrong key" — it just needs one.
        const key = hadKey ? "model.customProvider.test.auth" : "model.customProvider.test.authNoKey"
        toast.error(`${t(key)}${suffix}`)
      } else if (res.message === "notfound") {
        // Advisory, not a failure: the model-list path varies by gateway and this
        // does not block saving. Use a neutral toast, not an error.
        toast(`${t("model.customProvider.test.notfound")}${suffix}`)
      } else {
        const key = res.message === "network" ? "model.customProvider.test.network" : "model.customProvider.test.http"
        toast.error(`${t(key)}${suffix}`)
      }
    } catch (err) {
      console.error("Provider connection test failed:", err)
      if (mountedRef.current) toast.error(t("model.customProvider.test.network"))
    } finally {
      if (mountedRef.current) setTesting(false)
    }
  }

  /**
   * True for a row the user has touched, so a content-less leftover row is
   * skipped but a touched-yet-id-less row still surfaces the "needs ID" error
   * instead of being silently dropped. Includes capability toggles (toolCall
   * defaults to true, so a flipped-off toolCall or any other flag = touched).
   */
  const rowHasContent = (m: CustomModelRow) =>
    Boolean(
      m.id.trim() ||
        m.name.trim() ||
        m.context.trim() ||
        m.output.trim() ||
        m.advanced.trim() ||
        !m.toolCall ||
        m.reasoning ||
        m.vision ||
        m.attachment ||
        m.builtinSearch,
    )

  const handleSaveCustom = async () => {
    const id = customId.trim().toLowerCase()
    // Rows with any content; a row with content but no ID is a user error
    // (don't silently drop it), fully-blank rows are ignored.
    const filled = customModels.filter(rowHasContent)
    // Validation
    if (!/^[a-z0-9-]+$/.test(id)) return toast.error(t("model.customProvider.err.id"))
    if (providers.some((p) => p.id === id)) return toast.error(t("model.customProvider.err.idTaken"))
    if (!customName.trim()) return toast.error(t("model.customProvider.err.name"))
    if (!/^https?:\/\/.+/.test(customBaseUrl.trim())) return toast.error(t("model.customProvider.err.baseUrl"))
    if (filled.length === 0) return toast.error(t("model.customProvider.err.noModels"))
    if (filled.some((m) => !m.id.trim())) return toast.error(t("model.customProvider.err.modelId"))
    const modelIds = filled.map((m) => m.id.trim())
    if (new Set(modelIds).size !== modelIds.length) return toast.error(t("model.customProvider.err.modelDup"))
    // Parse each row's advanced JSON ONCE; reuse for both validation and the def.
    const advParsed = filled.map((m) => parseAdvanced(m.advanced))
    // Any malformed advanced JSON blocks the save (the textarea is already flagged).
    if (advParsed.some((a) => a.error)) return toast.error(t("model.customProvider.err.advancedJson"))

    const parsed: CustomProviderModelDef[] = filled.map((m, i) => ({
      id: m.id.trim(),
      name: m.name.trim() || m.id.trim(),
      context: parsePositiveInt(m.context),
      output: parsePositiveInt(m.output),
      toolCall: m.toolCall,
      reasoning: m.reasoning,
      attachment: m.attachment,
      vision: m.vision,
      builtinSearch: m.builtinSearch,
      advanced: advParsed[i].value,
    }))
    // opencode requires context+output together inside a model's `limit` (a partial
    // `{ context }` is rejected 400). The limit can come from EITHER the number
    // fields OR `advanced.limit` (deep-merged in the api-client), so validate the
    // EFFECTIVE pairing across both sources — otherwise a partial limit slipped in
    // via advanced JSON reaches opencode, or a split (context in field, output in
    // advanced) is wrongly rejected.
    const limitField = (lim: unknown, k: "context" | "output"): number | undefined => {
      if (!lim || typeof lim !== "object") return undefined
      const v = (lim as Record<string, unknown>)[k]
      return typeof v === "number" ? v : undefined
    }
    const limitMismatch = parsed.some((m, i) => {
      const advLimit = advParsed[i].value?.limit
      const ctx = m.context ?? limitField(advLimit, "context")
      const out = m.output ?? limitField(advLimit, "output")
      return (ctx == null) !== (out == null)
    })
    if (limitMismatch) return toast.error(t("model.customProvider.err.limitPair"))

    const def: CustomProviderDef = {
      id,
      name: customName.trim(),
      protocol: customProtocol,
      baseURL: customBaseUrl.trim(),
      apiKey: customApiKey.trim() || undefined,
      models: parsed,
    }

    setSaving(true)
    try {
      await api.upsertCustomProvider(def)
      clearModelCache()
      if (!mountedRef.current) return
      toast.success(t("model.customProvider.saveSuccess"))
      setSearch("")
      setCustomMode(false)
      setConfiguring(false)
      fetchData()
    } catch (err) {
      console.error("Failed to save custom provider:", err)
      if (mountedRef.current) toast.error(t("model.customProvider.saveError"))
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  const handleDeleteProvider = async (pid: string) => {
    setConfirmDeleteId(null)
    setDeletingId(pid)
    try {
      // Hide via disabled_providers (PATCH can't remove the config key) + clear key.
      await api.setProviderDisabled(pid, true)
      await api.deleteProviderAuth(pid).catch(() => {})
      clearModelCache()
      if (!mountedRef.current) return
      toast.success(t("model.customProvider.deleteSuccess"))
      fetchData()
    } catch (err) {
      console.error("Failed to remove provider:", err)
      if (mountedRef.current) toast.error(t("model.customProvider.deleteError"))
    } finally {
      if (mountedRef.current) setDeletingId(null)
    }
  }

  // ---- Custom Provider form view ----
  if (customMode) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={closeCustom}
            className="flex size-7 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            <ArrowLeft className="size-4" />
          </button>
          <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("model.customProvider.title")}</h2>
        </div>
        <p className="text-sm text-[var(--color-fg-muted)]">
          {t("model.customProvider.hint")} {t("model.customProvider.scopeHint")}
        </p>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("model.customProvider.id")}</label>
            <input
              type="text"
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              placeholder={t("model.customProvider.idPlaceholder")}
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("model.customProvider.name")}</label>
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={t("model.customProvider.namePlaceholder")}
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("model.customProvider.protocol")}</label>
            <Select value={customProtocol} onValueChange={(v) => setCustomProtocol(v as CustomProviderProtocol)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">{t("model.customProvider.protocol.openai")}</SelectItem>
                <SelectItem value="anthropic">{t("model.customProvider.protocol.anthropic")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("model.addProvider.baseUrl")}</label>
            <input
              type="text"
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
            {t("model.addProvider.apiKey")} ({t("model.configureProvider.optional")})
          </label>
          <input
            type="password"
            value={customApiKey}
            onChange={(e) => setCustomApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
          />
        </div>

        {/* Models */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-[var(--color-fg-muted)]">{t("model.customProvider.models")}</label>
            <button type="button" onClick={addModelRow} className="flex items-center gap-1 text-xs text-[var(--color-brand)] hover:underline">
              <Plus className="size-3" /> {t("model.customProvider.addModel")}
            </button>
          </div>
          {customModels.map((m, idx) => {
            const advErr = parseAdvanced(m.advanced).error
            return (
            <div key={m.key} className="space-y-2 rounded-lg border border-[var(--color-border)] p-3">
              {/* Row 1: id + name + remove */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={m.id}
                  onChange={(e) => updateModelRow(idx, { id: e.target.value })}
                  placeholder={t("model.customProvider.modelId")}
                  className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                />
                <input
                  type="text"
                  value={m.name}
                  onChange={(e) => updateModelRow(idx, { name: e.target.value })}
                  placeholder={t("model.customProvider.modelName")}
                  className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                />
                <button
                  type="button"
                  onClick={() => removeModelRow(idx)}
                  disabled={customModels.length <= 1}
                  aria-label={t("model.customProvider.removeModel")}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] disabled:opacity-30"
                >
                  <X className="size-4" />
                </button>
              </div>

              {/* Row 2: context + output limits */}
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  value={m.context}
                  onChange={(e) => updateModelRow(idx, { context: e.target.value })}
                  placeholder={t("model.customProvider.context")}
                  className="w-32 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                />
                <input
                  type="number"
                  min="1"
                  value={m.output}
                  onChange={(e) => updateModelRow(idx, { output: e.target.value })}
                  placeholder={t("model.customProvider.output")}
                  className="w-32 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                />
              </div>

              {/* Row 3: capability flags */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {([
                  ["toolCall", "model.customProvider.cap.toolCall"],
                  ["reasoning", "model.customProvider.cap.reasoning"],
                  ["vision", "model.customProvider.cap.vision"],
                  ["attachment", "model.customProvider.cap.attachment"],
                  ["builtinSearch", "model.customProvider.cap.builtinSearch"],
                ] as const).map(([field, label]) => (
                  <label
                    key={field}
                    title={field === "builtinSearch" ? t("model.builtinSearch.hint") : undefined}
                    className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-fg)]"
                  >
                    <input
                      type="checkbox"
                      checked={m[field]}
                      onChange={(e) => updateModelRow(idx, { [field]: e.target.checked } as Partial<CustomModelRow>)}
                      className="size-3.5 accent-[var(--color-brand)]"
                    />
                    {t(label)}
                  </label>
                ))}
              </div>
              {m.builtinSearch && (
                <p className="text-[10px] text-[var(--color-fg-muted)]">
                  {t("model.builtinSearch.hint")}{" "}
                  <button
                    type="button"
                    onClick={() => void openUrl(EXTERNAL_LINKS.dashscopeKeys)}
                    className="inline-flex items-center gap-0.5 text-[var(--color-brand)] hover:underline"
                  >
                    {t("model.builtinSearch.getDashScopeKey")}
                    <ExternalLink className="size-2.5" />
                  </button>
                </p>
              )}

              {/* Advanced (JSON) escape hatch */}
              <div>
                <button
                  type="button"
                  onClick={() => updateModelRow(idx, { advancedOpen: !m.advancedOpen })}
                  className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
                >
                  <ChevronRight className={cn("size-3.5 transition-transform", m.advancedOpen && "rotate-90")} />
                  {t("model.customProvider.advanced")}
                </button>
                {m.advancedOpen && (
                  <div className="mt-1.5">
                    <textarea
                      value={m.advanced}
                      onChange={(e) => updateModelRow(idx, { advanced: e.target.value })}
                      rows={4}
                      spellCheck={false}
                      placeholder={'{ "options": { … }, "headers": { … } }'}
                      className={cn(
                        "w-full rounded-md border bg-transparent px-2.5 py-1.5 font-mono text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1",
                        advErr
                          ? "border-red-500 focus:ring-red-500"
                          : "border-[var(--color-border)] focus:ring-[var(--color-brand)]",
                      )}
                    />
                    <p className={cn("mt-1 text-[10px]", advErr ? "text-red-500" : "text-[var(--color-fg-muted)]")}>
                      {advErr ? t("model.customProvider.advancedError") : t("model.customProvider.advancedHint")}
                    </p>
                  </div>
                )}
              </div>
            </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handleTestConnection} disabled={testing}>
            {testing ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Plug className="mr-1.5 size-3.5" />}
            {t("model.customProvider.test")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={closeCustom}>
              {t("button.cancel")}
            </Button>
            <Button size="sm" onClick={handleSaveCustom} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : t("button.save")}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ---- Configure Provider view ----
  if (configuring) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleBackToList}
            className="flex size-7 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            <ArrowLeft className="size-4" />
          </button>
          <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("model.configureProvider")}</h2>
        </div>

        {!selectedProvider ? (
          /* Step 1: Select a provider from registry */
          <>
            <p className="text-sm text-[var(--color-fg-muted)]">
              {t("model.configureProvider.selectHint")}
            </p>
            {/* Add a fully custom provider (OpenAI-compatible / Anthropic) */}
            <button
              type="button"
              onClick={handleShowCustom}
              className="flex w-full items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] px-4 py-3 text-left transition-colors hover:border-[var(--color-brand)] hover:bg-[var(--color-accent)]"
            >
              <Sparkles className="size-4 shrink-0 text-[var(--color-brand)]" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--color-fg)]">{t("model.customProvider.add")}</div>
                <div className="text-xs text-[var(--color-fg-muted)]">
                  {t("model.customProvider.hint")}
                </div>
              </div>
            </button>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-muted)]" />
              <input
                type="text"
                value={configSearch}
                onChange={(e) => setConfigSearch(e.target.value)}
                placeholder={t("model.searchPlaceholder")}
                className="w-full rounded-lg border border-[var(--color-border)] bg-transparent py-2.5 pl-10 pr-4 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                autoFocus
              />
            </div>
            <div className="max-h-[28rem] space-y-1 overflow-y-auto scrollbar-soft">
              {configFilteredProviders.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProvider(p)}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--color-accent)]"
                >
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-[var(--color-fg)]">{p.name}</span>
                    <span className="ml-2 text-xs text-[var(--color-fg-muted)]">{p.id}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className="text-[var(--color-fg-muted)]">
                      {p.models.length} {t("model.modelsAvailable")}
                    </span>
                    {p.connected.length > 0 && (
                      <span className="rounded-full bg-green-500/10 px-2 py-0.5 font-medium text-green-500">
                        {t("model.enabled")}
                      </span>
                    )}
                  </div>
                </button>
              ))}
              {configFilteredProviders.length === 0 && (
                <div className="py-6 text-center text-sm text-[var(--color-fg-muted)]">
                  {t("model.noProviders")}
                </div>
              )}
            </div>
          </>
        ) : (
          /* Step 2: Configure API key and base URL */
          <>
            <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-4 py-3">
              <div className="flex-1">
                <div className="text-sm font-medium text-[var(--color-fg)]">{selectedProvider.name}</div>
                <div className="text-xs text-[var(--color-fg-muted)]">
                  {selectedProvider.id} · {selectedProvider.models.length} {t("model.modelsAvailable")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedProvider(null)}
                className="text-xs text-[var(--color-brand)] hover:underline"
              >
                {t("model.configureProvider.change")}
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
                  {t("model.addProvider.apiKey")}
                </label>
                <input
                  type="password"
                  value={configApiKey}
                  onChange={(e) => setConfigApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                  autoFocus
                />
                {selectedProvider.env && selectedProvider.env.length > 0 && (
                  <p className="mt-1 text-[10px] text-[var(--color-fg-muted)]">
                    {t("model.configureProvider.envHint")}: {selectedProvider.env.join(", ")}
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
                  {t("model.addProvider.baseUrl")} ({t("model.configureProvider.optional")})
                </label>
                <input
                  type="text"
                  value={configBaseUrl}
                  onChange={(e) => setConfigBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={handleBackToList}>
                {t("button.cancel")}
              </Button>
              <Button size="sm" onClick={handleSaveConfig} disabled={saving || !configApiKey.trim()}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : t("button.save")}
              </Button>
            </div>
          </>
        )}
      </div>
    )
  }

  // ---- List view ----
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("model.dialogTitle")}</h2>
            {connectedCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                {connectedCount} {t("services.connected")}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t("settingsPage.models.desc")}</p>
        </div>
        <Button size="sm" onClick={handleShowConfig}>
          <Plus className="mr-1.5 size-3.5" />
          {t("model.configureProvider")}
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-muted)]" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("model.searchPlaceholder")}
          className="w-full rounded-lg border border-[var(--color-border)] bg-transparent py-2.5 pl-10 pr-4 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
        />
      </div>

      {/* Provider list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-[var(--color-fg-muted)]" />
        </div>
      ) : filteredProviders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-16">
          <Key className="size-10 text-[var(--color-fg-muted)]" />
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">{t("model.noProviders")}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={handleShowConfig}>
            <Plus className="mr-1.5 size-3.5" />
            {t("model.configureProvider")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredProviders.map((provider) => {
            const auth = getAuthInfo(provider.id)
            // When searching, auto-expand all; clicking header is disabled (search controls expand)
            const isExpanded = search ? true : expandedProvider === provider.id

            return (
              <div
                key={provider.id}
                className="rounded-lg border border-[var(--color-border)] transition-colors hover:border-[var(--color-fg-muted)]/30"
              >
                {/* Provider header (+ delete affordance for custom providers, as a
                    sibling button to avoid nesting interactive elements) */}
                <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => !search && setExpandedProvider(isExpanded ? null : provider.id)}
                  className="flex flex-1 min-w-0 items-center gap-3 px-4 py-3"
                >
                  <ChevronRight
                    className={cn(
                      "size-4 shrink-0 text-[var(--color-fg-muted)] transition-transform",
                      isExpanded && "rotate-90"
                    )}
                  />
                  <div className="flex-1 min-w-0 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--color-fg)]">{provider.name}</span>
                      {provider.connected.length > 0 && (
                        <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-500">
                          {t("model.enabled")}
                        </span>
                      )}
                      {isCustomProvider(provider) && (
                        <span className="rounded-full bg-[var(--color-brand)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--color-brand)]">
                          {t("model.customProvider.badge")}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-[var(--color-fg-muted)]">
                      {provider.connected.length} {t("model.modelsConnected")}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {auth?.set && (
                      <span className="flex items-center gap-1 text-[10px] text-[var(--color-fg-muted)]">
                        <Key className="size-3" />
                        {t("model.apiKeySet")}
                      </span>
                    )}
                  </div>
                </button>
                {isCustomProvider(provider) && (
                  deletingId === provider.id ? (
                    <span className="mr-2 flex size-8 shrink-0 items-center justify-center text-[var(--color-fg-muted)]">
                      <Loader2 className="size-4 animate-spin" />
                    </span>
                  ) : confirmDeleteId === provider.id ? (
                    <span className="mr-2 flex shrink-0 items-center gap-1">
                      <HoverLabelButton
                        label={t("model.customProvider.delete")}
                        onClick={() => handleDeleteProvider(provider.id)}
                        className="size-7 text-red-500 hover:bg-red-500/10"
                      >
                        <Check className="size-4" />
                      </HoverLabelButton>
                      <HoverLabelButton
                        label={t("button.cancel")}
                        onClick={() => setConfirmDeleteId(null)}
                        className="size-7 text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
                      >
                        <X className="size-4" />
                      </HoverLabelButton>
                    </span>
                  ) : (
                    <HoverLabelButton
                      label={t("model.customProvider.delete")}
                      onClick={() => setConfirmDeleteId(provider.id)}
                      className="mr-2 size-8 text-[var(--color-fg-muted)] hover:bg-red-500/10 hover:text-red-500"
                    >
                      <Trash2 className="size-4" />
                    </HoverLabelButton>
                  )
                )}
                </div>

                {/* Model list (expanded) */}
                {isExpanded && (() => {
                  const q = search.toLowerCase()
                  const filteredConnected = q
                    ? provider.connected.filter((modelId) => {
                        const modelInfo = provider.models.find((m) => m.id === modelId)
                        return (
                          modelId.toLowerCase().includes(q) ||
                          (modelInfo?.name ?? "").toLowerCase().includes(q)
                        )
                      })
                    : provider.connected

                  return (
                    <div className="border-t border-[var(--color-border)] px-4 py-2">
                      {filteredConnected.map((modelId) => {
                        const modelInfo = provider.models.find((m) => m.id === modelId)
                        const fullId = `${provider.id}/${modelId}`
                        const isActive = currentModel === fullId
                        const searchKey = `${provider.id}/${modelId}`
                        const searchOn = builtinSearchMap[searchKey] === true
                        // Toggle as a SIBLING of the select button (no nested
                        // interactive elements), same pattern as the provider
                        // header's delete affordance.
                        const showSearchToggle = isDashScopeLike(provider) || searchKey in builtinSearchMap

                        return (
                          <div key={modelId} className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleSelectModel(provider.id, modelId)}
                            className={cn(
                              "flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--color-accent)]",
                              isActive && "bg-[var(--color-accent)]"
                            )}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="truncate text-[var(--color-fg)]">
                                {modelInfo?.name || modelId}
                              </div>
                              {modelInfo?.cost && (
                                <div className="text-[10px] text-[var(--color-fg-muted)]">
                                  ${(modelInfo.cost.input ?? 0).toFixed(2)}/{t("model.mInput")} · ${(modelInfo.cost.output ?? 0).toFixed(2)}/{t("model.mOutput")}
                                </div>
                              )}
                            </div>
                            {isActive && (
                              <Check className="size-4 shrink-0 text-[var(--color-brand)]" />
                            )}
                          </button>
                          {showSearchToggle && (
                            <label
                              className="flex shrink-0 cursor-pointer items-center gap-1 px-2 text-[10px] text-[var(--color-fg-muted)]"
                              title={t("model.builtinSearch.hint")}
                            >
                              {togglingSearch === searchKey ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={searchOn}
                                  onChange={(e) =>
                                    handleToggleBuiltinSearch(provider.id, modelId, e.target.checked)
                                  }
                                  aria-label={`${t("model.builtinSearch.label")} ${modelId}`}
                                  className="size-3 accent-[var(--color-brand)]"
                                />
                              )}
                              {t("model.builtinSearch.label")}
                            </label>
                          )}
                          </div>
                        )
                      })}

                      {provider.models.length > provider.connected.length && (
                        <div className="px-3 py-1 text-[10px] text-[var(--color-fg-muted)]">
                          +{provider.models.length - provider.connected.length} {t("model.moreModels")}
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
