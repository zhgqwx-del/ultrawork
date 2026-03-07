import { useState, useEffect } from "react"
import { ChevronDown, Check, Cpu, Loader2 } from "lucide-react"
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
  const api = useApi()
  const { t } = useI18n()

  // Reset cache when popover opens so fresh data is fetched each time
  useEffect(() => {
    if (open) setHasFetched(false)
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

  const currentLabel = currentModel
    ? currentModel.split("/").pop() || currentModel
    : t("model.noModel")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[--color-fg-muted] transition-colors hover:bg-[--color-accent] hover:text-[--color-fg]",
            className
          )}
        >
          <Cpu className="size-3" />
          <span className="max-w-[120px] truncate">{currentLabel}</span>
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-64 p-0">
        <div className="border-b border-[--color-border] px-3 py-2">
          <p className="text-xs font-medium text-[--color-fg]">{t("model.selectModel")}</p>
        </div>
        <div className="max-h-60 overflow-y-auto scrollbar-soft">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-[--color-fg-muted]" />
            </div>
          ) : models.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-[--color-fg-muted]">
              {t("model.noModels")}
            </div>
          ) : (
            models.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => {
                  onModelChange(model.id)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[--color-accent]",
                  currentModel === model.id && "bg-[--color-accent]"
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium text-[--color-fg]">{model.name}</div>
                  <div className="truncate text-[--color-fg-muted]">{model.providerName}</div>
                </div>
                {currentModel === model.id && (
                  <Check className="size-3 shrink-0 text-[--color-brand]" />
                )}
              </button>
            ))
          )}
        </div>
        {onOpenModelDialog && (
          <div className="border-t border-[--color-border] p-2">
            <button
              type="button"
              onClick={() => {
                onOpenModelDialog()
                setOpen(false)
              }}
              className="w-full rounded-md px-3 py-1.5 text-xs text-[--color-brand] transition-colors hover:bg-[--color-accent]"
            >
              {t("model.manage")}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
