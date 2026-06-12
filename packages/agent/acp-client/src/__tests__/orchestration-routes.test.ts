// /orchestration/* route shapes against a stubbed Orchestrator.

import { describe, it, expect } from "bun:test"
import type {
  DelegateEvent,
  DelegateManager,
  DelegateRecord,
  DelegateResult,
  Orchestrator,
  OrchestrationRun,
  OrchestratorEvent,
} from "@agent/orchestrator"
import {
  DelegateRequestError,
  GovernanceError,
  RecipeValidationError,
  RunNotCancellableError,
  RunNotFoundError,
} from "@agent/orchestrator"
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

function sampleDelegate(id = "dlg_1"): DelegateRecord {
  return {
    id,
    agentId: "acp:claude",
    task: "do the thing",
    workspace: "/ws",
    status: "running",
    startedAt: 1,
  }
}

interface DelegateStubBehavior {
  delegate?: (req: unknown) => Promise<DelegateResult>
  records?: DelegateRecord[]
  subscribe?: (handler: (e: DelegateEvent) => void) => () => void
}

function stubDelegates(behavior: DelegateStubBehavior = {}): DelegateManager {
  return {
    delegate:
      behavior.delegate ??
      (async () => ({ status: "completed", sessionId: "child-1", deliverable: "done" }) as DelegateResult),
    list: () => behavior.records ?? [sampleDelegate()],
    subscribe: behavior.subscribe ?? (() => () => {}),
  } as unknown as DelegateManager
}

function makeApp(behavior: StubBehavior = {}, delegateBehavior: DelegateStubBehavior = {}) {
  return orchestrationRoutes(stubOrchestrator(behavior), stubDelegates(delegateBehavior), {
    listAgents: () => [{ id: "opencode:default", name: "OpenCode", status: "available" }],
  })
}

describe("orchestration routes", () => {
  it("POST /orchestration/runs creates a run (201)", async () => {
    const app = makeApp()
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
    const app = makeApp()
    const res = await app.request("/orchestration/runs", { method: "POST", body: "{}" })
    expect(res.status).toBe(400)
  })

  it("POST /orchestration/runs maps RecipeValidationError to 400", async () => {
    const app = makeApp({
      createRun: async () => {
        throw new RecipeValidationError("bad workspace")
      },
    })
    const res = await app.request("/orchestration/runs", {
      method: "POST",
      body: JSON.stringify({ recipe: { name: "n" } }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("bad workspace")
  })

  it("GET /orchestration/runs lists runs", async () => {
    const app = makeApp()
    const res = await app.request("/orchestration/runs")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { runs: OrchestrationRun[] }).runs).toHaveLength(1)
  })

  it("GET /orchestration/runs/:id returns 404 for unknown runs", async () => {
    const app = makeApp()
    expect((await app.request("/orchestration/runs/run_1")).status).toBe(200)
    expect((await app.request("/orchestration/runs/run_nope")).status).toBe(404)
  })

  it("POST cancel maps domain errors to 404/409", async () => {
    const notFound = makeApp({
      cancelRun: async () => {
        throw new RunNotFoundError("run_x")
      },
    })
    expect((await notFound.request("/orchestration/runs/run_x/cancel", { method: "POST" })).status).toBe(404)

    const terminal = makeApp({
      cancelRun: async () => {
        throw new RunNotCancellableError("completed")
      },
    })
    expect((await terminal.request("/orchestration/runs/run_1/cancel", { method: "POST" })).status).toBe(409)

    const ok = makeApp()
    const res = await ok.request("/orchestration/runs/run_1/cancel", { method: "POST" })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
  })

  it("GET events streams a full snapshot first, then live events", async () => {
    let pushEvent: ((e: OrchestratorEvent) => void) | undefined
    const app = makeApp({
      subscribeRun: (_runId, handler) => {
        pushEvent = handler
        return () => {}
      },
    })
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
    const app = makeApp()
    expect((await app.request("/orchestration/runs/run_nope/events")).status).toBe(404)
  })
})

describe("delegate routes", () => {
  it("POST /orchestration/delegate returns the D-2 contract on completion", async () => {
    let seen: unknown
    const app = makeApp(
      {},
      {
        delegate: async (req) => {
          seen = req
          return {
            status: "completed",
            sessionId: "child-1",
            deliverable: "the answer",
            tokens: { input: 10, output: 20 },
            cost: 0.01,
          }
        },
      },
    )
    const res = await app.request("/orchestration/delegate", {
      method: "POST",
      body: JSON.stringify({ agentId: "acp:claude", task: "do it", workspace: "/ws" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: DelegateResult }
    expect(body.result.deliverable).toBe("the answer")
    expect(body.result.sessionId).toBe("child-1")
    expect(seen).toEqual({ agentId: "acp:claude", task: "do it", workspace: "/ws" })
  })

  it("POST /orchestration/delegate maps errors: 400 request, 429 governance, 500 other", async () => {
    expect((await makeApp().request("/orchestration/delegate", { method: "POST", body: "not json{" })).status).toBe(400)

    const invalid = makeApp(
      {},
      {
        delegate: async () => {
          throw new DelegateRequestError("agentId is required")
        },
      },
    )
    expect((await invalid.request("/orchestration/delegate", { method: "POST", body: "{}" })).status).toBe(400)

    const governed = makeApp(
      {},
      {
        delegate: async () => {
          throw new GovernanceError("depth exceeded")
        },
      },
    )
    expect((await governed.request("/orchestration/delegate", { method: "POST", body: "{}" })).status).toBe(429)

    const broken = makeApp(
      {},
      {
        delegate: async () => {
          throw new Error("boom")
        },
      },
    )
    expect((await broken.request("/orchestration/delegate", { method: "POST", body: "{}" })).status).toBe(500)
  })

  it("GET /orchestration/delegates lists records", async () => {
    const res = await makeApp().request("/orchestration/delegates")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { delegates: DelegateRecord[] }
    expect(body.delegates).toHaveLength(1)
    expect(body.delegates[0].id).toBe("dlg_1")
  })

  it("GET /orchestration/delegates/events streams a snapshot first, then live events", async () => {
    let push: ((e: DelegateEvent) => void) | undefined
    const app = makeApp(
      {},
      {
        subscribe: (handler) => {
          push = handler
          return () => {}
        },
      },
    )
    const res = await app.request("/orchestration/delegates/events")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    expect(first).toContain('"type":"delegate.snapshot"')
    expect(first).toContain('"id":"dlg_1"')

    while (!push) await new Promise((resolve) => setTimeout(resolve, 1))
    push({ type: "delegate.updated", properties: { delegate: { ...sampleDelegate(), status: "completed" } } })
    const second = decoder.decode((await reader.read()).value)
    expect(second).toContain('"type":"delegate.updated"')
    await reader.cancel()
  })

  it("GET /orchestration/agents lists delegate targets", async () => {
    const res = await makeApp().request("/orchestration/agents")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { agents: Array<{ id: string }> }
    expect(body.agents[0].id).toBe("opencode:default")
  })
})
