import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktree, removeWorktree } from "../worktree"

// Real git, real worktrees — the leak these guard was invisible to any mock: the
// bug was not in what `git worktree remove` does, but in a directory level that
// nothing ever deleted. A 71-minute soak with 523 runs finished with 168 residual
// dirs (166 empty) and not one reclaimed.

let tmp: string
let ws: string
let root: string

const git = (args: string[], cwd: string) => spawnSync("git", args, { cwd, encoding: "utf-8" })

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wt-test-"))
  ws = join(tmp, "ws")
  root = join(tmp, "worktrees")
  mkdirSync(ws, { recursive: true })
  git(["init", "-q"], ws)
  git(["config", "user.email", "t@t"], ws)
  git(["config", "user.name", "t"], ws)
  writeFileSync(join(ws, "README.md"), "x\n")
  git(["add", "-A"], ws)
  git(["commit", "-qm", "init"], ws)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe("removeWorktree", () => {
  it("removes the run-level parent once its last worktree is gone", () => {
    const dir = createWorktree(ws, "run_1", "s0", root)
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(root, "run_1"))).toBe(true)

    removeWorktree(ws, dir)

    expect(existsSync(dir)).toBe(false)
    // The regression: this used to survive forever, one per worktree run.
    expect(existsSync(join(root, "run_1"))).toBe(false)
  })

  it("keeps the parent while a fan-out sibling is still checked out", () => {
    const a = createWorktree(ws, "run_2", "s0", root)
    const b = createWorktree(ws, "run_2", "s1", root)

    removeWorktree(ws, a)

    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(true)
    expect(existsSync(join(root, "run_2"))).toBe(true)

    removeWorktree(ws, b)
    expect(existsSync(join(root, "run_2"))).toBe(false)
  })

  it("keeps the parent when a sibling worktree was deliberately kept for debugging", () => {
    const ok = createWorktree(ws, "run_3", "s0", root)
    createWorktree(ws, "run_3", "s1", root) // the failed step's worktree — never removed

    removeWorktree(ws, ok)

    // pipeline.ts keeps a failed step's worktree on purpose; reclaiming the parent
    // would delete the very evidence that branch exists to preserve.
    expect(existsSync(join(root, "run_3", "s1"))).toBe(true)
    expect(existsSync(join(root, "run_3"))).toBe(true)
  })

  it("does not throw when the worktree is already gone", () => {
    const dir = createWorktree(ws, "run_4", "s0", root)
    removeWorktree(ws, dir)
    expect(() => removeWorktree(ws, dir)).not.toThrow()
    expect(existsSync(join(root, "run_4"))).toBe(false)
  })

  it("never climbs past the run dir to the worktrees root", () => {
    // The reclaim is one `rmdir` of dir's PARENT — it must not walk upward. If it
    // ever did, the last run in a workspace would take the shared worktrees root
    // (and on a custom ULTRAWORK_WORKTREES_DIR, whatever the user pointed it at).
    const dir = createWorktree(ws, "run_5", "s0", root)
    removeWorktree(ws, dir)
    expect(existsSync(join(root, "run_5"))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it("is safe when two fan-out steps finish at the same time", () => {
    // Both siblings race to reclaim the same parent: one rmdir wins, the other
    // hits ENOENT. Neither may throw — a step must never fail on cleanup.
    const a = createWorktree(ws, "run_6", "s0", root)
    const b = createWorktree(ws, "run_6", "s1", root)
    expect(() => {
      removeWorktree(ws, a)
      removeWorktree(ws, b)
      removeWorktree(ws, b) // double-reclaim, as a retry would do
    }).not.toThrow()
    expect(existsSync(join(root, "run_6"))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })
})
