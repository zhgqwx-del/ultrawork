import { useState, useEffect, useCallback, useRef } from "react"
import { Search, Check, ChevronRight, Plus, Loader2, Key, ArrowLeft } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { clearModelCache } from "@/components/chat/model-selector"
import type { Provider, ProviderAuthInfo } from "@agent/api-client"

interface ModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentModel: string
  onModelChange: (model: string) => void
}

type View = "list" | "configure"

export function ModelDialog({ open, onOpenChange, currentModel, onModelChange }: ModelDialogProps) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [authInfos, setAuthInfos] = useState<ProviderAuthInfo[]>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [view, setView] = useState<View>("list")
  const api = useApi()
  const { t } = useI18n()

  // Configure provider form state
  const [configSearch, setConfigSearch] = useState("")
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null)
  const [configApiKey, setConfigApiKey] = useState("")
  const [configBaseUrl, setConfigBaseUrl] = useState("")
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

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
    if (open) {
      fetchData()
      setSearch("")
      setExpandedProvider(null)
      setView("list")
    }
  }, [open, fetchData])

  const handleShowConfigView = () => {
    setConfigSearch("")
    setSelectedProvider(null)
    setConfigApiKey("")
    setConfigBaseUrl("")
    setView("configure")
  }

  const handleBackToList = () => {
    setView("list")
  }

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
    .sort((a, b) => {
      const ac = a.connected.length > 0 ? 1 : 0
      const bc = b.connected.length > 0 ? 1 : 0
      if (ac !== bc) return bc - ac
      return a.name.localeCompare(b.name)
    })

  const getAuthInfo = (pid: string) => {
    return authInfos.find((a) => a.id === pid || a.name.toLowerCase() === pid.toLowerCase())
  }

  const handleSelectModel = (pid: string, modelId: string) => {
    const fullId = `${pid}/${modelId}`
    onModelChange(fullId)
    onOpenChange(false)
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
    savingRef.current = true
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
      toast.success(t("model.addProvider.success"))
      // Invalidate ModelSelector cache so it picks up new provider immediately
      clearModelCache()
      // Go back to list; clear search so the new provider appears in the default view
      setSearch("")
      setView("list")
      fetchData()
    } catch (err) {
      console.error("Failed to configure provider:", err)
      toast.error(t("model.addProvider.error"))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const handleOpenChange = useCallback((v: boolean) => {
    if (!v && savingRef.current) return
    onOpenChange(v)
  }, [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-3xl text-[var(--color-fg)]"
        onInteractOutside={(e) => {
          if (view === "configure" || savingRef.current) e.preventDefault()
        }}
        onPointerDownOutside={(e) => {
          if (view === "configure" || savingRef.current) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (savingRef.current) e.preventDefault()
        }}
      >
        {view === "list" ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-lg">{t("model.dialogTitle")}</DialogTitle>
              <DialogDescription className="sr-only">{t("model.dialogTitle")}</DialogDescription>
            </DialogHeader>

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

            {/* Provider List */}
            <div className="max-h-96 space-y-2 overflow-y-auto scrollbar-soft">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-[var(--color-fg-muted)]" />
                </div>
              ) : filteredProviders.length === 0 ? (
                <div className="py-8 text-center text-sm text-[var(--color-fg-muted)]">
                  {t("model.noProviders")}
                </div>
              ) : (
                filteredProviders.map((provider) => {
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
                })
              )}
            </div>

            {/* Configure Provider button */}
            <button
              type="button"
              onClick={handleShowConfigView}
              className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[var(--color-border)] py-3 text-sm text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-brand)] hover:text-[var(--color-brand)]"
            >
              <Plus className="size-4" />
              {t("model.configureProvider")}
            </button>
          </>
        ) : (
          /* ---- Configure Provider View ---- */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg">
                <button
                  type="button"
                  onClick={handleBackToList}
                  className="flex size-7 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
                >
                  <ArrowLeft className="size-4" />
                </button>
                {t("model.configureProvider")}
              </DialogTitle>
              <DialogDescription className="sr-only">{t("model.configureProvider")}</DialogDescription>
            </DialogHeader>

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
                <div className="max-h-72 space-y-1 overflow-y-auto scrollbar-soft">
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
                  <button
                    type="button"
                    onClick={handleBackToList}
                    className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-fg)] transition-colors hover:bg-[var(--color-accent)]"
                  >
                    {t("button.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleSaveConfig()
                    }}
                    disabled={saving || !configApiKey.trim()}
                    className="rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="size-4 animate-spin" /> : t("button.save")}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
