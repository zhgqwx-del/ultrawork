// /orchestration/* route shapes against a stubbed Orchestrator.

import { describe, it, expect } from "bun:test"
import type { Orchestrator, OrchestrationRun, OrchestratorEvent } from "@agent/orchestrator"
import { RecipeValidationError, RunNotCancellableError, RunNotFoundError } from "@agent/orchestrator"
import { orchestrationRoutes } from "../orchestration-routes.js"

function sampleRun(id = "run_1"): OrchestrationRun {
  return {
    version: 1,
    id,
    recipe: { name: "n", workspace: "/ws", steps: [{ id: "a", agentId: "opencode:default", taskPrompt: "t", inputs: [] }] },
    status: "running",
    steps: [{ id: "a", agentId: "opencode:default", status: "running" }],
    createdAt: 1,
    updatedAt: 2,
  }
}

interface StubBehavior {
  createRun?: (recipe: unknown) => Promise<OrchestrationRun>
  cancelRun?: (runId: string) => Promise<void>
  runs?: OrchestrationRun[]
  subscribeRun?: (runId: string, handler: (e: OrchestratorEvent) => void) => () => void
}

function stubOrchestrator(behavior: StubBehavior = {}): Orchestrator {
  const runs = behavior.runs ?? [sampleRun()]
  return {
    createRun: behavior.createRun ?? (async () => sampleRun()),
    cancelRun: behavior.cancelRun ?? (async () => {}),
    listRuns: () => runs,
    getRun: (id: string) => runs.find((r) => r.id === id),
    subscribeRun: behavior.subscribeRun ?? (() => () => {}),
  } as unknown as Orchestrator
}

describe("orchestration routes", () => {
  it("POST /orchestration/runs creates a run (201)", async () => {
    const app = orchestrationRoutes(stubOrchestrator())
    const res = await app.request("/orchestration/runs", {
      method: "POST",
      body: JSON.stringify({ recipe: { name: "n", workspace: "/ws", steps: [] } }),
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { run: OrchestrationRun }
    expect(body.run.id).toBe("run_1")
  })

  it("POST /orchestration/runs rejects a missing recipe (400)", async () => {
    const app = orchestrationRoutes(stubOrchestrator())
    const res = await app.request("/orchestration/runs", { method: "POST", body: "{}" })
    expect(res.status).toBe(400)
  })

  it("POST /orchestration/runs maps RecipeValidationError to 400", async () => {
    const app = orchestrationRoutes(
      stubOrchestrator({
        createRun: async () => {
          throw new RecipeValidationError("bad workspace")
        },
      }),
    )
    const res = await app.request("/orchestration/runs", {
      method: "POST",
      body: JSON.stringify({ recipe: { name: "n" } }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("bad workspace")
  })

  it("GET /orchestration/runs lists runs", async () => {
    const app = orchestrationRoutes(stubOrchestrator())
    const res = await app.request("/orchestration/runs")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { runs: OrchestrationRun[] }).runs).toHaveLength(1)
  })

  it("GET /orchestration/runs/:id returns 404 for unknown runs", async () => {
    const app = orchestrationRoutes(stubOrchestrator())
    expect((await app.request("/orchestration/runs/run_1")).status).toBe(200)
    expect((await app.request("/orchestration/runs/run_nope")).status).toBe(404)
  })

  it("POST cancel maps domain errors to 404/409", async () => {
    const notFound = orchestrationRoutes(
      stubOrchestrator({
        cancelRun: async () => {
          throw new RunNotFoundError("run_x")
        },
      }),
    )
    expect((await notFound.request("/orchestration/runs/run_x/cancel", { method: "POST" })).status).toBe(404)

    const terminal = orchestrationRoutes(
      stubOrchestrator({
        cancelRun: async () => {
          throw new RunNotCancellableError("completed")
        },
      }),
    )
    expect((await terminal.request("/orchestration/runs/run_1/cancel", { method: "POST" })).status).toBe(409)

    const ok = orchestrationRoutes(stubOrchestrator())
    const res = await ok.request("/orchestration/runs/run_1/cancel", { method: "POST" })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
  })

  it("GET events streams a full snapshot first, then live events", async () => {
    let pushEvent: ((e: OrchestratorEvent) => void) | undefined
    const app = orchestrationRoutes(
      stubOrchestrator({
        subscribeRun: (_runId, handler) => {
          pushEvent = handler
          return () => {}
        },
      }),
    )
    const res = await app.request("/orchestration/runs/run_1/events")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    expect(first).toContain('"type":"run.updated"')
    expect(first).toContain('"id":"run_1"')

    // The stream callback registers subscribeRun after the snapshot write —
    // wait for it before pushing a live event.
    while (!pushEvent) await new Promise((resolve) => setTimeout(resolve, 1))
    pushEvent({ type: "step.updated", properties: { runId: "run_1", step: { id: "a", agentId: "x", status: "completed" } } })
    const second = decoder.decode((await reader.read()).value)
    expect(second).toContain('"type":"step.updated"')
    await reader.cancel()
  })

  it("GET events returns 404 for unknown runs", async () => {
    const app = orchestrationRoutes(stubOrchestrator())
    expect((await app.request("/orchestration/runs/run_nope/events")).status).toBe(404)
  })
})
