import type { Connector, ConnectorEvent } from "@agent/connector"

// Domain model for ADR-031 stage 3 (first batch): primitives + code-driven
// Pipeline recipes. Modes are NOT first-class (ADR-031 D-3) — Pipeline is a
// composition over spawn/await; Fan-out and the agent-driven delegate tool
// build on the same primitives in a later batch.

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
export type StepStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped"

export interface RecipeStep {
  /** Slug, unique within the recipe; doubles as the default artifact stem. */
  id: string
  /** Namespaced agent id: "opencode:default" | "acp:claude" | ... */
  agentId: string
  /** The user-authored task. The orchestrator appends the artifact contract. */
  taskPrompt: string
  /**
   * Upstream step ids whose artifacts feed this step. The type supports any
   * DAG prefix; the MVP UI defaults to [previous step].
   */
  inputs?: string[]
  /** Defaults to `${id}.md`. */
  artifactName?: string
  timeoutMs?: number
  /** Model override "providerID/modelID" (capabilities.model backends only). */
  model?: string
  /**
   * "worktree": run this step in a detached git worktree of the workspace
   * (Fan-out isolation, D-4). Requires the workspace to be a git repo with at
   * least one commit. Input artifacts are staged INTO the worktree and the
   * deliverable is collected back to the main run dir on success.
   */
  isolation?: "worktree"
}

export interface PipelineRecipe {
  name: string
  /** Absolute workspace path. Normalized via realpath at createRun (the /tmp → /private/tmp gotcha). */
  workspace: string
  steps: RecipeStep[]
}

export interface RunStep {
  id: string
  agentId: string
  status: StepStatus
  /** Child session id, set once spawned — the UI lazy-loads history from it. */
  sessionId?: string
  /** Absolute path of the produced artifact (set when the step starts). */
  artifactPath?: string
  /**
   * Worktree the step ran in (isolation: "worktree"). Removed on success;
   * kept on failure for debugging — the UI shows the path.
   */
  worktreePath?: string
  error?: string
  startedAt?: number
  endedAt?: number
}

export interface OrchestrationRun {
  version: 1
  id: string
  recipe: PipelineRecipe
  status: RunStatus
  steps: RunStep[]
  /**
   * Hidden opencode parent session (sidebar pollution guard): opencode child
   * sessions are created with parentID = this so `roots:true` listings skip
   * them. Lazily created on the first opencode step.
   */
  parentSessionId?: string
  createdAt: number
  updatedAt: number
  error?: string
}

// --- events (mirrors the ConnectorEvent {type, properties} shape so the
// sidecar SSE pipe and UI handling patterns carry over unchanged) ---

export type OrchestratorEvent =
  | { type: "run.updated"; properties: { run: OrchestrationRun } }
  | { type: "step.updated"; properties: { runId: string; step: RunStep } }
  /**
   * permission.asked/permission.replied from a child session, relayed so the
   * run UI can answer inline (a pending permission would otherwise hang a
   * headless run until the sidecar's deny timeout). The UI replies via the
   * existing permission endpoints — the orchestrator never answers itself.
   */
  | {
      type: "step.permission"
      properties: { runId: string; stepId: string; sessionId: string; event: ConnectorEvent }
    }

export type OrchestratorEventHandler = (event: OrchestratorEvent) => void

// --- primitives (spawn / await / steer / cancel) ---

export interface GovernanceOptions {
  /** Global concurrent child-turn ceiling. Excess spawns queue (Fan-out-ready). Default 8. */
  maxConcurrent?: number
  /** Max delegate depth; 1 = flat tree, child agents may not re-delegate. Default 1. */
  maxDepth?: number
  /** Per-turn timeout when a step/spawn doesn't specify one. Default 10 min. */
  defaultTimeoutMs?: number
}

export interface SpawnOptions {
  agentId: string
  /** Full prompt for the child turn (recipe layer appends the artifact contract first). */
  task: string
  workspace: string
  model?: string
  timeoutMs?: number
  /**
   * Depth of the CALLER (default 0 = user/recipe layer). The spawned task runs
   * at depth+1; exceeding maxDepth throws GovernanceError. The future delegate
   * MCP shim passes its own task depth here to reuse the guard.
   */
  depth?: number
  /** opencode children: parent session id (hidden-parent sidebar guard). */
  parentSessionId?: string
  /** opencode children: initial session title. */
  title?: string
  signal?: AbortSignal
  /**
   * Subscribed to the child session immediately after createSession — before
   * the first prompt — so no early event (e.g. permission.asked) is lost.
   * Unsubscribed when the task settles.
   */
  onEvent?: (event: ConnectorEvent) => void
}

export type TaskStatus = "completed" | "failed" | "cancelled" | "timeout"

export interface TaskResult {
  status: TaskStatus
  sessionId: string
  error?: string
}

export interface TaskHandle {
  taskId: string
  sessionId: string
  agentId: string
  /** Settles with the outcome; NEVER rejects (background tasks must not produce unhandled rejections). */
  done: Promise<TaskResult>
}

export class GovernanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GovernanceError"
  }
}

// --- wiring ---

export interface RunStoreLike {
  load(): OrchestrationRun[]
  save(run: OrchestrationRun): void
  delete(runId: string): void
}

export interface OrchestratorDeps {
  /**
   * Connector scoped to a workspace (opencode REST/SSE are per-directory).
   * The host (ACP sidecar) caches instances per workspace.
   */
  connectorFor(workspace: string): Connector
  /**
   * Release a connector created for a TEMPORARY workspace (worktree dirs) —
   * per-workspace connectors hold an SSE stream each and would leak across
   * fan-out runs otherwise. Never called for real user workspaces.
   */
  releaseConnector?(workspace: string): void
  store: RunStoreLike
  governance?: GovernanceOptions
  /** Injectable clock for tests. */
  now?: () => number
  /**
   * Directory the hidden opencode parent session lives under (must NOT be a
   * user workspace — see pipeline.ts). Unset disables hidden-parent creation.
   */
  hiddenParentWorkspace?: string
}
