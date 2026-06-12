// DAG executor (Fan-out) + worktree isolation (ADR-031 第二批 M5).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Orchestrator, RecipeValidationError } from "../orchestrator"
import { RunStore } from "../run-store"
import type { OrchestrationRun, PipelineRecipe } from "../types"
import { deferred, fakeBackend, finishEvent, idleEvent, makeConnector, type Deferred, type FakeBackendOptions } from "./helpers"

function artifactFromPrompt(text: string): string | undefined {
  return text.match(/（覆盖写）：(.+)/)?.[1]
}

describe("DAG executor (fan-out)", () => {
  let workspace: string
  let hiddenParentDir: string
  let storeDir: string
  let worktreesDir: string
  let store: RunStore
  let prevWorktreesEnv: string | undefined

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "fan-ws-")))
    hiddenParentDir = realpathSync(mkdtempSync(join(tmpdir(), "fan-hidden-")))
    storeDir = mkdtempSync(join(tmpdir(), "fan-store-"))
    worktreesDir = realpathSync(mkdtempSync(join(tmpdir(), "fan-wt-")))
    store = new RunStore(storeDir)
    prevWorktreesEnv = process.env.ULTRAWORK_WORKTREES_DIR
    process.env.ULTRAWORK_WORKTREES_DIR = worktreesDir
  })

  afterEach(() => {
    if (prevWorktreesEnv === undefined) delete process.env.ULTRAWORK_WORKTREES_DIR
    else process.env.ULTRAWORK_WORKTREES_DIR = prevWorktreesEnv
    for (const dir of [workspace, hiddenParentDir, storeDir, worktreesDir]) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function gitInit(dir: string): void {
    execSync(
      `git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`,
      { cwd: dir },
    )
  }

  function build(opts: {
    opencode?: Partial<FakeBackendOptions>
    acp?: Partial<FakeBackendOptions>
    releaseConnector?: (workspace: string) => void
  } = {}) {
    const opencode = fakeBackend({ kind: "opencode", sessionStatus: true, ...opts.opencode })
    const acp = fakeBackend({ kind: "acp", ...opts.acp })
    const connector = makeConnector([opencode, acp])
    const orchestrator = new Orchestrator({
      connectorFor: () => connector,
      releaseConnector: opts.releaseConnector,
      store,
      hiddenParentWorkspace: hiddenParentDir,
    })
    return { opencode, acp, connector, orchestrator }
  }

  async function waitForStatus(orchestrator: Orchestrator, runId: string, status: OrchestrationRun["status"]) {
    await vi.waitFor(() => expect(orchestrator.getRun(runId)!.status).toBe(status), { timeout: 5000 })
    return orchestrator.getRun(runId)!
  }

  /** plan → (w1 ∥ w2) → agg */
  function fanoutRecipe(overrides: Partial<PipelineRecipe> = {}): PipelineRecipe {
    return {
      name: "fanout",
      workspace,
      steps: [
        { id: "plan", agentId: "acp:claude", taskPrompt: "拆解任务", inputs: [] },
        { id: "w1", agentId: "acp:claude", taskPrompt: "worker 1", inputs: ["plan"] },
        { id: "w2", agentId: "acp:claude", taskPrompt: "worker 2", inputs: ["plan"] },
        { id: "agg", agentId: "acp:claude", taskPrompt: "聚合", inputs: ["w1", "w2"] },
      ],
      ...overrides,
    }
  }

  it("runs ready steps in parallel and the aggregator after all workers", async () => {
    const gates = new Map<string, Deferred<void>>()
    const order: string[] = []
    const { orchestrator } = build({
      acp: {
        onPrompt: (_sid, text) => {
          const id = text.split("\n")[0].includes("worker 1")
            ? "w1"
            : text.split("\n")[0].includes("worker 2")
              ? "w2"
              : text.includes("拆解任务")
                ? "plan"
                : "agg"
          order.push(id)
          const artifact = artifactFromPrompt(text)
          if (artifact) writeFileSync(artifact, `out:${id}`)
          if (id === "w1" || id === "w2") {
            const gate = deferred()
            gates.set(id, gate)
            return gate.promise
          }
        },
      },
    })

    const created = await orchestrator.createRun(fanoutRecipe())
    // Both workers must be IN FLIGHT at the same time (true parallelism).
    await vi.waitFor(() => expect(gates.size).toBe(2))
    expect(order).toEqual(["plan", "w1", "w2"])
    expect(orchestrator.getRun(created.id)!.steps.filter((s) => s.status === "running")).toHaveLength(2)

    gates.get("w1")!.resolve()
    gates.get("w2")!.resolve()
    const run = await waitForStatus(orchestrator, created.id, "completed")
    expect(order[3]).toBe("agg")
    expect(run.steps.map((s) => s.status)).toEqual(["completed", "completed", "completed", "completed"])
    // Aggregator received BOTH worker artifacts as inputs.
    expect(readFileSync(run.steps[3].artifactPath!, "utf-8")).toBe("out:agg")
  })

  it("a failed worker skips only its transitive downstream; the sibling finishes; run fails", async () => {
    const w2Gate = deferred()
    const { orchestrator } = build({
      acp: {
        onPrompt: async (_sid, text) => {
          const artifact = artifactFromPrompt(text)
          if (text.includes("worker 1")) throw new Error("w1 exploded")
          if (text.includes("worker 2")) {
            await w2Gate.promise
            if (artifact) writeFileSync(artifact, "w2 done")
            return
          }
          if (artifact) writeFileSync(artifact, "ok")
        },
      },
    })

    const created = await orchestrator.createRun(fanoutRecipe())
    // w1 fails while w2 is still running → agg skipped immediately.
    await vi.waitFor(() => {
      const run = orchestrator.getRun(created.id)!
      expect(run.steps.find((s) => s.id === "w1")!.status).toBe("failed")
      expect(run.steps.find((s) => s.id === "agg")!.status).toBe("skipped")
    })
    expect(orchestrator.getRun(created.id)!.steps.find((s) => s.id === "w2")!.status).toBe("running")

    w2Gate.resolve()
    const run = await waitForStatus(orchestrator, created.id, "failed")
    expect(run.steps.find((s) => s.id === "w2")!.status).toBe("completed")
    expect(run.error).toContain("w1")
  })

  it("cancelRun aborts ALL in-flight workers", async () => {
    const started: string[] = []
    const { orchestrator } = build({
      acp: {
        onPrompt: (_sid, text) => {
          const artifact = artifactFromPrompt(text)
          if (text.includes("拆解任务")) {
            if (artifact) writeFileSync(artifact, "plan")
            return
          }
          started.push(text.includes("worker 1") ? "w1" : "w2")
          return deferred().promise // hang until aborted
        },
      },
    })

    const created = await orchestrator.createRun(fanoutRecipe())
    await vi.waitFor(() => expect(started).toHaveLength(2))
    await orchestrator.cancelRun(created.id)

    const run = await waitForStatus(orchestrator, created.id, "cancelled")
    expect(run.steps.find((s) => s.id === "w1")!.status).toBe("cancelled")
    expect(run.steps.find((s) => s.id === "w2")!.status).toBe("cancelled")
    expect(run.steps.find((s) => s.id === "agg")!.status).toBe("skipped")
  })

  it("creates the hidden opencode parent exactly once for parallel opencode roots", async () => {
    const { opencode, orchestrator } = build({
      opencode: {
        onPrompt: (sid, text, emit) => {
          const artifact = artifactFromPrompt(text)
          if (artifact) writeFileSync(artifact, "ok")
          emit(finishEvent(sid))
          emit(idleEvent(sid))
        },
      },
    })

    const created = await orchestrator.createRun({
      name: "parallel-oc",
      workspace,
      steps: [
        { id: "a", agentId: "opencode:default", taskPrompt: "t", inputs: [] },
        { id: "b", agentId: "opencode:default", taskPrompt: "t", inputs: [] },
        { id: "c", agentId: "opencode:default", taskPrompt: "t", inputs: [] },
      ],
    })
    const run = await waitForStatus(orchestrator, created.id, "completed")

    // 1 hidden parent + 3 children, all children under the SAME parent.
    expect(opencode.createdSessions).toHaveLength(4)
    const [parent, ...children] = opencode.createdSessions
    expect(parent.title).toBe("[orchestration] parallel-oc")
    expect(children.every((c) => c.parentSessionId === run.parentSessionId)).toBe(true)
  })

  describe("worktree isolation", () => {
    it("stages inputs in, collects the artifact out, and removes the worktree on success", async () => {
      gitInit(workspace)
      const released: string[] = []
      const prompts: string[] = []
      const { orchestrator } = build({
        releaseConnector: (ws) => released.push(ws),
        acp: {
          onPrompt: (_sid, text) => {
            prompts.push(text)
            const artifact = artifactFromPrompt(text)
            if (artifact) writeFileSync(artifact, text.includes("拆解") ? "the plan" : "worker out")
          },
        },
      })

      const created = await orchestrator.createRun({
        name: "wt",
        workspace,
        steps: [
          { id: "plan", agentId: "acp:claude", taskPrompt: "拆解", inputs: [] },
          { id: "w1", agentId: "acp:claude", taskPrompt: "干活", inputs: ["plan"], isolation: "worktree" },
        ],
      })
      const run = await waitForStatus(orchestrator, created.id, "completed")

      const expectedWorktree = join(worktreesDir, run.id, "w1")
      // The worker ran INSIDE the worktree: its prompt references worktree paths.
      const workerPrompt = prompts.find((p) => p.includes("干活"))!
      expect(artifactFromPrompt(workerPrompt)!.startsWith(expectedWorktree)).toBe(true)
      // Input artifact was STAGED into the worktree (not the main-dir path).
      expect(workerPrompt).toContain(join(expectedWorktree, ".ultrawork", "runs", run.id, "plan.md"))

      // Deliverable collected back to the MAIN run dir; worktree removed.
      const w1 = run.steps.find((s) => s.id === "w1")!
      expect(w1.artifactPath!.startsWith(join(workspace, ".ultrawork", "runs", run.id))).toBe(true)
      expect(readFileSync(w1.artifactPath!, "utf-8")).toBe("worker out")
      expect(w1.worktreePath).toBeUndefined()
      expect(existsSync(expectedWorktree)).toBe(false)
      expect(released).toEqual([expectedWorktree])
    })

    it("keeps the worktree (and its path on the step) when the step fails", async () => {
      gitInit(workspace)
      const { orchestrator } = build({
        acp: { onPrompt: () => {} }, // never writes the deliverable
      })

      const created = await orchestrator.createRun({
        name: "wt-fail",
        workspace,
        steps: [{ id: "w1", agentId: "acp:claude", taskPrompt: "干活", inputs: [], isolation: "worktree" }],
      })
      const run = await waitForStatus(orchestrator, created.id, "failed")

      const w1 = run.steps[0]
      expect(w1.status).toBe("failed")
      expect(w1.error).toContain("deliverable missing")
      expect(w1.worktreePath).toBe(join(worktreesDir, run.id, "w1"))
      expect(existsSync(w1.worktreePath!)).toBe(true)
    })

    it("rejects worktree isolation outside a git repo and duplicate artifact names", async () => {
      const { orchestrator } = build({})
      await expect(
        orchestrator.createRun({
          name: "no-git",
          workspace,
          steps: [{ id: "w1", agentId: "acp:claude", taskPrompt: "t", inputs: [], isolation: "worktree" }],
        }),
      ).rejects.toThrow(RecipeValidationError)

      await expect(
        orchestrator.createRun({
          name: "dup-artifact",
          workspace,
          steps: [
            { id: "a", agentId: "acp:claude", taskPrompt: "t", inputs: [], artifactName: "same.md" },
            { id: "b", agentId: "acp:claude", taskPrompt: "t", inputs: [], artifactName: "same.md" },
          ],
        }),
      ).rejects.toThrow(/duplicate artifact name/)
    })
  })
})
