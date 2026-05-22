import { useState, useCallback, useRef } from "react"
import { FolderOpen, Globe, Loader2, CheckCircle2, AlertCircle, ArrowLeft, Plug, FileText, BookOpen, ExternalLink } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-context"
import { toast } from "sonner"

const KB_BASE = import.meta.env.DEV ? "/kb" : "http://localhost:4098/kb"
const IMA_CREDENTIAL_URL = "https://ima.qq.com/agent-interface"

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

type IMAModule = "wiki" | "notes"

type Step =
  | { type: "select" }
  | { type: "ima-credentials" }
  | { type: "ima-testing" }
  | { type: "ima-select-module" }
  | { type: "ima-loading-bases"; module: IMAModule }
  | { type: "ima-select-base"; sourceId: number; bases: RemoteBase[]; module: IMAModule }
  | { type: "ima-error"; message: string }
  | { type: "ima-saving" }

/** Existing IMA source config shape (after sanitization — apiKey stripped, hasApiKey present) */
interface ExistingIMASource {
  type: "ima"
  config: {
    clientId?: string
    hasApiKey?: boolean
    module?: string
    [key: string]: unknown
  }
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
  onAddLocalFolder: () => void
  /** Existing sources — used to detect reusable IMA credentials */
  existingSources?: { type: string; config: Record<string, unknown> }[]
}

