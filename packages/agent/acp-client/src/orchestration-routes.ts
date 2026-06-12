// HTTP surface for the in-sidecar orchestrator (mounted on the same Hono app
// as /acp/* so CORS carries over). Mirrors the /acp/* endpoint style.

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import {
  RecipeValidationError,
  RunNotCancellableError,
  RunNotFoundError,
  type Orchestrator,
  type PipelineRecipe,
} from "@agent/orchestrator"

const HEARTBEAT_MS = 15_000

export function orchestrationRoutes(orchestrator: Orchestrator): Hono {
  const app = new Hono()

  app.post("/orchestration/runs", async (c) => {
    const body = await c.req.json<{ recipe?: PipelineRecipe }>().catch(() => null)
    if (!body?.recipe) return c.json({ error: "recipe is required" }, 400)
    try {
      const run = await orchestrator.createRun(body.recipe)
      return c.json({ run }, 201)
    } catch (err) {
      if (err instanceof RecipeValidationError) return c.json({ error: err.message }, 400)
      return c.json({ error: errMsg(err) }, 500)
    }
  })

  app.get("/orchestration/runs", (c) =>
    c.json({ runs: orchestrator.listRuns() }),
  )

  app.get("/orchestration/runs/:id", (c) => {
    const run = orchestrator.getRun(c.req.param("id"))
    return run ? c.json({ run }) : c.json({ error: "unknown run" }, 404)
  })

  app.post("/orchestration/runs/:id/cancel", async (c) => {
    try {
      await orchestrator.cancelRun(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof RunNotFoundError) return c.json({ error: err.message }, 404)
      if (err instanceof RunNotCancellableError) return c.json({ error: err.message }, 409)
      return c.json({ error: errMsg(err) }, 500)
    }
  })

  // Per-run event stream. First frame is a full run.updated snapshot — the
  // client can never miss events emitted between fetch and subscribe.
  app.get("/orchestration/runs/:id/events", (c) => {
    const runId = c.req.param("id")
    const run = orchestrator.getRun(runId)
    if (!run) return c.json({ error: "unknown run" }, 404)
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: "run.updated", properties: { run } }) })
      const unsubscribe = orchestrator.subscribeRun(runId, (event) => {
        void stream.writeSSE({ data: JSON.stringify(event) })
      })
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ data: JSON.stringify({ type: "heartbeat", properties: {} }) })
      }, HEARTBEAT_MS)
      stream.onAbort(() => {
        clearInterval(heartbeat)
        unsubscribe()
      })
      await new Promise<void>((resolve) => stream.onAbort(resolve))
    })
  })

  return app
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
