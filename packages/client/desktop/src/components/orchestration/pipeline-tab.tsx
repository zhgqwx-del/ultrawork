// Code-driven recipes tab (ADR-031 D-1 代码驱动面): Pipeline (chained steps)
// and Fan-out (optional planner → N parallel workers → optional aggregator)
// over the SAME DAG executor. Moved verbatim from pages/Orchestration.tsx when
// the route grew the Team tab (017).

import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { GitFork, Loader2, Plus, RefreshCw, Trash2, Workflow } from "lucide-react"
import type { PipelineRecipe, OrchestrationRun, RecipeStep } from "@agent/orchestrator"
import { Button } from "@/components/ui/button"
import { useAgents } from "@/lib/agent-context"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { useWorkspace } from "@/lib/workspace-context"
import { createRun, listRuns } from "@/lib/orchestration-client"
import { RunStatusBadge } from "@/components/orchestration/run-status-badge"

interface StepDraft {
  agentId: string
  taskPrompt: string
  /** "providerID/modelID" override — opencode steps only (capabilities.model). */
  model?: string
  /** Fan-out workers: run in an isolated git worktree (D-4). */
  worktree?: boolean
}

type Mode = "pipeline" | "fanout"

const EMPTY_STEP: StepDraft = { agentId: "opencode:default", taskPrompt: "" }

