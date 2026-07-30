import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, rmSync, rmdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { runArtifactDir, type ArtifactInput } from "./artifacts"

// Fan-out worktree isolation (ADR-031 D-4, decision 2026-06-12): each
// isolated worker runs in a DETACHED git worktree of the workspace so
// parallel writes never collide. Worktrees live OUTSIDE the repo (xdgData) —
// nesting them under the workspace would put a worktree inside the main
// working tree.

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorktreeError"
  }
}

function git(args: string[], context: string): string {
  const result = spawnSync("git", args, { encoding: "utf-8" })
  if (result.error) throw new WorktreeError(`${context}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new WorktreeError(`${context}: ${result.stderr?.trim() || `git exited ${result.status}`}`)
  }
  return result.stdout
}

export function isGitRepo(workspace: string): boolean {
  const result = spawnSync("git", ["-C", workspace, "rev-parse", "--git-dir"], { encoding: "utf-8" })
  return !result.error && result.status === 0
}

export function worktreesRoot(): string {
  if (process.env.ULTRAWORK_WORKTREES_DIR) return process.env.ULTRAWORK_WORKTREES_DIR
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(xdgData, "ultrawork", "worktrees")
}

/** `git worktree add --detach` at the workspace's current HEAD. */
export function createWorktree(workspace: string, runId: string, stepId: string, root = worktreesRoot()): string {
  const dir = join(root, runId, stepId)
  mkdirSync(dirname(dir), { recursive: true })
  git(["-C", workspace, "worktree", "add", "--detach", dir], `worktree add for step "${stepId}" failed`)
  return dir
}

/**
 * Remove a worktree after its artifact was collected. Best-effort: a failure
 * here must never fail the step (the run dir copy already exists), so log and
 * fall back to a plain delete + prune.
 */
export function removeWorktree(workspace: string, dir: string): void {
  const result = spawnSync("git", ["-C", workspace, "worktree", "remove", "--force", dir], { encoding: "utf-8" })
  if (result.error || result.status !== 0) {
    console.error(`[orchestrator] git worktree remove failed for ${dir}: ${result.stderr?.trim() ?? result.error}`)
    rmSync(dir, { recursive: true, force: true })
    spawnSync("git", ["-C", workspace, "worktree", "prune"], { encoding: "utf-8" })
  }
  // `createWorktree` creates the run-level parent via `mkdirSync(dirname(dir))`,
  // and nothing else ever removed it — so every run that used worktree isolation
  // left an empty `<root>/<runId>/` behind permanently (a 71-minute soak with 523
  // runs ended with 168 residual dirs, 166 of them empty, and zero reclaimed).
  //
  // rmdir (not rm -r) is the whole safety argument: it removes the parent ONLY
  // when it is already empty, so a fan-out sibling still running, or a failed
  // step's worktree deliberately kept for debugging, makes this fail harmlessly.
  try {
    rmdirSync(dirname(dir))
  } catch {
    // non-empty (siblings/kept worktree) or already gone — both are fine
  }
}

/**
 * Copy input artifacts INTO the worktree's run dir and return the rebased
 * paths. The child is cwd-sandboxed in the worktree — reading an absolute
 * path back in the main workspace would trip read-permission prompts (claude)
 * or be rejected outright.
 */
export function stageInputs(worktreeDir: string, runId: string, inputs: ArtifactInput[]): ArtifactInput[] {
  if (inputs.length === 0) return inputs
  const stageDir = runArtifactDir(worktreeDir, runId)
  mkdirSync(stageDir, { recursive: true })
  return inputs.map((input) => {
    const staged = join(stageDir, basename(input.path))
    copyFileSync(input.path, staged)
    return { stepId: input.stepId, path: staged }
  })
}

/** Collect the worktree-local deliverable into the main run dir. */
export function collectArtifact(worktreeArtifact: string, mainArtifactPath: string): void {
  mkdirSync(dirname(mainArtifactPath), { recursive: true })
  copyFileSync(worktreeArtifact, mainArtifactPath)
}
