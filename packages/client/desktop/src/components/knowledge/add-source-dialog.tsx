import { useState, useCallback } from "react"
import { FolderOpen, Globe, Loader2, CheckCircle2, AlertCircle, ArrowLeft, Plug } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-context"

const KB_BASE = import.meta.env.DEV ? "/kb" : "http://localhost:4098/kb"

async function kbFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${KB_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`KB ${resp.status}: ${body}`)
  }
  const text = await resp.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

interface RemoteBase {
  id: string
  name: string
  description?: string
  documentCount?: number
}

type Step =
  | { type: "select" }
  | { type: "ima-credentials" }
  | { type: "ima-testing" }
  | { type: "ima-select-base"; sourceId: number; bases: RemoteBase[] }
  | { type: "ima-error"; message: string }
  | { type: "ima-saving" }

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
  onAddLocalFolder: () => void
}

export function AddSourceDialog({ open, onOpenChange, onAdded, onAddLocalFolder }: Props) {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>({ type: "select" })
  const [clientId, setClientId] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [showApiKey, setShowApiKey] = useState(false)

  const reset = useCallback(() => {
    setStep({ type: "select" })
    setClientId("")
    setApiKey("")
    setShowApiKey(false)
  }, [])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) reset()
      onOpenChange(open)
    },
    [onOpenChange, reset],
  )

  const handleSelectLocal = useCallback(() => {
    handleOpenChange(false)
    onAddLocalFolder()
  }, [handleOpenChange, onAddLocalFolder])

  const handleTestConnection = useCallback(async () => {
    setStep({ type: "ima-testing" })
    let createdId: number | null = null
    try {
      // Create IMA source
      const { id } = await kbFetch<{ id: number }>("/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "ima",
          name: "Tencent IMA",
          config: { clientId, apiKey },
        }),
      })
      createdId = id

      // Test connection
      const result = await kbFetch<{ ok: boolean; message?: string; bases?: RemoteBase[] }>(
        `/sources/${id}/test-connection`,
        { method: "POST" },
      )

      if (result.ok && result.bases && result.bases.length > 0) {
        setStep({ type: "ima-select-base", sourceId: id, bases: result.bases })
      } else if (result.ok && (!result.bases || result.bases.length === 0)) {
        await kbFetch(`/sources/${id}`, { method: "DELETE" }).catch(() => {})
        createdId = null
        setStep({ type: "ima-error", message: t("knowledge.noBasesFound") })
      } else {
        await kbFetch(`/sources/${id}`, { method: "DELETE" }).catch(() => {})
        createdId = null
        setStep({ type: "ima-error", message: result.message || t("knowledge.connectionFailed") })
      }
    } catch (err) {
      // Clean up orphaned source if creation succeeded but test failed
      if (createdId != null) {
        await kbFetch(`/sources/${createdId}`, { method: "DELETE" }).catch(() => {})
      }
      setStep({
        type: "ima-error",
        message: err instanceof Error ? err.message : t("knowledge.connectionFailed"),
      })
    }
  }, [clientId, apiKey, t])

  const handleSelectBase = useCallback(
    async (base: RemoteBase) => {
      if (step.type !== "ima-select-base") return
      setStep({ type: "ima-saving" })
      try {
        // Update source with selected knowledge base
        await kbFetch(`/sources/${step.sourceId}`, {
          method: "PUT",
          body: JSON.stringify({
            name: base.name,
            config: {
              clientId,
              apiKey,
              knowledgeBaseId: base.id,
              knowledgeBaseName: base.name,
            },
          }),
        })

        // Set status to connected
        await kbFetch(`/sources/${step.sourceId}/test-connection`, { method: "POST" })

        handleOpenChange(false)
        onAdded()
      } catch (err) {
        setStep({
          type: "ima-error",
          message: err instanceof Error ? err.message : "Failed to save",
        })
      }
    },
    [step, clientId, apiKey, handleOpenChange, onAdded],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        {step.type === "select" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("knowledge.addSource")}</DialogTitle>
              <DialogDescription>{t("knowledge.sourceType")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <button
                onClick={handleSelectLocal}
                className="flex w-full items-center gap-3 rounded-lg border border-[var(--color-border)] p-4 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-blue-500/10">
                  <FolderOpen className="size-5 text-blue-500" />
                </div>
                <div>
                  <div className="text-sm font-medium text-[var(--color-fg)]">
                    {t("knowledge.localFolder")}
                  </div>
                  <div className="text-xs text-[var(--color-fg-muted)]">
                    {t("knowledge.localDescription")}
                  </div>
                </div>
              </button>
              <button
                onClick={() => setStep({ type: "ima-credentials" })}
                className="flex w-full items-center gap-3 rounded-lg border border-[var(--color-border)] p-4 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-purple-500/10">
                  <Globe className="size-5 text-purple-500" />
                </div>
                <div>
                  <div className="text-sm font-medium text-[var(--color-fg)]">
                    {t("knowledge.imaKnowledge")}
                  </div>
                  <div className="text-xs text-[var(--color-fg-muted)]">
                    {t("knowledge.imaDescription")}
                  </div>
                </div>
              </button>
              <div
                className="flex w-full cursor-not-allowed items-center gap-3 rounded-lg border border-[var(--color-border)] p-4 text-left opacity-50"
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-gray-500/10">
                  <Plug className="size-5 text-gray-400" />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-[var(--color-fg)]">
                    {t("knowledge.customApi")}
                  </div>
                  <div className="text-xs text-[var(--color-fg-muted)]">
                    {t("knowledge.customApiDescription")}
                  </div>
                </div>
                <span className="shrink-0 rounded bg-[var(--color-bg-hover)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
                  {t("knowledge.comingSoon")}
                </span>
              </div>
            </div>
          </>
        )}

        {step.type === "ima-credentials" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <button onClick={() => setStep({ type: "select" })} className="rounded p-0.5 hover:bg-[var(--color-bg-hover)]">
                  <ArrowLeft className="size-4" />
                </button>
                {t("knowledge.imaKnowledge")}
              </DialogTitle>
              <DialogDescription>{t("knowledge.imaInstructions")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">
                  {t("knowledge.clientId")}
                </label>
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="ima-openapi-clientid"
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">
                  {t("knowledge.apiKey")}
                </label>
                <div className="relative">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="ima-openapi-apikey"
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 pr-16 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                  >
                    {showApiKey ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <Button
                onClick={handleTestConnection}
                disabled={!clientId.trim() || !apiKey.trim()}
                className="w-full"
              >
                {t("knowledge.testConnection")}
              </Button>
            </div>
          </>
        )}

        {step.type === "ima-testing" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("knowledge.imaKnowledge")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="size-8 animate-spin text-[var(--color-fg-muted)]" />
              <p className="mt-3 text-sm text-[var(--color-fg-muted)]">{t("knowledge.testing")}</p>
            </div>
          </>
        )}

        {step.type === "ima-select-base" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-green-500" />
                {t("knowledge.selectKnowledgeBase")}
              </DialogTitle>
              <DialogDescription>{t("knowledge.connectionSuccess")}</DialogDescription>
            </DialogHeader>
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {step.bases.map((base) => (
                <button
                  key={base.id}
                  onClick={() => handleSelectBase(base)}
                  className="flex w-full items-center justify-between rounded-lg border border-[var(--color-border)] p-3 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--color-fg)]">
                      {base.name}
                    </div>
                    {base.description && (
                      <div className="mt-0.5 truncate text-xs text-[var(--color-fg-muted)]">
                        {base.description}
                      </div>
                    )}
                  </div>
                  {base.documentCount != null && (
                    <span className="ml-2 shrink-0 text-xs text-[var(--color-fg-muted)]">
                      {t("knowledge.documents").replace("{count}", String(base.documentCount))}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        {step.type === "ima-error" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("knowledge.connectionFailed")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center py-6">
              <AlertCircle className="size-8 text-red-500" />
              <p className="mt-3 text-center text-sm text-red-500">{step.message}</p>
              <Button
                variant="outline"
                onClick={() => setStep({ type: "ima-credentials" })}
                className="mt-4"
              >
                {t("knowledge.back")}
              </Button>
            </div>
          </>
        )}

        {step.type === "ima-saving" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("knowledge.save")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="size-8 animate-spin text-[var(--color-fg-muted)]" />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
