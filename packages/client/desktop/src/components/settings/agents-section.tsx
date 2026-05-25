import { useState, useEffect } from "react"
import { toast } from "sonner"
import { Plus, RefreshCw, Trash2, Loader2, CheckCircle2, XCircle, AlertCircle, Plug, PlugZap, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-context"
import { useAgent } from "@/lib/agent-context"
import { fetchACPAgents, saveACPAgent, deleteACPAgent, connectACPAgent } from "@/lib/agent-router"
import type { ACPAgentInfo, ACPAgentConfig } from "@/lib/agent-router"
import { cn } from "@/lib/utils"

export function AgentsSection() {
  const { t } = useI18n()
  const { refreshAgents } = useAgent()
  const [agents, setAgents] = useState<ACPAgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingAgent, setEditingAgent] = useState<ACPAgentConfig | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const loadAgents = async () => {
    try {
      const list = await fetchACPAgents()
      setAgents(list)
    } catch {
      setAgents([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAgents() }, [])

  const onRefresh = async () => {
    setRefreshing(true)
    try { await loadAgents() } finally { setRefreshing(false) }
  }

  const handleDelete = async (id: string) => {
    setActionLoading(id)
    try {
      await deleteACPAgent(id)
      toast.success(t("agents.deleteSuccess"))
      await loadAgents()
      refreshAgents()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("agents.deleteFailed"))
    } finally {
      setActionLoading(null)
    }
  }

  /** Poll agent status until it leaves "connecting" state */
  const pollUntilSettled = async (agentId: string) => {
    const maxAttempts = 30 // 30 × 600ms = 18s, covers the 15s backend timeout
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 600))
      const list = await fetchACPAgents()
      setAgents(list)
      const agent = list.find((a) => a.id === agentId)
      if (!agent || agent.status !== "connecting") return
    }
  }

  const handleConnect = async (id: string) => {
    setActionLoading(id)
    try {
      await connectACPAgent(id)
      toast.success(t("agents.connectSuccess"))
      await loadAgents()
      refreshAgents()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("agents.connectFailed"))
      await loadAgents()
    } finally {
      setActionLoading(null)
    }
  }

  const handleSave = async (config: ACPAgentConfig) => {
    try {
      await saveACPAgent(config)
      toast.success(t("agents.saveSuccess"))
      setShowAddDialog(false)
      setEditingAgent(null)
      // Save triggers fire-and-forget auto-connect on the backend.
      // Poll until the agent reaches a final status.
      await pollUntilSettled(config.id)
      refreshAgents()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("agents.saveFailed"))
    }
  }

  const handleEdit = (agent: ACPAgentInfo) => {
    setEditingAgent({
      id: agent.id,
      label: agent.label,
      description: agent.description,
      command: "",
      args: [],
    })
    setShowAddDialog(true)
    // Load full config from sidecar
    import("@/lib/agent-router").then(({ getACPAgentConfig }) => {
      getACPAgentConfig(agent.id).then((config) => {
        setEditingAgent(config)
      }).catch(() => {
        toast.error(t("agents.connectFailed"))
      })
    })
  }

  const connectedCount = agents.filter((a) => a.status === "connected").length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("agents.title")}</h2>
            {connectedCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                {connectedCount}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t("agents.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
            {t("workspace.refresh")}
          </Button>
          <Button size="sm" onClick={() => { setEditingAgent(null); setShowAddDialog(true) }}>
            <Plus className="mr-1.5 size-3.5" />
            {t("agents.addAgent")}
          </Button>
        </div>
      </div>

      {/* Agent list */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-[var(--color-fg-muted)]" />
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] py-8 text-center">
          <Plug className="mx-auto size-8 text-[var(--color-fg-muted)]" />
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{t("agents.noAgents")}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setShowAddDialog(true)}>
            <Plus className="mr-1.5 size-3.5" />
            {t("agents.addAgent")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              loading={actionLoading === agent.id}
              onConnect={() => handleConnect(agent.id)}
              onEdit={() => handleEdit(agent)}
              onDelete={() => handleDelete(agent.id)}
            />
          ))}
        </div>
      )}

      {/* Add/Edit dialog */}
      {showAddDialog && (
        <AddAgentDialog
          initial={editingAgent}
          onSave={handleSave}
          onClose={() => { setShowAddDialog(false); setEditingAgent(null) }}
        />
      )}
    </div>
  )
}

// --- Agent Card ---

