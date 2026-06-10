// HTTP layer (:4099): REST control endpoints + per-session SSE stream.

import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import type { ACPManager } from "./acp-manager.js"

const HEARTBEAT_MS = 15_000

export function createServer(manager: ACPManager): Hono {
  const app = new Hono()

  app.use(
    "*",
    cors({
      origin: ["tauri://localhost", "https://tauri.localhost", "http://localhost:1420"],
    }),
  )

  app.get("/acp/health", (c) => c.json({ status: "ok" }))

  app.get("/acp/agents", (c) => c.json(manager.listAgents()))

  app.post("/acp/agents/:id/connect", async (c) => {
    try {
      await manager.connect(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502)
    }
  })

  app.post("/acp/agents/:id/disconnect", (c) => {
    try {
      manager.disconnect(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: errMsg(err) }, 404)
    }
  })

  app.post("/acp/session", async (c) => {
    const body = await c.req.json<{ agentId?: string; cwd?: string }>().catch(() => null)
    if (!body?.agentId || !body?.cwd) {
      return c.json({ error: "agentId and cwd are required" }, 400)
    }
    try {
      const sessionId = await manager.createSession(body.agentId, body.cwd)
      return c.json({ sessionId }, 201)
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502)
    }
  })

  app.post("/acp/session/:id/prompt", async (c) => {
    const sessionId = c.req.param("id")
    const body = await c.req.json<{ text?: string }>().catch(() => null)
    if (!body?.text) return c.json({ error: "text is required" }, 400)
    if (!manager.hasSession(sessionId)) return c.json({ error: "unknown session" }, 404)
    try {
      const stopReason = await manager.prompt(sessionId, body.text)
      return c.json({ stopReason })
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502)
    }
  })

  app.post("/acp/session/:id/cancel", async (c) => {
    try {
      await manager.cancel(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: errMsg(err) }, 404)
    }
  })

  app.get("/acp/session/:id/events", (c) => {
    const sessionId = c.req.param("id")
    if (!manager.hasSession(sessionId)) return c.json({ error: "unknown session" }, 404)
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({ type: "acp.connected", properties: { sessionId } }),
      })
      const unsubscribe = manager.subscribe(sessionId, (event) => {
        void stream.writeSSE({ data: JSON.stringify(event) })
      })
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ data: JSON.stringify({ type: "heartbeat", properties: {} }) })
      }, HEARTBEAT_MS)
      stream.onAbort(() => {
        clearInterval(heartbeat)
        unsubscribe()
      })
      // Keep the stream open until the client disconnects.
      await new Promise<void>((resolve) => stream.onAbort(resolve))
    })
  })

  return app
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