export function AddSourceDialog({ open, onOpenChange, onAdded, onAddLocalFolder, existingSources }: Props) {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>({ type: "select" })
  const [clientId, setClientId] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [showApiKey, setShowApiKey] = useState(false)
  const savingRef = useRef(false)
  const isFirstIMASource = useRef(true)

  /** Check if there's an existing IMA source whose credentials we can reuse */
  const getExistingIMACredentials = useCallback((): { clientId: string } | null => {
    if (!existingSources) return null
    const imaSrc = existingSources.find(
      (s) => s.type === "ima" && s.config?.clientId,
    ) as ExistingIMASource | undefined
    if (imaSrc?.config?.clientId && imaSrc.config.hasApiKey) {
      return { clientId: imaSrc.config.clientId }
    }
    return null
  }, [existingSources])

  const reset = useCallback(() => {
    setStep({ type: "select" })
    setClientId("")
    setApiKey("")
    setShowApiKey(false)
    savingRef.current = false
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

  /** Handle IMA button click — pre-fill clientId if reusable from existing source */
  const handleSelectIMA = useCallback(() => {
    const existing = getExistingIMACredentials()
    if (existing) {
      // Pre-fill clientId; apiKey is stripped by sanitizeConfig so user must re-enter it
      isFirstIMASource.current = false
      setClientId(existing.clientId)
    } else {
      isFirstIMASource.current = true
    }
    setStep({ type: "ima-credentials" })
  }, [getExistingIMACredentials])

  /** Open IMA credential page in system browser */
  const handleOpenCredentialPage = useCallback(async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener")
      await openUrl(IMA_CREDENTIAL_URL)
    } catch {
      // Fallback for dev mode / non-Tauri environment
      window.open(IMA_CREDENTIAL_URL, "_blank")
    }
  }, [])

  /** Test credentials by trying the Wiki API (lightweight call) */
  const handleTestConnection = useCallback(async () => {
    setStep({ type: "ima-testing" })
    let tempId: number | null = null
    try {
      // Quick validation: try listing wiki bases (same auth for both modules)
      const tempSource = await kbFetch<{ id: number }>("/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "ima",
          name: "Tencent IMA",
          config: { clientId, apiKey, module: "wiki" },
        }),
      })
      tempId = tempSource.id

      const result = await kbFetch<{ ok: boolean; message?: string }>(
        `/sources/${tempId}/test-connection`,
        { method: "POST" },
      )

      // Clean up temp source — we'll create the real one after module selection
      await kbFetch(`/sources/${tempId}`, { method: "DELETE" }).catch(() => {})
      tempId = null

      if (result.ok) {
        setStep({ type: "ima-select-module" })
      } else {
        setStep({ type: "ima-error", message: result.message || t("knowledge.connectionFailed") })
      }
    } catch (err) {
      if (tempId != null) {
        await kbFetch(`/sources/${tempId}`, { method: "DELETE" }).catch(() => {})
      }
      setStep({
        type: "ima-error",
        message: err instanceof Error ? err.message : t("knowledge.connectionFailed"),
      })
    }
  }, [clientId, apiKey, t])

  /** After module selection, create source and load bases/notebooks */
  const handleSelectModule = useCallback(async (module: IMAModule) => {
    setStep({ type: "ima-loading-bases", module })
    let createdId: number | null = null
    try {
      const sourceName = module === "notes" ? "IMA Notes" : "IMA Wiki"
      const { id } = await kbFetch<{ id: number }>("/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "ima",
          name: sourceName,
          config: { clientId, apiKey, module },
        }),
      })
      createdId = id

      // Test connection to get bases/notebooks list
      const result = await kbFetch<{ ok: boolean; message?: string; bases?: RemoteBase[] }>(
        `/sources/${id}/test-connection`,
        { method: "POST" },
      )

      if (result.ok && result.bases && result.bases.length > 0) {
        setStep({ type: "ima-select-base", sourceId: id, bases: result.bases, module })
      } else if (result.ok) {
        await kbFetch(`/sources/${id}`, { method: "DELETE" }).catch(() => {})
        const noItemsMsg = module === "notes"
          ? t("knowledge.noNotebooksFound")
          : t("knowledge.noBasesFound")
        setStep({ type: "ima-error", message: noItemsMsg })
      } else {
        await kbFetch(`/sources/${id}`, { method: "DELETE" }).catch(() => {})
        setStep({ type: "ima-error", message: result.message || t("knowledge.connectionFailed") })
      }
    } catch (err) {
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
      if (step.type !== "ima-select-base" || savingRef.current) return
      savingRef.current = true
      setStep({ type: "ima-saving" })
      try {
        const isNotes = step.module === "notes"
        // Update source with selected base/notebook
        await kbFetch(`/sources/${step.sourceId}`, {
          method: "PUT",
          body: JSON.stringify({
            name: base.name,
            config: {
              clientId,
              apiKey,
              module: step.module,
              ...(isNotes
                ? { notebookId: base.id, notebookName: base.name }
                : { knowledgeBaseId: base.id, knowledgeBaseName: base.name }),
            },
          }),
        })

        // Set status to connected
        await kbFetch(`/sources/${step.sourceId}/test-connection`, { method: "POST" })

        // Show persistence toast on first IMA source
        if (isFirstIMASource.current) {
          toast.success(t("knowledge.credentialsSaved"))
        }

        handleOpenChange(false)
        onAdded()
      } catch (err) {
        savingRef.current = false
        setStep({
          type: "ima-error",
          message: err instanceof Error ? err.message : "Failed to save",
        })
      }
    },
    [step, clientId, apiKey, handleOpenChange, onAdded, t],
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
                onClick={handleSelectIMA}
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
              <DialogDescription>
                {t("knowledge.imaInstructions")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <button
                onClick={handleOpenCredentialPage}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-fg)]"
              >
                <ExternalLink className="size-3.5" />
                {t("knowledge.openCredentialPage")}
              </button>
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

        {step.type === "ima-select-module" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <button onClick={() => setStep({ type: "ima-credentials" })} className="rounded p-0.5 hover:bg-[var(--color-bg-hover)]">
                  <ArrowLeft className="size-4" />
                </button>
                {t("knowledge.selectModule")}
              </DialogTitle>
              <DialogDescription>{t("knowledge.connectionSuccess")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <button
                onClick={() => handleSelectModule("wiki")}
                className="flex w-full items-center gap-3 rounded-lg border border-[var(--color-border)] p-4 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-orange-500/10">
                  <FileText className="size-5 text-orange-500" />
                </div>
                <div>
                  <div className="text-sm font-medium text-[var(--color-fg)]">
                    {t("knowledge.imaWiki")}
                  </div>
                  <div className="text-xs text-[var(--color-fg-muted)]">
                    {t("knowledge.imaWikiDescription")}
                  </div>
                </div>
              </button>
              <button
                onClick={() => handleSelectModule("notes")}
                className="flex w-full items-center gap-3 rounded-lg border border-[var(--color-border)] p-4 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-green-500/10">
                  <BookOpen className="size-5 text-green-500" />
                </div>
                <div>
                  <div className="text-sm font-medium text-[var(--color-fg)]">
                    {t("knowledge.imaNotes")}
                  </div>
                  <div className="text-xs text-[var(--color-fg-muted)]">
                    {t("knowledge.imaNotesDescription")}
                  </div>
                </div>
              </button>
            </div>
          </>
        )}

        {step.type === "ima-loading-bases" && (
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
                {step.module === "notes"
                  ? t("knowledge.selectNotebook")
                  : t("knowledge.selectKnowledgeBase")}
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
                      {step.module === "notes"
                        ? t("knowledge.notes").replace("{count}", String(base.documentCount))
                        : t("knowledge.documents").replace("{count}", String(base.documentCount))}
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
