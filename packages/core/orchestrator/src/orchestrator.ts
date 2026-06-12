import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { parseAgentId, type Unsubscribe } from "@agent/connector"
import { executePipeline, type PipelineHost } from "./pipeline"
import { SessionQueue } from "./session-queue"
import { Semaphore, TaskRegistry } from "./task-registry"
import { runTurn, TurnCancelledError, TurnTimeoutError } from "./turn"
import {
  GovernanceError,
  type OrchestrationRun,
  type OrchestratorDeps,
  type OrchestratorEvent,
  type OrchestratorEventHandler,
  type PipelineRecipe,
  type RunStep,
  type SpawnOptions,
  type TaskHandle,
  type TaskResult,
} from "./types"

export class RecipeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RecipeValidationError"
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run "${runId}" not found`)
    this.name = "RunNotFoundError"
  }
}

export class RunNotCancellableError extends Error {
  constructor(status: string) {
    super(`Run is already terminal (${status})`)
    this.name = "RunNotCancellableError"
  }
}

const DEFAULT_MAX_CONCURRENT = 8
const DEFAULT_MAX_DEPTH = 1
const DEFAULT_TIMEOUT_MS = 600_000
const STEP_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Tool-deny map sent with every opencode child turn: the delegate MCP tools
 * must never be callable from a child session (recursion guard, ADR-031 D-5).
 * opencode applies it as a sticky session permission with wildcard matching;
 * harmless when the orchestrator MCP isn't registered. ACP children are
 * guarded at the injection side instead (no mcpServers entry — see
 * InProcACPBackend), and their backends ignore `tools`.
 */
const CHILD_TOOL_DENY: Record<string, boolean> = { "orchestrator_*": false }

function childToolsFor(agentId: string): Record<string, boolean> | undefined {
  return parseAgentId(agentId).source === "opencode" ? CHILD_TOOL_DENY : undefined
}

/**
 * ADR-031 stage-3 orchestrator (first batch): delegate primitives
 * (spawn/await/steer/cancel) with governance guards, plus the code-driven
 * Pipeline recipe layer composed on top of them. Consumes ONLY connector
 * primitives — protocol/process details never reach this layer.
 */
export class Orchestrator {
  private runs = new Map<string, OrchestrationRun>()
  private cancelledRuns = new Set<string>()
  private activeTasks = new Map<string, TaskHandle>()
  private registry = new TaskRegistry()
  private queue = new SessionQueue()
  private semaphore: Semaphore
  private handlers = new Set<OrchestratorEventHandler>()
  private readonly maxDepth: number
  private readonly defaultTimeoutMs: number
  private readonly now: () => number
  private readonly host: PipelineHost

  constructor(private deps: OrchestratorDeps) {
    const governance = deps.governance ?? {}
    this.semaphore = new Semaphore(governance.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
    this.maxDepth = governance.maxDepth ?? DEFAULT_MAX_DEPTH
    this.defaultTimeoutMs = governance.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = deps.now ?? Date.now
    this.host = {
      spawn: (opts) => this.spawn(opts),
      connectorFor: (workspace) => this.deps.connectorFor(workspace),
      saveAndEmitRun: (run) => this.saveAndEmitRun(run),
      saveAndEmitStep: (run, step) => this.saveAndEmitStep(run, step),
      emit: (event) => this.emit(event),
      isRunCancelled: (runId) => this.cancelledRuns.has(runId),
      setActiveTask: (runId, handle) => {
        if (handle) this.activeTasks.set(runId, handle)
        else this.activeTasks.delete(runId)
      },
      now: () => this.now(),
      defaultTimeoutMs: this.defaultTimeoutMs,
      hiddenParentWorkspace: deps.hiddenParentWorkspace,
    }
  }

  // --- primitives (spawn / await / steer / cancel, ADR-031 §阶段拆解 1) ---

  async spawn(opts: SpawnOptions): Promise<TaskHandle> {
    const depth = (opts.depth ?? 0) + 1
    if (depth > this.maxDepth) {
      throw new GovernanceError(`delegate depth ${depth} exceeds maxDepth ${this.maxDepth}`)
    }
    const connector = this.deps.connectorFor(opts.workspace)
    const abort = new AbortController()
    if (opts.signal) {
      if (opts.signal.aborted) abort.abort()
      else opts.signal.addEventListener("abort", () => abort.abort(), { once: true })
    }
    const ref = await connector.createSession({
      agentId: opts.agentId,
      directory: opts.workspace,
      parentSessionId: opts.parentSessionId,
      title: opts.title,
    })
    // Subscribe BEFORE the background prompt starts: early events (e.g. an
    // immediate permission.asked) must reach onEvent.
    const unsubscribe = opts.onEvent ? connector.subscribeSession(ref.id, opts.onEvent) : undefined
    const taskId = `task_${randomUUID()}`
    const done = this.executeTask(connector, ref.id, opts, abort).finally(() => unsubscribe?.())
    const handle: TaskHandle = { taskId, sessionId: ref.id, agentId: opts.agentId, done }
    this.registry.register({ handle, abort, connector, workspace: opts.workspace, model: opts.model })
    return handle
  }

  private async executeTask(
    connector: ReturnType<OrchestratorDeps["connectorFor"]>,
    sessionId: string,
    opts: SpawnOptions,
    abort: AbortController,
  ): Promise<TaskResult> {
    await this.semaphore.acquire()
    try {
      if (abort.signal.aborted) return { status: "cancelled", sessionId }
      await this.queue.enqueue(sessionId, () =>
        runTurn(connector, sessionId, opts.task, {
          timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
          signal: abort.signal,
          model: opts.model,
          directory: opts.workspace,
          tools: childToolsFor(opts.agentId),
        }),
      )
      return { status: "completed", sessionId }
    } catch (err) {
      if (err instanceof TurnTimeoutError) return { status: "timeout", sessionId, error: err.message }
      if (err instanceof TurnCancelledError) return { status: "cancelled", sessionId }
      return { status: "failed", sessionId, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.semaphore.release()
    }
  }

  awaitTask(taskId: string): Promise<TaskResult> {
    return this.registry.require(taskId).handle.done
  }

  /** Queue a corrective follow-up turn AFTER the current one (not an interrupt — that is cancelTask). */
  async steer(taskId: string, text: string): Promise<void> {
    const record = this.registry.require(taskId)
    await this.queue.enqueue(record.handle.sessionId, () =>
      runTurn(record.connector, record.handle.sessionId, text, {
        timeoutMs: this.defaultTimeoutMs,
        signal: record.abort.signal,
        model: record.model,
        directory: record.workspace,
        tools: childToolsFor(record.handle.agentId),
      }),
    )
  }

  async cancelTask(taskId: string): Promise<void> {
    this.registry.require(taskId).abort.abort()
  }

  // --- recipe layer (Pipeline, ADR-031 D-3 first mode) ---

  async createRun(recipe: PipelineRecipe): Promise<OrchestrationRun> {
    const normalized = this.validateRecipe(recipe)
    const timestamp = this.now()
    const run: OrchestrationRun = {
      version: 1,
      id: `run_${randomUUID()}`,
      recipe: normalized,
      status: "pending",
      steps: normalized.steps.map(
        (step): RunStep => ({ id: step.id, agentId: step.agentId, status: "pending" }),
      ),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.runs.set(run.id, run)
    this.saveAndEmitRun(run)
    void executePipeline(this.host, run).catch((err) => {
      console.error(`[orchestrator] pipeline executor crashed for ${run.id}:`, err)
    })
    return run
  }

  private validateRecipe(recipe: PipelineRecipe): PipelineRecipe {
    if (!recipe?.name?.trim()) throw new RecipeValidationError("recipe.name is required")
    if (!recipe.workspace?.trim()) throw new RecipeValidationError("recipe.workspace is required")
    let workspace: string
    try {
      // realpath both validates existence and normalizes /tmp → /private/tmp
      // (opencode normalizes directories the same way).
      workspace = realpathSync(recipe.workspace)
    } catch {
      throw new RecipeValidationError(`recipe.workspace does not exist: ${recipe.workspace}`)
    }
    if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
      throw new RecipeValidationError("recipe.steps must be a non-empty array")
    }
    const seen = new Set<string>()
    const steps = recipe.steps.map((step, index) => {
      if (!step.id?.trim() || !STEP_ID_PATTERN.test(step.id)) {
        throw new RecipeValidationError(`step ${index}: id must match ${STEP_ID_PATTERN}`)
      }
      if (seen.has(step.id)) throw new RecipeValidationError(`duplicate step id "${step.id}"`)
      if (!step.agentId?.trim()) throw new RecipeValidationError(`step "${step.id}": agentId is required`)
      if (!step.taskPrompt?.trim()) throw new RecipeValidationError(`step "${step.id}": taskPrompt is required`)
      // Default input: the previous step's artifact. Normalized to explicit
      // ids at creation so the stored recipe is self-describing.
      const inputs = step.inputs ?? (index > 0 ? [recipe.steps[index - 1].id] : [])
      for (const input of inputs) {
        if (!seen.has(input)) {
          throw new RecipeValidationError(`step "${step.id}": input "${input}" must reference an EARLIER step`)
        }
      }
      seen.add(step.id)
      return { ...step, inputs }
    })
    return { name: recipe.name.trim(), workspace, steps }
  }

  getRun(runId: string): OrchestrationRun | undefined {
    return this.runs.get(runId)
  }

  listRuns(): OrchestrationRun[] {
    return [...this.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) throw new RunNotFoundError(runId)
    if (run.status !== "running" && run.status !== "pending") {
      throw new RunNotCancellableError(run.status)
    }
    this.cancelledRuns.add(runId)
    const active = this.activeTasks.get(runId)
    if (active) this.registry.get(active.taskId)?.abort.abort()
  }

  // --- events / recovery ---

  subscribe(handler: OrchestratorEventHandler): Unsubscribe {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  subscribeRun(runId: string, handler: OrchestratorEventHandler): Unsubscribe {
    return this.subscribe((event) => {
      const id = event.type === "run.updated" ? event.properties.run.id : event.properties.runId
      if (id === runId) handler(event)
    })
  }

  /**
   * Startup recovery: steps are side-effectful LLM turns without idempotency
   * guarantees, so interrupted runs are NEVER auto-resumed — they are marked
   * `interrupted` and the UI offers "run again" (same recipe, new run).
   */
  loadPersisted(): void {
    for (const run of this.deps.store.load()) {
      if (run.status === "running" || run.status === "pending") {
        run.status = "interrupted"
        for (const step of run.steps) {
          if (step.status === "running") {
            step.status = "failed"
            step.error = "sidecar restarted"
            step.endedAt = this.now()
          } else if (step.status === "pending") {
            step.status = "skipped"
          }
        }
        run.updatedAt = this.now()
        this.deps.store.save(run)
      }
      this.runs.set(run.id, run)
    }
  }

  private saveAndEmitRun(run: OrchestrationRun): void {
    run.updatedAt = this.now()
    this.deps.store.save(run)
    this.emit({ type: "run.updated", properties: { run } })
  }

  private saveAndEmitStep(run: OrchestrationRun, step: RunStep): void {
    run.updatedAt = this.now()
    this.deps.store.save(run)
    this.emit({ type: "step.updated", properties: { runId: run.id, step } })
  }

  private emit(event: OrchestratorEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event)
      } catch (err) {
        console.error("[orchestrator] event handler threw:", err)
      }
    }
  }
}
