import { parseAgentId, type Connector } from "@agent/connector"
import { artifactExists, artifactPathFor, buildStepPrompt, ensureArtifactDir, type ArtifactInput } from "./artifacts"
import type { OrchestrationRun, OrchestratorEvent, RunStep, SpawnOptions, TaskHandle } from "./types"

/** Host surface the Orchestrator hands the pipeline executor (keeps this file
 * a pure recipe → primitives composition, ADR-031 D-3). */
export interface PipelineHost {
  spawn(opts: SpawnOptions): Promise<TaskHandle>
  connectorFor(workspace: string): Connector
  /** Persist the run then broadcast run.updated. */
  saveAndEmitRun(run: OrchestrationRun): void
  /** Persist the run then broadcast step.updated for one step. */
  saveAndEmitStep(run: OrchestrationRun, step: RunStep): void
  emit(event: OrchestratorEvent): void
  isRunCancelled(runId: string): boolean
  /** Current in-flight task per run, so cancelRun can abort it. */
  setActiveTask(runId: string, handle: TaskHandle | undefined): void
  now(): number
  defaultTimeoutMs: number
  /**
   * Directory the hidden opencode parent session is created under. Must NOT
   * be a user workspace — the sidebar shows root sessions per directory, and
   * the whole point of the parent is staying out of it. Unset (tests, hosts
   * without opencode steps) skips parent creation.
   */
  hiddenParentWorkspace?: string
}

function markRemaining(run: OrchestrationRun, fromIndex: number, status: "skipped"): void {
  for (let i = fromIndex; i < run.steps.length; i++) {
    if (run.steps[i].status === "pending") run.steps[i].status = status
  }
}

function finishRun(host: PipelineHost, run: OrchestrationRun, status: OrchestrationRun["status"], error?: string): void {
  run.status = status
  if (error) run.error = error
  host.saveAndEmitRun(run)
}

/**
 * Sequential Pipeline executor (ADR-031 D-3, first shipped mode): steps run
 * in order, each step's deliverable FILE feeds later steps by path. A failed
 * step fails the run and skips the rest; the parent (UI) is never hung — the
 * step's turn carries its own timeout via spawn.
 */
export async function executePipeline(host: PipelineHost, run: OrchestrationRun): Promise<void> {
  run.status = "running"
  host.saveAndEmitRun(run)
  ensureArtifactDir(run.recipe.workspace, run.id)

  try {
    for (let i = 0; i < run.steps.length; i++) {
      const step = run.steps[i]
      const recipeStep = run.recipe.steps[i]

      if (host.isRunCancelled(run.id)) {
        step.status = "cancelled"
        markRemaining(run, i + 1, "skipped")
        finishRun(host, run, "cancelled")
        return
      }

      const inputs: ArtifactInput[] = (recipeStep.inputs ?? []).map((stepId) => ({
        stepId,
        path: run.steps.find((s) => s.id === stepId)?.artifactPath ?? "",
      }))

      step.status = "running"
      step.startedAt = host.now()
      step.artifactPath = artifactPathFor(run.recipe.workspace, run.id, recipeStep)
      host.saveAndEmitStep(run, step)

      // Hidden opencode parent (sidebar pollution guard), lazily per run.
      if (parseAgentId(step.agentId).source === "opencode" && !run.parentSessionId && host.hiddenParentWorkspace) {
        const parentConnector = host.connectorFor(host.hiddenParentWorkspace)
        const ref = await parentConnector.createSession({
          backend: "opencode",
          title: `[orchestration] ${run.recipe.name}`,
        })
        run.parentSessionId = ref.id
        host.saveAndEmitRun(run)
      }

      const prompt = buildStepPrompt(recipeStep, step.artifactPath, inputs)
      const handle = await host.spawn({
        agentId: step.agentId,
        task: prompt,
        workspace: run.recipe.workspace,
        model: recipeStep.model,
        timeoutMs: recipeStep.timeoutMs ?? host.defaultTimeoutMs,
        parentSessionId: run.parentSessionId,
        title: `[orchestration] ${run.recipe.name} · ${step.id}`,
        onEvent: (event) => {
          if (event.type === "permission.asked" || event.type === "permission.replied") {
            host.emit({
              type: "step.permission",
              properties: {
                runId: run.id,
                stepId: step.id,
                sessionId: (event.properties as Record<string, any>)?.sessionID ?? "",
                event,
              },
            })
          }
        },
      })
      step.sessionId = handle.sessionId
      host.setActiveTask(run.id, handle)
      host.saveAndEmitStep(run, step)

      const result = await handle.done
      host.setActiveTask(run.id, undefined)
      step.endedAt = host.now()

      if (result.status === "cancelled" || host.isRunCancelled(run.id)) {
        step.status = "cancelled"
        markRemaining(run, i + 1, "skipped")
        host.saveAndEmitStep(run, step)
        finishRun(host, run, "cancelled")
        return
      }
      if (result.status !== "completed") {
        step.status = "failed"
        step.error = result.error ?? result.status
        markRemaining(run, i + 1, "skipped")
        host.saveAndEmitStep(run, step)
        finishRun(host, run, "failed", `step "${step.id}" ${result.status}`)
        return
      }
      if (!artifactExists(step.artifactPath)) {
        step.status = "failed"
        step.error = `deliverable missing: ${step.artifactPath}`
        markRemaining(run, i + 1, "skipped")
        host.saveAndEmitStep(run, step)
        finishRun(host, run, "failed", `step "${step.id}" produced no deliverable`)
        return
      }

      step.status = "completed"
      host.saveAndEmitStep(run, step)
    }

    finishRun(host, run, "completed")
  } catch (err) {
    // Defensive: spawn/createSession infrastructure errors must terminate the
    // run instead of leaving it running forever.
    host.setActiveTask(run.id, undefined)
    const running = run.steps.find((s) => s.status === "running")
    if (running) {
      running.status = "failed"
      running.error = err instanceof Error ? err.message : String(err)
      running.endedAt = host.now()
    }
    markRemaining(run, 0, "skipped")
    finishRun(host, run, "failed", err instanceof Error ? err.message : String(err))
  }
}
