// Settings · External Agents (ACP): manage ~/.config/ultrawork/agents.json
// entries via the ACP Client Sidecar (:4099) and control connections.

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Bot, Loader2, Pencil, Plug, PlugZap, Plus, RefreshCw, Trash2 } from "lucide-react"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import {
  type ACPAgentConfig,
  type ACPAgentInfo,
  checkACPHealth,
  connectACPAgent,
  deleteACPAgent,
  disconnectACPAgent,
  fetchACPAgents,
  getACPAgentConfig,
  saveACPAgent,
} from "@/lib/agent-router"
import { useAgents } from "@/lib/agent-context"

interface FormState {
  id: string
  label: string
  description: string
  command: string
  args: string
  env: string
  knowledgeMcp: boolean
}

const EMPTY_FORM: FormState = {
  id: "",
  label: "",
  description: "",
  command: "",
  args: "",
  env: "",
  knowledgeMcp: false,
}

function toForm(config: ACPAgentConfig): FormState {
  return {
    id: config.id,
    label: config.label,
    description: config.description ?? "",
    command: config.command,
    args: config.args.join(" "),
    env: Object.entries(config.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    knowledgeMcp: config.knowledgeMcp ?? false,
  }
}

function fromForm(form: FormState): ACPAgentConfig {
  const env: Record<string, string> = {}
  for (const line of form.env.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf("=")
    if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return {
    id: form.id.trim(),
    label: form.label.trim(),
    description: form.description.trim() || undefined,
    command: form.command.trim(),
    args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
    env: Object.keys(env).length > 0 ? env : undefined,
    knowledgeMcp: form.knowledgeMcp,
  }
}

const STATUS_STYLE: Record<ACPAgentInfo["status"], string> = {
  connected: "bg-green-500/10 text-green-600 dark:text-green-400",
  connecting: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  disconnected: "bg-gray-500/10 text-gray-500",
  error: "bg-red-500/10 text-red-600 dark:text-red-400",
}

export function AgentsSection() {
  const { t } = useI18n()
  const { refreshAgents } = useAgents()
  const [available, setAvailable] = useState(false)
  const [agents, setAgents] = useState<ACPAgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const healthy = await checkACPHealth()
      setAvailable(healthy)
      setAgents(healthy ? await fetchACPAgents() : [])
    } catch {
      setAgents([])
    } finally {
      setLoading(false)
    }
    void refreshAgents()
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id)
    try {
      await fn()
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const handleEdit = async (id: string) => {
    try {
      const config = await getACPAgentConfig(id)
      setEditingId(id)
      setForm(toForm(config))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSave = async () => {
    if (!form) return
    const config = fromForm(form)
    if (!config.id || !config.label || !config.command) {
      toast.error(t("agents.form.required"))
      return
    }
    setSaving(true)
    try {
      await saveACPAgent(config)
      toast.success(t("agents.saved"))
      setForm(null)
      setEditingId(null)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("agents.title")}</h2>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t("agents.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label={t("agents.refresh")}
            className="flex size-8 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingId(null)
              setForm(EMPTY_FORM)
            }}
            disabled={!available}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="size-4" />
            {t("agents.add")}
          </button>
        </div>
      </div>

      {!available && !loading && (
        <div className="rounded-lg border border-[var(--color-border)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
          {t("agent.sidecarUnavailable")}
        </div>
      )}

      {available && (
        <div className="space-y-2">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-4 py-3"
            >
              <Bot className="size-5 shrink-0 text-[var(--color-fg-muted)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-[var(--color-fg)]">{agent.label}</span>
                  <span
                    title={agent.status === "disconnected" ? t("agents.status.disconnectedHint") : undefined}
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                      STATUS_STYLE[agent.status]
                    )}
                  >
                    {t(`agents.status.${agent.status}`)}
                  </span>
                </div>
                <div className="truncate text-xs text-[var(--color-fg-muted)]">
                  {agent.error || agent.description || agent.id}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {busyId === agent.id ? (
                  <Loader2 className="size-4 animate-spin text-[var(--color-fg-muted)]" />
                ) : (
                  <>
                    {agent.status === "connected" ? (
                      <IconButton
                        label={t("agents.disconnect")}
                        onClick={() => void withBusy(agent.id, () => disconnectACPAgent(agent.id))}
                      >
                        <PlugZap className="size-4" />
                      </IconButton>
                    ) : (
                      <IconButton
                        label={t("agents.connect")}
                        onClick={() => void withBusy(agent.id, () => connectACPAgent(agent.id))}
                      >
                        <Plug className="size-4" />
                      </IconButton>
                    )}
                    <IconButton label={t("agents.edit")} onClick={() => void handleEdit(agent.id)}>
                      <Pencil className="size-4" />
                    </IconButton>
                    <IconButton
                      label={t("agents.delete")}
                      onClick={() => void withBusy(agent.id, () => deleteACPAgent(agent.id))}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </>
                )}
              </div>
            </div>
          ))}
          {agents.length === 0 && !loading && (
            <div className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
              {t("agents.empty")}
            </div>
          )}
        </div>
      )}

      {form && (
        <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">
            {editingId ? t("agents.edit") : t("agents.add")}
          </h3>
          <FormField
            label="ID"
            value={form.id}
            disabled={!!editingId}
            placeholder="claude"
            onChange={(id) => setForm({ ...form, id })}
          />
          <FormField
            label={t("agents.form.label")}
            value={form.label}
            placeholder="Claude Code"
            onChange={(label) => setForm({ ...form, label })}
          />
          <FormField
            label={t("agents.form.command")}
            value={form.command}
            placeholder="bunx"
            onChange={(command) => setForm({ ...form, command })}
          />
          <FormField
            label={t("agents.form.args")}
            value={form.args}
            placeholder="--bun @zed-industries/claude-code-acp"
            onChange={(args) => setForm({ ...form, args })}
          />
          <FormField
            label={t("agents.form.env")}
            value={form.env}
            placeholder="API_KEY=..."
            multiline
            onChange={(env) => setForm({ ...form, env })}
          />
          <label className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              checked={form.knowledgeMcp}
              onChange={(e) => setForm({ ...form, knowledgeMcp: e.target.checked })}
              className="size-3.5 accent-[var(--color-brand)]"
            />
            <span className="text-xs text-[var(--color-fg)]">{t("agents.form.knowledgeMcp")}</span>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setForm(null)
                setEditingId(null)
              }}
              className="rounded-lg px-3 py-1.5 text-sm text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)]"
            >
              {t("agents.form.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving && <Loader2 className="size-3 animate-spin" />}
              {t("agents.form.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
    >
      {children}
    </button>
  )
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  multiline,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  multiline?: boolean
}) {
  const className =
    "w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)] disabled:opacity-50"
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={className}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={className}
        />
      )}
    </label>
  )
}
