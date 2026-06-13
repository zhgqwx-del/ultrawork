import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConnectorEvent } from "@agent/connector"
import { Orchestrator, RecipeValidationError, RunNotCancellableError, RunNotFoundError } from "../orchestrator"
import { RunStore } from "../run-store"
import { GovernanceError, type OrchestrationRun, type OrchestratorEvent, type PipelineRecipe } from "../types"
import {
  deferred,
  fakeBackend,
  finishEvent,
  idleEvent,
  makeConnector,
  permissionAskedEvent,
  sessionErrorEvent,
  type FakeBackendOptions,
} from "./helpers"

/** Pull the deliverable path out of the artifact contract section. */
function artifactFromPrompt(text: string): string | undefined {
  return text.match(/（覆盖写）：(.+)/)?.[1]
}

describe("Orchestrator", () => {
  let workspace: string
  let hiddenParentDir: string
  let storeDir: string
  let store: RunStore

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "orch-ws-")))
    hiddenParentDir = realpathSync(mkdtempSync(join(tmpdir(), "orch-hidden-")))
    storeDir = mkdtempSync(join(tmpdir(), "orch-store-"))
    store = new RunStore(storeDir)
  })

  afterEach(() => {
    for (const dir of [workspace, hiddenParentDir, storeDir]) rmSync(dir, { recursive: true, force: true })
  })

  function build(opts: {
    opencode?: Partial<FakeBackendOptions>
    acp?: Partial<FakeBackendOptions>
    governance?: ConstructorParameters<typeof Orchestrator>[0]["governance"]
    hiddenParent?: boolean
  } = {}) {
    const opencode = fakeBackend({ kind: "opencode", sessionStatus: true, ...opts.opencode })
    const acp = fakeBackend({ kind: "acp", ...opts.acp })
    const connector = makeConnector([opencode, acp])
    const orchestrator = new Orchestrator({
      connectorFor: () => connector,
      store,
      governance: opts.governance,
      hiddenParentWorkspace: opts.hiddenParent === false ? undefined : hiddenParentDir,
    })
    return { opencode, acp, connector, orchestrator }
  }

  function recipe(overrides: Partial<PipelineRecipe> = {}): PipelineRecipe {
    return {
      name: "review",
      workspace,
      steps: [
        { id: "analyze", agentId: "opencode:default", taskPrompt: "分析代码" },
        { id: "report", agentId: "acp:claude", taskPrompt: "输出报告" },
      ],
      ...overrides,
    }
  }

  async function waitForStatus(orchestrator: Orchestrator, runId: string, status: OrchestrationRun["status"]) {
    await vi.waitFor(() => expect(orchestrator.getRun(runId)!.status).toBe(status))
    return orchestrator.getRun(runId)!
  }

  describe("pipeline happy path (artifact chaining)", () => {
    it("runs a 2-step cross-backend pipeline end to end", async () => {
      const prompts: Record<string, string[]> = { opencode: [], acp: [] }
      const { opencode, acp, orchestrator } = build({
        opencode: {
          onPrompt: (sid, text, emit) => {
            prompts.opencode.push(text)
            const artifact = artifactFromPrompt(text)
            if (artifact) writeFileSync(artifact, "analysis result")
            emit(finishEvent(sid))
            emit(idleEvent(sid))
          },
        },
        acp: {
          onPrompt: (_sid, text) => {
            prompts.acp.push(text)
            const artifact = artifactFromPrompt(text)
            if (artifact) writeFileSync(artifact, "final report")
          },
        },
      })

      const created = await orchestrator.createRun(recipe())
      // inputs normalized at creation: step 2 defaults to [previous step]
      expect(created.recipe.steps[1].inputs).toEqual(["analyze"])

      const run = await waitForStatus(orchestrator, created.id, "completed")
      expect(run.steps.map((s) => s.status)).toEqual(["completed", "completed"])
      expect(run.steps.every((s) => s.sessionId)).toBe(true)

      // artifact chain: step1 wrote its deliverable, step2's prompt references it
      const analyzePath = run.steps[0].artifactPath!
      expect(existsSync(analyzePath)).toBe(true)
      expect(analyzePath.startsWith(join(workspace, ".ultrawork", "runs", run.id))).toBe(true)
      expect(prompts.acp[0]).toContain(analyzePath)
      expect(prompts.acp[0]).toContain("输入产物")
      expect(readFileSync(run.steps[1].artifactPath!, "utf-8")).toBe("final report")

      // hidden opencode parent: created in the hidden dir, child hangs off it
      expect(run.parentSessionId).toBeDefined()
      const [parent, child] = opencode.createdSessions
      expect(parent.title).toBe("[orchestration] review")
      expect(parent.parentSessionId).toBeUndefined()
      expect(child.parentSessionId).toBe(run.parentSessionId)

      // ACP child: bound + created without clientSessionId (no opencode twin)
      expect(acp.createdSessions[0].clientSessionId).toBeUndefined()
      expect(acp.createdSessions[0].agentId).toBe("acp:claude")

      // persisted terminal state
      expect(store.load().map((r) => [r.id, r.status])).toEqual([[run.id, "completed"]])
    })

    it("skips hidden-parent creation when hiddenParentWorkspace is unset", async () => {
      const { opencode, orchestrator } = build({
        hiddenParent: false,
        opencode: {
          onPrompt: (sid, text, emit) => {
            const artifact = artifactFromPrompt(text)
            if (artifact) writeFileSync(artifact, "ok")
            emit(finishEvent(sid))
          },
        },
      })
      const created = await orchestrator.createRun(
        recipe({ steps: [{ id: "only", agentId: "opencode:default", taskPrompt: "go" }] }),
      )
      const run = await waitForStatus(orchestrator, created.id, "completed")
      expect(run.parentSessionId).toBeUndefined()
      expect(opencode.createdSessions).toHaveLength(1)
    })
  })

  describe("failure propagation", () => {
    it("fails the step and run when the deliverable file is missing", async () => {
      const { acp, orchestrator } = build({
        opencode: {
          onPrompt: (sid, _text, emit) => {
            emit(finishEvent(sid))
            emit(idleEvent(sid))
          },
        },
      })
      const created = await orchestrator.createRun(recipe())
      const run = await waitForStatus(orchestrator, created.id, "failed")
      expect(run.steps[0].status).toBe("failed")
      expect(run.steps[0].error).toContain("deliverable missing")
      expect(run.steps[1].status).toBe("skipped")
      expect(acp.prompt).not.toHaveBeenCalled()
    })

    it("fails the run on session.error and skips the rest", async () => {
      const { orchestrator } = build({
        opencode: {
          onPrompt: (sid, _text, emit) => emit(sessionErrorEvent(sid, "model exploded")),
        },
      })
      const created = await orchestrator.createRun(recipe())
      const run = await waitForStatus(orchestrator, created.id, "failed")
      expect(run.steps[0].error).toContain("model exploded")
      expect(run.steps[1].status).toBe("skipped")
    })

    it("times out a hung step via the governance timeout", async () => {
      const { opencode, orchestrator } = build({
        governance: { defaultTimeoutMs: 50 },
      })
      const created = await orchestrator.createRun(recipe())
      const run = await waitForStatus(orchestrator, created.id, "failed")
      expect(run.steps[0].status).toBe("failed")
      expect(run.steps[0].error).toContain("timed out")
      expect(opencode.cancel).toHaveBeenCalled()
    })
  })

  describe("cancellation", () => {
    it("cancelRun aborts the in-flight step and skips the rest", async () => {
      const gate = deferred()
      const { acp, orchestrator } = build({
        acp: { onPrompt: () => gate.promise },
      })
      const created = await orchestrator.createRun(
        recipe({
          steps: [
            { id: "long", agentId: "acp:claude", taskPrompt: "long task" },
            { id: "after", agentId: "acp:claude", taskPrompt: "next" },
          ],
        }),
      )
      await vi.waitFor(() => expect(orchestrator.getRun(created.id)!.steps[0].sessionId).toBeDefined())

      await orchestrator.cancelRun(created.id)
      const run = await waitForStatus(orchestrator, created.id, "cancelled")
      expect(run.steps[0].status).toBe("cancelled")
      expect(run.steps[1].status).toBe("skipped")
      expect(acp.cancel).toHaveBeenCalled()
    })

    it("cancelRun rejects for unknown or terminal runs", async () => {
      const { orchestrator } = build({
        opencode: {
          onPrompt: (sid, text, emit) => {
            const artifact = artifactFromPrompt(text)
            if (artifact) writeFileSync(artifact, "ok")
            emit(finishEvent(sid))
          },
        },
      })
      await expect(orchestrator.cancelRun("run_nope")).rejects.toThrow(RunNotFoundError)

      const created = await orchestrator.createRun(
        recipe({ steps: [{ id: "only", agentId: "opencode:default", taskPrompt: "go" }] }),
      )
      await waitForStatus(orchestrator, created.id, "completed")
      await expect(orchestrator.cancelRun(created.id)).rejects.toThrow(RunNotCancellableError)
    })
  })

  describe("events", () => {
    it("relays child permission events as step.permission", async () => {
      const gate = deferred()
      const { acp, orchestrator } = build({ acp: { onPrompt: () => gate.promise } })
      const events: OrchestratorEvent[] = []
      orchestrator.subscribe((event) => events.push(event))

      const created = await orchestrator.createRun(
        recipe({ steps: [{ id: "ask", agentId: "acp:claude", taskPrompt: "needs perms" }] }),
      )
      await vi.waitFor(() => expect(orchestrator.getRun(created.id)!.steps[0].sessionId).toBeDefined())
      const sessionId = orchestrator.getRun(created.id)!.steps[0].sessionId!

      acp.emit(permissionAskedEvent(sessionId))
      const permission = events.find((e) => e.type === "step.permission")
      expect(permission).toBeDefined()
      expect(permission!.properties).toMatchObject({ runId: created.id, stepId: "ask", sessionId })

      gate.resolve()
    })

    it("subscribeRun filters events to one run", async () => {
      const { orchestrator } = build({
        opencode: {
          onPrompt: (sid, text, emit) => {
            const artifact = artifactFromPrompt(text)
            if (artifact) writeFileSync(artifact, "ok")
            emit(finishEvent(sid))
          },
        },
      })
      const seen: OrchestratorEvent[] = []
      const single = recipe({ steps: [{ id: "only", agentId: "opencode:default", taskPrompt: "go" }] })

      const first = await orchestrator.createRun(single)
      orchestrator.subscribeRun(first.id, (event) => seen.push(event))
      const second = await orchestrator.createRun({ ...single, name: "other" })

      await waitForStatus(orchestrator, first.id, "completed")
      await waitForStatus(orchestrator, second.id, "completed")
      expect(seen.length).toBeGreaterThan(0)
      for (const event of seen) {
        const id = event.type === "run.updated" ? event.properties.run.id : event.properties.runId
        expect(id).toBe(first.id)
      }
    })
  })

  describe("governance primitives", () => {
    it("rejects spawns beyond maxDepth", async () => {
      const { orchestrator } = build({})
      await expect(
        orchestrator.spawn({ agentId: "acp:claude", task: "nested", workspace, depth: 1 }),
      ).rejects.toThrow(GovernanceError)
    })

    it("queues spawns beyond maxConcurrent and drains FIFO", async () => {
      const gates = [deferred(), deferred()]
      let promptCount = 0
      const { acp, orchestrator } = build({
        governance: { maxConcurrent: 1 },
        acp: { onPrompt: () => gates[promptCount++].promise },
      })

      const first = await orchestrator.spawn({ agentId: "acp:claude", task: "one", workspace })
      const second = await orchestrator.spawn({ agentId: "acp:claude", task: "two", workspace })
      await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalledTimes(1))

      gates[0].resolve()
      await expect(first.done).resolves.toMatchObject({ status: "completed" })
      await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalledTimes(2))
      gates[1].resolve()
      await expect(second.done).resolves.toMatchObject({ status: "completed" })
    })

    it("steer queues a follow-up turn after the current one", async () => {
      const gates = [deferred(), deferred()]
      let promptCount = 0
      const texts: string[] = []
      const { acp, orchestrator } = build({
        acp: {
          onPrompt: (_sid, text) => {
            texts.push(text)
            return gates[promptCount++].promise
          },
        },
      })

      const handle = await orchestrator.spawn({ agentId: "acp:claude", task: "main", workspace })
      const steered = orchestrator.steer(handle.taskId, "course-correct")
      await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalledTimes(1))
      expect(texts).toEqual(["main"]) // steer waits for the first turn

      gates[0].resolve()
      await vi.waitFor(() => expect(texts).toEqual(["main", "course-correct"]))
      gates[1].resolve()
      await steered
      await expect(handle.done).resolves.toMatchObject({ status: "completed" })
    })

    it("cancelTask settles the task as cancelled", async () => {
      const { orchestrator } = build({ acp: { onPrompt: () => deferred().promise } })
      const handle = await orchestrator.spawn({ agentId: "acp:claude", task: "hang", workspace })
      await orchestrator.cancelTask(handle.taskId)
      await expect(handle.done).resolves.toMatchObject({ status: "cancelled" })
    })

    it("denies the delegate MCP tools on opencode children (and steer), not on ACP", async () => {
      const { opencode, acp, orchestrator } = build({
        opencode: {
          onPrompt: (sid, _text, emit) => {
            emit(finishEvent(sid))
            emit(idleEvent(sid))
          },
        },
      })

      const ocHandle = await orchestrator.spawn({ agentId: "opencode:default", task: "child", workspace })
      await expect(ocHandle.done).resolves.toMatchObject({ status: "completed" })
      expect(opencode.prompt).toHaveBeenCalledWith(
        ocHandle.sessionId,
        "child",
        expect.objectContaining({ tools: { "orchestrator_*": false } }),
      )

      await orchestrator.steer(ocHandle.taskId, "follow-up")
      expect(opencode.prompt).toHaveBeenLastCalledWith(
        ocHandle.sessionId,
        "follow-up",
        expect.objectContaining({ tools: { "orchestrator_*": false } }),
      )

      const acpHandle = await orchestrator.spawn({ agentId: "acp:claude", task: "child", workspace })
      await expect(acpHandle.done).resolves.toMatchObject({ status: "completed" })
      expect(acp.prompt).toHaveBeenCalledWith(
        acpHandle.sessionId,
        "child",
        expect.objectContaining({ tools: undefined }),
      )
    })
  })

  describe("recipe validation", () => {
    it.each<[string, PipelineRecipe]>([
      ["missing workspace dir", { name: "x", workspace: join(tmpdir(), "definitely-missing-dir"), steps: [{ id: "a", agentId: "opencode:default", taskPrompt: "t" }] }],
      ["empty steps", { name: "x", workspace: ".", steps: [] }],
      [
        "duplicate ids",
        {
          name: "x",
          workspace: ".",
          steps: [
            { id: "a", agentId: "opencode:default", taskPrompt: "t" },
            { id: "a", agentId: "acp:claude", taskPrompt: "t" },
          ],
        },
      ],
      [
        "forward input reference",
        {
          name: "x",
          workspace: ".",
          steps: [
            { id: "a", agentId: "opencode:default", taskPrompt: "t", inputs: ["b"] },
            { id: "b", agentId: "acp:claude", taskPrompt: "t" },
          ],
        },
      ],
    ])("rejects %s", async (_label, bad) => {
      const { orchestrator } = build({})
      const candidate = { ...bad, workspace: bad.workspace === "." ? workspace : bad.workspace }
      await expect(orchestrator.createRun(candidate)).rejects.toThrow(RecipeValidationError)
    })

    it("normalizes the workspace through realpath", async () => {
      const { orchestrator } = build({
        opencode: {
          onPrompt: (sid, text, emit) => {
            const artifact = artifactFromPrompt(text)
            if (artifact) writeFileSync(artifact, "ok")
            emit(finishEvent(sid))
          },
        },
      })
      // tmpdir() on macOS is a symlink (/var → /private/var) — same gotcha as /tmp
      const symlinked = mkdtempSync(join(tmpdir(), "orch-sym-"))
      try {
        const created = await orchestrator.createRun(
          recipe({ workspace: symlinked, steps: [{ id: "only", agentId: "opencode:default", taskPrompt: "go" }] }),
        )
        expect(created.recipe.workspace).toBe(realpathSync(symlinked))
        await waitForStatus(orchestrator, created.id, "completed")
      } finally {
        rmSync(symlinked, { recursive: true, force: true })
      }
    })
  })

  describe("persistence & recovery", () => {
    it("marks persisted running runs as interrupted on loadPersisted", () => {
      const stale: OrchestrationRun = {
        version: 1,
        id: "run_stale",
        recipe: {
          name: "stale",
          workspace,
          steps: [
            { id: "a", agentId: "opencode:default", taskPrompt: "t", inputs: [] },
            { id: "b", agentId: "acp:claude", taskPrompt: "t", inputs: ["a"] },
          ],
        },
        status: "running",
        steps: [
          { id: "a", agentId: "opencode:default", status: "running", sessionId: "s1" },
          { id: "b", agentId: "acp:claude", status: "pending" },
        ],
        createdAt: 1,
        updatedAt: 1,
      }
      store.save(stale)

      const { orchestrator } = build({})
      orchestrator.loadPersisted()

      const run = orchestrator.getRun("run_stale")!
      expect(run.status).toBe("interrupted")
      expect(run.steps[0].status).toBe("failed")
      expect(run.steps[0].error).toBe("sidecar restarted")
      expect(run.steps[1].status).toBe("skipped")
      // re-persisted: a second loader sees the terminal state
      expect(store.load().find((r) => r.id === "run_stale")!.status).toBe("interrupted")
    })

    it("leaves terminal runs untouched and lists newest first", () => {
      const terminal = (id: string, updatedAt: number): OrchestrationRun => ({
        version: 1,
        id,
        recipe: { name: id, workspace, steps: [{ id: "a", agentId: "opencode:default", taskPrompt: "t", inputs: [] }] },
        status: "completed",
        steps: [{ id: "a", agentId: "opencode:default", status: "completed" }],
        createdAt: updatedAt,
        updatedAt,
      })
      store.save(terminal("run_old", 100))
      store.save(terminal("run_new", 200))

      const { orchestrator } = build({})
      orchestrator.loadPersisted()
      expect(orchestrator.listRuns().map((r) => r.id)).toEqual(["run_new", "run_old"])
      expect(orchestrator.getRun("run_old")!.status).toBe("completed")
    })
  })
})

describe("permission relay shape", () => {
  it("forwards the raw connector event inside step.permission", () => {
    // Shape contract for the UI: properties.event IS the ConnectorEvent.
    const raw: ConnectorEvent = { type: "permission.asked", properties: { sessionID: "s1", id: "p1" } }
    const wrapped: OrchestratorEvent = {
      type: "step.permission",
      properties: { runId: "r1", stepId: "a", sessionId: "s1", event: raw },
    }
    expect(wrapped.properties.event.type).toBe("permission.asked")
  })
})
