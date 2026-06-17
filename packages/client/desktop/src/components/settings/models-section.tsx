import { useState, useEffect, useCallback, useRef } from "react"
import { Search, Check, ChevronRight, Plus, Loader2, Key, ArrowLeft } from "lucide-react"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { useModel } from "@/lib/model-context"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { clearModelCache } from "@/components/chat/model-selector"
import type { Provider, ProviderAuthInfo } from "@agent/api-client"

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
  useEffect(() => () => { mountedRef.current = false }, [])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [provs, auths] = await Promise.all([
        api.getProviders(),
        api.getProviderAuth(),
      ])
      setProviders(provs)
      setAuthInfos(auths)
    } catch (err) {
      console.error("Failed to fetch providers:", err)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    fetchData()
  }, [fetchData])

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
        await api.patchConfig({
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
                {/* Provider header */}
                <button
                  type="button"
                  onClick={() => !search && setExpandedProvider(isExpanded ? null : provider.id)}
                  className="flex w-full items-center gap-3 px-4 py-3"
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

                        return (
                          <button
                            key={modelId}
                            type="button"
                            onClick={() => handleSelectModel(provider.id, modelId)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--color-accent)]",
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