export function PipelineTab() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const api = useApi()
  const { agents } = useAgents()
  const { workspacePath } = useWorkspace()

  const [runs, setRuns] = useState<OrchestrationRun[]>([])
  const [loading, setLoading] = useState(true)
  const [unreachable, setUnreachable] = useState(false)
  const [mode, setMode] = useState<Mode>("pipeline")
  const [name, setName] = useState("")
  const [steps, setSteps] = useState<StepDraft[]>([{ ...EMPTY_STEP }])
  // Fan-out template state
  const [plannerPrompt, setPlannerPrompt] = useState("")
  const [workers, setWorkers] = useState<StepDraft[]>([{ ...EMPTY_STEP }, { ...EMPTY_STEP }])
  const [aggregatorPrompt, setAggregatorPrompt] = useState("")
  const [creating, setCreating] = useState(false)
  // Flat "providerID/modelID" options for the per-step model override.
  const [modelOptions, setModelOptions] = useState<string[]>([])

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

  useEffect(() => {
    let cancelled = false
    api
      .getProviders()
      .then((providers) => {
        if (cancelled) return
        setModelOptions(providers.flatMap((p) => p.connected.map((modelId) => `${p.id}/${modelId}`)))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [api])

  const buildRecipe = (): PipelineRecipe | null => {
    if (!workspacePath) {
      toast.error(t("orchestration.noWorkspace"))
      return null
    }
    const draftToStep = (draft: StepDraft, id: string, inputs: string[]): RecipeStep => ({
      id,
      agentId: draft.agentId,
      taskPrompt: draft.taskPrompt.trim(),
      inputs,
      model: draft.model || undefined,
      isolation: draft.worktree ? "worktree" : undefined,
    })

    let recipeSteps: RecipeStep[]
    if (mode === "pipeline") {
      recipeSteps = steps.map((step, i) =>
        draftToStep(step, `step-${i + 1}`, i > 0 ? [`step-${i}`] : []),
      )
    } else {
      const hasPlanner = plannerPrompt.trim().length > 0
      const workerInputs = hasPlanner ? ["plan"] : []
      recipeSteps = [
        ...(hasPlanner
          ? [draftToStep({ agentId: "opencode:default", taskPrompt: plannerPrompt }, "plan", [])]
          : []),
        ...workers.map((worker, i) => draftToStep(worker, `worker-${i + 1}`, workerInputs)),
      ]
      if (aggregatorPrompt.trim()) {
        recipeSteps.push(
          draftToStep(
            { agentId: "opencode:default", taskPrompt: aggregatorPrompt },
            "aggregate",
            workers.map((_, i) => `worker-${i + 1}`),
          ),
        )
      }
    }
    if (recipeSteps.length === 0 || recipeSteps.some((step) => !step.taskPrompt)) {
      toast.error(t("orchestration.emptyStep"))
      return null
    }
    return { name: name.trim() || t("orchestration.untitled"), workspace: workspacePath, steps: recipeSteps }
  }

  const submit = async () => {
    const recipe = buildRecipe()
    if (!recipe) return
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

  const stepEditor = (
    draft: StepDraft,
    onChange: (patch: Partial<StepDraft>) => void,
    extras?: { label: string; onRemove?: () => void; showWorktree?: boolean },
  ) => (
    <div className="rounded-lg border border-[var(--color-border)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-[var(--color-fg-muted)]">{extras?.label}</span>
        <select
          value={draft.agentId}
          onChange={(e) => onChange({ agentId: e.target.value })}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)]"
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        {/* Model override: opencode only (ADR-030 capabilities.model). */}
        {draft.agentId.startsWith("opencode:") && modelOptions.length > 0 && (
          <select
            value={draft.model ?? ""}
            onChange={(e) => onChange({ model: e.target.value || undefined })}
            className="max-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)]"
          >
            <option value="">{t("orchestration.modelDefault")}</option>
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        )}
        {extras?.showWorktree && (
          <label className="flex items-center gap-1 text-[10px] text-[var(--color-fg-muted)]">
            <input
              type="checkbox"
              checked={!!draft.worktree}
              onChange={(e) => onChange({ worktree: e.target.checked })}
              className="size-3 accent-[var(--color-brand)]"
            />
            {t("orchestration.fanout.worktree")}
          </label>
        )}
        {extras?.onRemove && (
          <button
            onClick={extras.onRemove}
            className="ml-auto text-[var(--color-fg-muted)] hover:text-red-500"
            aria-label="remove step"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      <textarea
        value={draft.taskPrompt}
        onChange={(e) => onChange({ taskPrompt: e.target.value })}
        placeholder={t("orchestration.taskPlaceholder")}
        rows={2}
        className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
      />
    </div>
  )

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {/* Create form */}
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5">
        <div className="mb-3 flex items-center gap-1 rounded-lg bg-[var(--color-bg)] p-1 text-xs">
          {(["pipeline", "fanout"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 transition-colors ${
                mode === m
                  ? "bg-[var(--color-bg-elevated)] font-medium text-[var(--color-fg)] shadow-sm"
                  : "text-[var(--color-fg-muted)]"
              }`}
            >
              {m === "pipeline" ? <Workflow className="size-3.5" /> : <GitFork className="size-3.5" />}
              {t(`orchestration.mode.${m}`)}
            </button>
          ))}
        </div>
        <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
          {t(mode === "pipeline" ? "orchestration.newPipeline.desc" : "orchestration.fanout.desc")}
          {workspacePath ? ` · ${workspacePath}` : ""}
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("orchestration.namePlaceholder")}
          className="mb-3 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />

        {mode === "pipeline" ? (
          <>
            <div className="flex flex-col gap-3">
              {steps.map((step, index) =>
                stepEditor(
                  step,
                  (patch) => setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s))),
                  {
                    label: `${t("orchestration.step")} ${index + 1}`,
                    onRemove:
                      steps.length > 1
                        ? () => setSteps((prev) => prev.filter((_, i) => i !== index))
                        : undefined,
                  },
                ),
              )}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setSteps((prev) => [...prev, { ...EMPTY_STEP }])}>
                <Plus className="size-3.5" />
                {t("orchestration.addStep")}
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={creating || !workspacePath}>
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t("orchestration.start")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <div>
                <p className="mb-1 text-xs font-medium text-[var(--color-fg-muted)]">
                  {t("orchestration.fanout.planner")}
                </p>
                <textarea
                  value={plannerPrompt}
                  onChange={(e) => setPlannerPrompt(e.target.value)}
                  placeholder={t("orchestration.fanout.plannerPlaceholder")}
                  rows={2}
                  className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                />
              </div>
              {workers.map((worker, index) =>
                stepEditor(
                  worker,
                  (patch) => setWorkers((prev) => prev.map((w, i) => (i === index ? { ...w, ...patch } : w))),
                  {
                    label: `${t("orchestration.fanout.worker")} ${index + 1}`,
                    showWorktree: true,
                    onRemove:
                      workers.length > 1
                        ? () => setWorkers((prev) => prev.filter((_, i) => i !== index))
                        : undefined,
                  },
                ),
              )}
              <div>
                <p className="mb-1 text-xs font-medium text-[var(--color-fg-muted)]">
                  {t("orchestration.fanout.aggregator")}
                </p>
                <textarea
                  value={aggregatorPrompt}
                  onChange={(e) => setAggregatorPrompt(e.target.value)}
                  placeholder={t("orchestration.fanout.aggregatorPlaceholder")}
                  rows={2}
                  className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWorkers((prev) => [...prev, { ...EMPTY_STEP }])}
              >
                <Plus className="size-3.5" />
                {t("orchestration.fanout.addWorker")}
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={creating || !workspacePath}>
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t("orchestration.start")}
              </Button>
            </div>
          </>
        )}
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
  )
}
