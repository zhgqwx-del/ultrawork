import { useState, useEffect, useCallback } from "react"
import { Search, Check, X, ChevronRight, Plus, Loader2, Key } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import type { Provider, ProviderAuthInfo } from "@agent/api-client"

interface ModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentModel: string
  onModelChange: (model: string) => void
}

export function ModelDialog({ open, onOpenChange, currentModel, onModelChange }: ModelDialogProps) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [authInfos, setAuthInfos] = useState<ProviderAuthInfo[]>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [addProviderOpen, setAddProviderOpen] = useState(false)
  const api = useApi()
  const { t } = useI18n()

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
    }
  }, [open, fetchData])

  const filteredProviders = providers.filter((p) => {
    if (!search) return p.connected.length > 0
    const q = search.toLowerCase()
    return (
      p.name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      p.models.some((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    )
  })

  const getAuthInfo = (providerId: string) => {
    return authInfos.find((a) => a.id === providerId || a.name.toLowerCase() === providerId.toLowerCase())
  }

  const handleSelectModel = (providerId: string, modelId: string) => {
    const fullId = `${providerId}/${modelId}`
    onModelChange(fullId)
    onOpenChange(false)
  }

  return (
    <>
      <Dialog open={open && !addProviderOpen} onOpenChange={(v) => { if (!addProviderOpen) onOpenChange(v) }}>
        <DialogContent className="max-w-3xl border-[--color-border] bg-[--color-bg] text-[--color-fg]">
          <DialogHeader>
            <DialogTitle className="text-lg">{t("model.dialogTitle")}</DialogTitle>
          </DialogHeader>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[--color-fg-muted]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("model.searchPlaceholder")}
              className="w-full rounded-lg border border-[--color-border] bg-transparent py-2.5 pl-10 pr-4 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-1 focus:ring-[--color-brand]"
            />
          </div>

          {/* Provider List */}
          <div className="max-h-96 space-y-2 overflow-y-auto scrollbar-soft">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-[--color-fg-muted]" />
              </div>
            ) : filteredProviders.length === 0 ? (
              <div className="py-8 text-center text-sm text-[--color-fg-muted]">
                {t("model.noProviders")}
              </div>
            ) : (
              filteredProviders.map((provider) => {
                const auth = getAuthInfo(provider.id)
                const isExpanded = expandedProvider === provider.id

                return (
                  <div
                    key={provider.id}
                    className="rounded-lg border border-[--color-border] transition-colors hover:border-[--color-fg-muted]/30"
                  >
                    {/* Provider header */}
                    <button
                      type="button"
                      onClick={() => setExpandedProvider(isExpanded ? null : provider.id)}
                      className="flex w-full items-center gap-3 px-4 py-3"
                    >
                      <ChevronRight
                        className={cn(
                          "size-4 shrink-0 text-[--color-fg-muted] transition-transform",
                          isExpanded && "rotate-90"
                        )}
                      />
                      <div className="flex-1 min-w-0 text-left">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[--color-fg]">{provider.name}</span>
                          {provider.connected.length > 0 && (
                            <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-500">
                              {t("model.enabled")}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-[--color-fg-muted]">
                          {provider.connected.length} {t("model.modelsConnected")}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {auth?.set && (
                          <span className="flex items-center gap-1 text-[10px] text-[--color-fg-muted]">
                            <Key className="size-3" />
                            {t("model.apiKeySet")}
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Model list (expanded) */}
                    {isExpanded && (
                      <div className="border-t border-[--color-border] px-4 py-2">
                        {provider.connected.map((modelId) => {
                          const modelInfo = provider.models.find((m) => m.id === modelId)
                          const fullId = `${provider.id}/${modelId}`
                          const isActive = currentModel === fullId

                          return (
                            <button
                              key={modelId}
                              type="button"
                              onClick={() => handleSelectModel(provider.id, modelId)}
                              className={cn(
                                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[--color-accent]",
                                isActive && "bg-[--color-accent]"
                              )}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="truncate text-[--color-fg]">
                                  {modelInfo?.name || modelId}
                                </div>
                                {modelInfo?.cost && (
                                  <div className="text-[10px] text-[--color-fg-muted]">
                                    ${(modelInfo.cost.input ?? 0).toFixed(2)}/{t("model.mInput")} · ${(modelInfo.cost.output ?? 0).toFixed(2)}/{t("model.mOutput")}
                                  </div>
                                )}
                              </div>
                              {isActive && (
                                <Check className="size-4 shrink-0 text-[--color-brand]" />
                              )}
                            </button>
                          )
                        })}

                        {/* Show unconnected models count */}
                        {provider.models.length > provider.connected.length && (
                          <div className="px-3 py-1 text-[10px] text-[--color-fg-muted]">
                            +{provider.models.length - provider.connected.length} {t("model.moreModels")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>

          {/* Add Provider button */}
          <button
            type="button"
            onClick={() => setAddProviderOpen(true)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[--color-border] py-3 text-sm text-[--color-fg-muted] transition-colors hover:border-[--color-brand] hover:text-[--color-brand]"
          >
            <Plus className="size-4" />
            {t("model.addProvider")}
          </button>
        </DialogContent>
      </Dialog>

      {/* AddProviderDialog */}
      <AddProviderDialog
        open={addProviderOpen}
        onOpenChange={setAddProviderOpen}
        onCreated={() => {
          setAddProviderOpen(false)
          fetchData()
        }}
      />
    </>
  )
}

// --- AddProviderDialog ---

interface AddProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

function AddProviderDialog({ open, onOpenChange, onCreated }: AddProviderDialogProps) {
  const [displayName, setDisplayName] = useState("")
  const [providerId, setProviderId] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [models, setModels] = useState([{ id: "", name: "" }])
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const api = useApi()
  const { t } = useI18n()

  useEffect(() => {
    if (open) {
      setDisplayName("")
      setProviderId("")
      setBaseUrl("")
      setApiKey("")
      setModels([{ id: "", name: "" }])
      setErrors({})
    }
  }, [open])

  const validate = (): boolean => {
    const errs: Record<string, string> = {}
    if (!displayName.trim()) errs.displayName = t("model.addProvider.required")
    if (!providerId.trim()) errs.providerId = t("model.addProvider.required")
    if (!baseUrl.trim()) errs.baseUrl = t("model.addProvider.required")
    if (!models[0]?.id.trim()) errs.modelId = t("model.addProvider.required")
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleCreate = async () => {
    if (!validate()) return
    setSaving(true)
    try {
      // Set API key if provided
      if (apiKey.trim()) {
        await api.putProviderAuth(providerId, { apiKey: apiKey.trim() })
      }
      // Update config to add the provider
      await api.patchConfig({
        provider: {
          [providerId]: {
            options: {
              ...(baseUrl.trim() ? { baseURL: baseUrl.trim() } : {}),
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            },
          },
        },
      })
      onCreated()
    } catch (err) {
      console.error("Failed to create provider:", err)
    } finally {
      setSaving(false)
    }
  }

  const addModel = () => setModels([...models, { id: "", name: "" }])
  const removeModel = (index: number) => {
    if (models.length <= 1) return
    setModels(models.filter((_, i) => i !== index))
  }
  const updateModel = (index: number, field: "id" | "name", value: string) => {
    const updated = [...models]
    updated[index] = { ...updated[index], [field]: value }
    setModels(updated)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-[--color-border] bg-[--color-bg] text-[--color-fg]">
        <DialogHeader>
          <DialogTitle className="text-lg">{t("model.addProvider")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Two column form */}
          <div className="grid grid-cols-2 gap-4">
            {/* Display Name */}
            <div>
              <label className="mb-1 block text-xs font-medium text-[--color-fg-muted]">
                {t("model.addProvider.displayName")}
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="My Custom Provider"
                className="w-full rounded-md border border-[--color-border] bg-transparent px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-1 focus:ring-[--color-brand]"
              />
              {errors.displayName && <p className="mt-1 text-xs text-red-500">{errors.displayName}</p>}
            </div>

            {/* Provider ID */}
            <div>
              <label className="mb-1 block text-xs font-medium text-[--color-fg-muted]">
                {t("model.addProvider.providerId")}
              </label>
              <input
                type="text"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                placeholder="my-custom-provider"
                className="w-full rounded-md border border-[--color-border] bg-transparent px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-1 focus:ring-[--color-brand]"
              />
              {errors.providerId && <p className="mt-1 text-xs text-red-500">{errors.providerId}</p>}
            </div>

            {/* Base URL */}
            <div>
              <label className="mb-1 block text-xs font-medium text-[--color-fg-muted]">
                {t("model.addProvider.baseUrl")}
              </label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="w-full rounded-md border border-[--color-border] bg-transparent px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-1 focus:ring-[--color-brand]"
              />
              {errors.baseUrl && <p className="mt-1 text-xs text-red-500">{errors.baseUrl}</p>}
            </div>

            {/* API Key */}
            <div>
              <label className="mb-1 block text-xs font-medium text-[--color-fg-muted]">
                {t("model.addProvider.apiKey")}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="{env:MY_API_KEY} or sk-..."
                className="w-full rounded-md border border-[--color-border] bg-transparent px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-1 focus:ring-[--color-brand]"
              />
            </div>
          </div>

          {/* Models */}
          <div>
            <label className="mb-2 block text-xs font-medium text-[--color-fg-muted]">
              {t("model.addProvider.models")}
            </label>
            <div className="space-y-2">
              {models.map((model, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={model.id}
                    onChange={(e) => updateModel(index, "id", e.target.value)}
                    placeholder={t("model.addProvider.modelId")}
                    className="flex-1 rounded-md border border-[--color-border] bg-transparent px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-1 focus:ring-[--color-brand]"
                  />
                  <input
                    type="text"
                    value={model.name}
                    onChange={(e) => updateModel(index, "name", e.target.value)}
                    placeholder={t("model.addProvider.modelName")}
                    className="flex-1 rounded-md border border-[--color-border] bg-transparent px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-1 focus:ring-[--color-brand]"
                  />
                  <button
                    type="button"
                    onClick={() => removeModel(index)}
                    disabled={models.length <= 1}
                    className="flex size-8 items-center justify-center rounded-md text-[--color-fg-muted] transition-colors hover:bg-[--color-accent] hover:text-red-500 disabled:opacity-30"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
              {errors.modelId && <p className="text-xs text-red-500">{errors.modelId}</p>}
            </div>
            <button
              type="button"
              onClick={addModel}
              className="mt-2 flex items-center gap-1 text-xs text-[--color-brand] hover:underline"
            >
              <Plus className="size-3" />
              {t("model.addProvider.addModel")}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-[--color-border] px-4 py-2 text-sm text-[--color-fg] transition-colors hover:bg-[--color-accent]"
          >
            {t("button.cancel")}
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving}
            className="rounded-md bg-[--color-brand] px-4 py-2 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : t("model.addProvider.create")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
