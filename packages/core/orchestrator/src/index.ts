// @agent/orchestrator — ADR-031 stage-3 orchestration layer (first batch):
// delegate primitives + governance + code-driven Pipeline recipes.
// Consumes @agent/connector primitives only; hosted by the ACP sidecar.

export {
  GovernanceError,
  type GovernanceOptions,
  type OrchestrationRun,
  type OrchestratorDeps,
  type OrchestratorEvent,
  type OrchestratorEventHandler,
  type PipelineRecipe,
  type RecipeStep,
  type RunStatus,
  type RunStep,
  type RunStoreLike,
  type SpawnOptions,
  type StepStatus,
  type TaskHandle,
  type TaskResult,
  type TaskStatus,
} from "./types"

export {
  artifactNameOf,
  artifactPathFor,
  buildStepPrompt,
  ensureArtifactDir,
  runArtifactDir,
  type ArtifactInput,
} from "./artifacts"

export { RunStore } from "./run-store"
export { SessionQueue } from "./session-queue"
export { Semaphore, TaskRegistry, type TaskRecord } from "./task-registry"
export { runTurn, TurnCancelledError, TurnFailedError, TurnTimeoutError, type RunTurnOptions } from "./turn"
export { executePipeline, type PipelineHost } from "./pipeline"
export {
  Orchestrator,
  RecipeValidationError,
  RunNotCancellableError,
  RunNotFoundError,
} from "./orchestrator"
export {
  DelegateManager,
  DelegateRequestError,
  type DelegateEvent,
  type DelegateEventHandler,
  type DelegateManagerDeps,
  type DelegateRecord,
  type DelegateRequest,
  type DelegateResult,
  type DelegateStatus,
} from "./delegate"