function AgentCard({
  agent,
  loading,
  onConnect,
  onEdit,
  onDelete,
}: {
  agent: ACPAgentInfo
  loading: boolean
  onConnect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useI18n()

  const statusIcon =
    agent.status === "connected" ? <CheckCircle2 className="size-4 text-green-500" /> :
    agent.status === "connecting" ? <Loader2 className="size-4 animate-spin text-yellow-500" /> :
    agent.status === "error" ? <XCircle className="size-4 text-red-500" /> :
    <AlertCircle className="size-4 text-[var(--color-fg-muted)]" />

  const statusText =
    agent.status === "connected" ? t("agents.statusConnected") :
    agent.status === "connecting" ? t("agents.statusConnecting") :
    agent.status === "error" ? t("agents.statusError") :
    t("agents.statusDisconnected")

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3">
      {statusIcon}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-[var(--color-fg)]">{agent.label}</div>
        {agent.description && (
          <div className="text-xs text-[var(--color-fg-muted)] truncate">{agent.description}</div>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-[var(--color-fg-muted)]">{statusText}</span>
          {agent.error && (
            <span className="text-[10px] text-red-500 truncate max-w-[200px]">{agent.error}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {agent.status !== "connected" && (
          <Button variant="ghost" size="sm" onClick={onConnect} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onEdit} disabled={loading}>
          <Pencil className="size-3.5" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} disabled={loading}>
          <Trash2 className="size-3.5 text-red-500" />
        </Button>
      </div>
    </div>
  )
}

// --- Add/Edit Agent Dialog ---

function AddAgentDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: ACPAgentConfig | null
  onSave: (config: ACPAgentConfig) => Promise<void>
  onClose: () => void
}) {
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [id, setId] = useState(initial?.id ?? "")
  const [label, setLabel] = useState(initial?.label ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [command, setCommand] = useState(initial?.command ?? "")
  const [args, setArgs] = useState(initial?.args?.join(" ") ?? "")
  const [envText, setEnvText] = useState(
    initial?.env ? Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join("\n") : ""
  )
  const isEdit = !!initial?.command

  // Update fields when initial loads asynchronously (edit mode)
  useEffect(() => {
    if (initial) {
      setId(initial.id)
      setLabel(initial.label)
      setDescription(initial.description ?? "")
      setCommand(initial.command)
      setArgs(initial.args?.join(" ") ?? "")
      setEnvText(initial.env ? Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join("\n") : "")
    }
  }, [initial])

  /** Fix macOS smart punctuation: em/en dashes → double hyphens, smart quotes → straight */
  const sanitizeCliText = (s: string) =>
    s.replace(/\u2014/g, "--")   // em dash → --
     .replace(/\u2013/g, "-")    // en dash → -
     .replace(/[\u2018\u2019]/g, "'")  // smart single quotes
     .replace(/[\u201C\u201D]/g, '"')  // smart double quotes

  const handleSubmit = async () => {
    if (!id.trim() || !label.trim() || !command.trim()) return
    setSaving(true)
    try {
      // Parse env from text
      const env: Record<string, string> = {}
      for (const line of envText.split("\n").filter(Boolean)) {
        const eqIdx = line.indexOf("=")
        if (eqIdx > 0) {
          env[line.substring(0, eqIdx).trim()] = line.substring(eqIdx + 1).trim()
        }
      }
      await onSave({
        id: id.trim(),
        label: label.trim(),
        description: description.trim() || undefined,
        command: sanitizeCliText(command.trim()),
        args: args.trim() ? sanitizeCliText(args.trim()).split(/\s+/) : [],
        env: Object.keys(env).length > 0 ? env : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  const inputClass = "w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-[var(--color-fg)]">
          {isEdit ? t("agents.editAgent") : t("agents.addAgent")}
        </h3>

        <div className="mt-4 space-y-3">
          {/* ID */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("agents.fieldId")}</label>
            <input
              className={inputClass}
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="qoder"
              disabled={isEdit}
            />
          </div>

          {/* Label */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("agents.fieldLabel")}</label>
            <input
              className={inputClass}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Qoder"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("agents.fieldDescription")}</label>
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("agents.fieldDescriptionPlaceholder")}
            />
          </div>

          {/* Command */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("agents.fieldCommand")}</label>
            <input
              className={inputClass}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="qodercli"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          {/* Args */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("agents.fieldArgs")}</label>
            <input
              className={inputClass}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="--acp"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <p className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">{t("agents.fieldArgsHint")}</p>
          </div>

          {/* Env vars */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{t("agents.fieldEnv")}</label>
            <textarea
              className={cn(inputClass, "h-16 resize-none")}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={"QODER_PERSONAL_ACCESS_TOKEN=your_token"}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <p className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">{t("agents.fieldEnvHint")}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t("agents.cancel")}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving || !id.trim() || !label.trim() || !command.trim()}>
            {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            {isEdit ? t("agents.save") : t("agents.add")}
          </Button>
        </div>
      </div>
    </div>
  )
}
