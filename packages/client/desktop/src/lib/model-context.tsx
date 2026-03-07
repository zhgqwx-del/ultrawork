import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react"
import { toast } from "sonner"
import { useApi } from "./use-api"
import { useI18n } from "./i18n-context"
import type { OpenCodeConfig } from "@agent/api-client"

interface ModelContextValue {
  currentModel: string
  setModel: (model: string) => Promise<void>
  modelDialogOpen: boolean
  openModelDialog: () => void
  closeModelDialog: () => void
}

const ModelContext = createContext<ModelContextValue | undefined>(undefined)

export function ModelProvider({ children }: { children: React.ReactNode }) {
  const [currentModel, setCurrentModel] = useState("")
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const api = useApi()
  const { t } = useI18n()

  // Load current model from server config on mount
  useEffect(() => {
    let cancelled = false
    api.getConfig()
      .then((cfg: OpenCodeConfig) => {
        if (!cancelled && cfg.model) setCurrentModel(cfg.model)
      })
      .catch(() => { /* ignore — server may not be ready */ })
    return () => { cancelled = true }
  }, [api])

  const setModel = useCallback(async (model: string) => {
    try {
      await api.patchConfig({ model })
      setCurrentModel(model)
      toast.success(t("model.switchSuccess"))
    } catch {
      toast.error(t("error.switchModel"))
    }
  }, [api, t])

  const openModelDialog = useCallback(() => setModelDialogOpen(true), [])
  const closeModelDialog = useCallback(() => setModelDialogOpen(false), [])

  const value = useMemo(() => ({
    currentModel, setModel, modelDialogOpen, openModelDialog, closeModelDialog,
  }), [currentModel, setModel, modelDialogOpen, openModelDialog, closeModelDialog])

  return (
    <ModelContext.Provider value={value}>
      {children}
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
