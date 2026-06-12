// Orchestration surface (ADR-031 D-7): pipelines live on their own route —
// the single-session chat stays untouched (AionUi Team Mode coexistence).

import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { Loader2, Plus, RefreshCw, Trash2, Workflow } from "lucide-react"
import type { PipelineRecipe, OrchestrationRun, RecipeStep } from "@agent/orchestrator"
import { TopBar } from "@/components/layout/top-bar"
import { Button } from "@/components/ui/button"
import { useAgents } from "@/lib/agent-context"
import { useI18n } from "@/lib/i18n-context"
import { useWorkspace } from "@/lib/workspace-context"
import { createRun, listRuns } from "@/lib/orchestration-client"
import { RunStatusBadge } from "@/components/orchestration/run-status-badge"

interface StepDraft {
  agentId: string
  taskPrompt: string
}

export function OrchestrationPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { agents } = useAgents()
  const { workspacePath } = useWorkspace()

  const [runs, setRuns] = useState<OrchestrationRun[]>([])
  const [loading, setLoading] = useState(true)
  const [unreachable, setUnreachable] = useState(false)
  const [name, setName] = useState("")
  const [steps, setSteps] = useState<StepDraft[]>([{ agentId: "opencode:default", taskPrompt: "" }])
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setRuns(await listRuns())
      setUnreachable(false)
    } catch {
      setUnreachable(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const updateStep = (index: number, patch: Partial<StepDraft>) => {
    setSteps((prev) => prev.map((step, i) => (i === index ? { ...step, ...patch } : step)))
  }

  const submit = async () => {
    if (!workspacePath) {
      toast.error(t("orchestration.noWorkspace"))
      return
    }
    const recipe: PipelineRecipe = {
      name: name.trim() || t("orchestration.untitled"),
      workspace: workspacePath,
      steps: steps.map(
        (step, i): RecipeStep => ({
          id: `step-${i + 1}`,
          agentId: step.agentId,
          taskPrompt: step.taskPrompt.trim(),
        }),
      ),
    }
    if (recipe.steps.some((step) => !step.taskPrompt)) {
      toast.error(t("orchestration.emptyStep"))
      return
    }
    setCreating(true)
    try {
      const run = await createRun(recipe)
      navigate(`/orchestration/run/${run.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TopBar title={t("orchestration.title")} onClose={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {/* Create form */}
          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5">
            <h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-[var(--color-fg)]">
              <Workflow className="size-4" />
              {t("orchestration.newPipeline")}
            </h2>
            <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
              {t("orchestration.newPipeline.desc")}
              {workspacePath ? ` · ${workspacePath}` : ""}
            </p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("orchestration.namePlaceholder")}
              className="mb-3 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
            <div className="flex flex-col gap-3">
              {steps.map((step, index) => (
                <div key={index} className="rounded-lg border border-[var(--color-border)] p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xs font-medium text-[var(--color-fg-muted)]">
                      {t("orchestration.step")} {index + 1}
                    </span>
                    <select
                      value={step.agentId}
                      onChange={(e) => updateStep(index, { agentId: e.target.value })}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)]"
                    >
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                    {index > 0 && (
                      <span className="text-[10px] text-[var(--color-fg-muted)]">
                        {t("orchestration.inputFromPrev")}
                      </span>
                    )}
                    {steps.length > 1 && (
                      <button
                        onClick={() => setSteps((prev) => prev.filter((_, i) => i !== index))}
                        className="ml-auto text-[var(--color-fg-muted)] hover:text-red-500"
                        aria-label="remove step"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <textarea
                    value={step.taskPrompt}
                    onChange={(e) => updateStep(index, { taskPrompt: e.target.value })}
                    placeholder={t("orchestration.taskPlaceholder")}
                    rows={2}
                    className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                  />
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSteps((prev) => [...prev, { agentId: "opencode:default", taskPrompt: "" }])}
              >
                <Plus className="size-3.5" />
                {t("orchestration.addStep")}
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={creating || !workspacePath}>
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t("orchestration.start")}
              </Button>
            </div>
          </section>

          {/* Runs list */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--color-fg)]">{t("orchestration.runs")}</h2>
              <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-[var(--color-fg-muted)]" />
              </div>
            ) : unreachable ? (
              <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">
                {t("orchestration.sidecarUnreachable")}
              </p>
            ) : runs.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">{t("orchestration.noRuns")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => navigate(`/orchestration/run/${run.id}`)}
                    className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 text-left transition-colors hover:border-[var(--color-accent)]"
                  >
                    <RunStatusBadge status={run.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[var(--color-fg)]">{run.recipe.name}</div>
                      <div className="text-xs text-[var(--color-fg-muted)]">
                        {run.steps.length} {t("orchestration.stepsCount")} ·{" "}
                        {new Date(run.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
