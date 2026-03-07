import { useState, useEffect, useMemo } from "react"
import { ChevronDown, Check, Cpu, Loader2, Search } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import type { Provider, ProviderModel } from "@agent/api-client"

interface ModelSelectorProps {
  currentModel: string
  onModelChange: (model: string) => void
  onOpenModelDialog?: () => void
  className?: string
}

interface FlatModel {
  id: string // "provider/model"
  name: string
  providerName: string
}

export function ModelSelector({ currentModel, onModelChange, onOpenModelDialog, className }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<FlatModel[]>([])
  const [loading, setLoading] = useState(false)
  const [hasFetched, setHasFetched] = useState(false)
  const [search, setSearch] = useState("")
  const api = useApi()
  const { t } = useI18n()

  // Reset cache and search when popover opens
  useEffect(() => {
    if (open) {
      setHasFetched(false)
      setSearch("")
    }
  }, [open])

  useEffect(() => {
    if (!open || hasFetched) return
    let cancelled = false
    setLoading(true)
    api.getProviders()
      .then((providers: Provider[]) => {
        if (cancelled) return
        const flat: FlatModel[] = []
        for (const provider of providers) {
          if (provider.connected.length === 0) continue
          for (const modelId of provider.connected) {
            const modelInfo = provider.models.find((m: ProviderModel) => m.id === modelId)
            flat.push({
              id: `${provider.id}/${modelId}`,
              name: modelInfo?.name || modelId,
              providerName: provider.name,
            })
          }
        }
        setModels(flat)
        setHasFetched(true)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, api, hasFetched])

  const filteredModels = useMemo(() => {
    if (!search) return models
    const q = search.toLowerCase()
    return models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.providerName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
    )
  }, [models, search])

  const currentLabel = currentModel
    ? currentModel.split("/").pop() || currentModel
    : t("model.noModel")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]",
            className
          )}
        >
          <Cpu className="size-3" />
          <span className="max-w-[120px] truncate">{currentLabel}</span>
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-0">
        {/* Search */}
        <div className="border-b border-[var(--color-border)] px-2 py-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--color-fg-muted)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("model.searchPlaceholder")}
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent py-1.5 pl-7 pr-2 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-60 overflow-y-auto scrollbar-soft">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-[var(--color-fg-muted)]" />
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-[var(--color-fg-muted)]">
              {t("model.noModels")}
            </div>
          ) : (
            filteredModels.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => {
                  onModelChange(model.id)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--color-accent)]",
                  currentModel === model.id && "bg-[var(--color-accent)]"
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium text-[var(--color-fg)]">{model.name}</div>
                  <div className="truncate text-[var(--color-fg-muted)]">{model.providerName}</div>
                </div>
                {currentModel === model.id && (
                  <Check className="size-3 shrink-0 text-[var(--color-brand)]" />
                )}
              </button>
            ))
          )}
        </div>
        {onOpenModelDialog && (
          <div className="border-t border-[var(--color-border)] p-2">
            <button
              type="button"
              onClick={() => {
                onOpenModelDialog()
                setOpen(false)
              }}
              className="w-full rounded-md px-3 py-1.5 text-xs text-[var(--color-brand)] transition-colors hover:bg-[var(--color-accent)]"
            >
              {t("model.manage")}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
