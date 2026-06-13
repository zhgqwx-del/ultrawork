import { parseAgentId, type Connector } from "@agent/connector"
import { artifactExists, artifactPathFor, buildStepPrompt, ensureArtifactDir, type ArtifactInput } from "./artifacts"
import { collectArtifact, createWorktree, removeWorktree, stageInputs } from "./worktree"
import type { OrchestrationRun, OrchestratorEvent, RunStep, SpawnOptions, TaskHandle, TaskResult } from "./types"

/** Host surface the Orchestrator hands the pipeline executor (keeps this file
 * a pure recipe → primitives composition, ADR-031 D-3). */
export interface PipelineHost {
  spawn(opts: SpawnOptions): Promise<TaskHandle>
  connectorFor(workspace: string): Connector
  /** Drop a connector created for a temporary worktree dir (SSE leak guard). */
  releaseConnector?(workspace: string): void
  /** Persist the run then broadcast run.updated. */
  saveAndEmitRun(run: OrchestrationRun): void
  /** Persist the run then broadcast step.updated for one step. */
  saveAndEmitStep(run: OrchestrationRun, step: RunStep): void
  emit(event: OrchestratorEvent): void
  isRunCancelled(runId: string): boolean
  /** In-flight tasks per run, so cancelRun can abort ALL of them (Fan-out). */
  addActiveTask(runId: string, handle: TaskHandle): void
  removeActiveTask(runId: string, taskId: string): void
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

interface StepOutcome {
  index: number
  result?: TaskResult
  infraError?: Error
}

/**
 * DAG executor (ADR-031 D-3: Pipeline + Fan-out are the SAME composition):
 * every step whose `inputs` are all completed starts immediately, bounded by
 * the orchestrator's global semaphore. The default chained inputs degenerate
 * to the first batch's sequential pipeline — its tests pass unchanged
 * (behavior lock). On a failure the transitive downstream is skipped right
 * away while independent in-flight branches run to completion; the run's
 * terminal status is decided at drain time (cancelled > failed > completed).
 */
export async function executePipeline(host: PipelineHost, run: OrchestrationRun): Promise<void> {
  run.status = "running"
  host.saveAndEmitRun(run)
  ensureArtifactDir(run.recipe.workspace, run.id)

  try {
    // Hidden opencode parent UPFRONT (not lazily per step): two opencode
    // steps becoming ready in the same tick would otherwise race and create
    // two parents.
    if (
      !run.parentSessionId &&
      host.hiddenParentWorkspace &&
      run.recipe.steps.some((step) => parseAgentId(step.agentId).source === "opencode")
    ) {
      const parentConnector = host.connectorFor(host.hiddenParentWorkspace)
      const ref = await parentConnector.createSession({
        backend: "opencode",
        title: `[orchestration] ${run.recipe.name}`,
      })
      run.parentSessionId = ref.id
      host.saveAndEmitRun(run)
    }

    const inFlight = new Map<number, Promise<StepOutcome>>()
    let firstError: string | undefined

    const stepById = (id: string) => run.steps.find((s) => s.id === id)
    const isReady = (index: number) =>
      run.steps[index].status === "pending" &&
      (run.recipe.steps[index].inputs ?? []).every((id) => stepById(id)?.status === "completed")

    /** Skip everything that can no longer become ready (fixpoint walk). */
    const skipUnreachable = () => {
      let changed = true
      while (changed) {
        changed = false
        for (let i = 0; i < run.steps.length; i++) {
          if (run.steps[i].status !== "pending") continue
          const doomed = (run.recipe.steps[i].inputs ?? []).some((id) =>
            ["failed", "cancelled", "skipped"].includes(stepById(id)?.status ?? ""),
          )
          if (doomed) {
            run.steps[i].status = "skipped"
            host.saveAndEmitStep(run, run.steps[i])
            changed = true
          }
        }
      }
    }

    const settle = (outcome: StepOutcome) => {
      const step = run.steps[outcome.index]
      const recipeStep = run.recipe.steps[outcome.index]
      step.endedAt = host.now()

      const fail = (error: string, runError?: string) => {
        step.status = "failed"
        step.error = error
        firstError ??= runError ?? `step "${step.id}" ${error}`
        skipUnreachable()
        // Release the per-worktree connector (a live opencode SSE stream) on
        // every failure path — it is useless once the step has failed. The
        // worktree DIR is deliberately kept for debugging (worktreePath stays
        // set), but its SSE connection must not leak.
        if (step.worktreePath) host.releaseConnector?.(step.worktreePath)
        host.saveAndEmitStep(run, step)
      }

      if (outcome.infraError) {
        fail(outcome.infraError.message)
        return
      }
      const result = outcome.result!
      if (result.status === "cancelled" || host.isRunCancelled(run.id)) {
        step.status = "cancelled"
        // Cancel has no debugging value: tear down the worktree dir AND release
        // its connector (unlike fail, which keeps the dir).
        if (step.worktreePath) {
          removeWorktree(run.recipe.workspace, step.worktreePath)
          host.releaseConnector?.(step.worktreePath)
          step.worktreePath = undefined
        }
        host.saveAndEmitStep(run, step)
        return
      }
      if (result.status !== "completed") {
        fail(result.error ?? result.status)
        return
      }
      if (!artifactExists(step.artifactPath!)) {
        // Worktree (if any) is kept for debugging — worktreePath stays set.
        fail(`deliverable missing: ${step.artifactPath}`, `step "${step.id}" produced no deliverable`)
        return
      }
      if (step.worktreePath) {
        // Success: collect the deliverable into the main run dir, then the
        // worktree has served its purpose.
        const mainPath = artifactPathFor(run.recipe.workspace, run.id, recipeStep)
        collectArtifact(step.artifactPath!, mainPath)
        step.artifactPath = mainPath
        removeWorktree(run.recipe.workspace, step.worktreePath)
        host.releaseConnector?.(step.worktreePath)
        step.worktreePath = undefined
      }
      step.status = "completed"
      host.saveAndEmitStep(run, step)
    }

    const startStep = async (index: number): Promise<StepOutcome> => {
      const step = run.steps[index]
      const recipeStep = run.recipe.steps[index]
      step.status = "running"
      step.startedAt = host.now()
      try {
        let workDir = run.recipe.workspace
        let inputs: ArtifactInput[] = (recipeStep.inputs ?? []).map((stepId) => ({
          stepId,
          path: stepById(stepId)?.artifactPath ?? "",
        }))
        if (recipeStep.isolation === "worktree") {
          workDir = createWorktree(run.recipe.workspace, run.id, step.id)
          step.worktreePath = workDir
          ensureArtifactDir(workDir, run.id)
          inputs = stageInputs(workDir, run.id, inputs)
        }
        step.artifactPath = artifactPathFor(workDir, run.id, recipeStep)
        host.saveAndEmitStep(run, step)

        const handle = await host.spawn({
          agentId: step.agentId,
          task: buildStepPrompt(recipeStep, step.artifactPath, inputs),
          workspace: workDir,
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
        host.addActiveTask(run.id, handle)
        host.saveAndEmitStep(run, step)
        const result = await handle.done
        host.removeActiveTask(run.id, handle.taskId)
        return { index, result }
      } catch (err) {
        return { index, infraError: err instanceof Error ? err : new Error(String(err)) }
      }
    }

    while (true) {
      if (!host.isRunCancelled(run.id)) {
        for (let i = 0; i < run.steps.length; i++) {
          if (!inFlight.has(i) && isReady(i)) inFlight.set(i, startStep(i))
        }
      }
      if (inFlight.size === 0) break
      const outcome = await Promise.race(inFlight.values())
      inFlight.delete(outcome.index)
      settle(outcome)
    }

    // Drain finished: whatever is still pending is unreachable (failed
    // upstream) or was never started (cancelled run).
    for (const step of run.steps) {
      if (step.status === "pending") {
        step.status = "skipped"
        host.saveAndEmitStep(run, step)
      }
    }

    if (host.isRunCancelled(run.id) || run.steps.some((s) => s.status === "cancelled")) {
      finishRun(host, run, "cancelled")
    } else if (run.steps.some((s) => s.status === "failed")) {
      finishRun(host, run, "failed", firstError)
    } else {
      finishRun(host, run, "completed")
    }
  } catch (err) {
    // Defensive: executor-level errors (hidden-parent creation etc.) must
    // terminate the run instead of leaving it running forever.
    const running = run.steps.find((s) => s.status === "running")
    if (running) {
      running.status = "failed"
      running.error = err instanceof Error ? err.message : String(err)
      running.endedAt = host.now()
    }
    for (const step of run.steps) {
      if (step.status === "pending") step.status = "skipped"
    }
    finishRun(host, run, "failed", err instanceof Error ? err.message : String(err))
  }
}

function finishRun(host: PipelineHost, run: OrchestrationRun, status: OrchestrationRun["status"], error?: string): void {
  run.status = status
  if (error) run.error = error
  host.saveAndEmitRun(run)
}
