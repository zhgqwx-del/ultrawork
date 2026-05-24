import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import type { ACPManager } from "./acp-manager"

export function createApp(manager: ACPManager): Hono {
  const app = new Hono()

  // CORS — same as other sidecars
  app.use(
    "/*",
    cors({
      origin: [
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
        "http://localhost:1420",
      ],
    }),
  )

  // --- Health ---

  app.get("/acp/health", (c) => c.json({ status: "ok" }))

  // --- Agents ---

  app.get("/acp/agents", (c) => {
    return c.json(manager.getAgents())
  })

  app.get("/acp/agents/:id", (c) => {
    const agent = manager.getAgent(c.req.param("id"))
    if (!agent) return c.json({ error: "Agent not found" }, 404)
    return c.json(agent)
  })

  app.post("/acp/agents/:id/connect", async (c) => {
    try {
      await manager.connect(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connect failed"
      return c.json({ error: msg }, 500)
    }
  })

  app.post("/acp/agents/:id/disconnect", async (c) => {
    try {
      await manager.disconnect(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Disconnect failed"
      return c.json({ error: msg }, 500)
    }
  })

  // --- Sessions ---

  app.post("/acp/session", async (c) => {
    try {
      const body = await c.req.json<{ agentId: string; cwd: string }>()
      if (!body.agentId || !body.cwd) {
        return c.json({ error: "agentId and cwd are required" }, 400)
      }
      const sessionId = await manager.createSession(body.agentId, body.cwd)
      return c.json({ sessionId }, 201)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create session failed"
      return c.json({ error: msg }, 500)
    }
  })

  app.post("/acp/session/:id/prompt", async (c) => {
    try {
      const body = await c.req.json<{ text: string }>()
      if (!body.text) {
        return c.json({ error: "text is required" }, 400)
      }
      const result = await manager.prompt(c.req.param("id"), body.text)
      return c.json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Prompt failed"
      return c.json({ error: msg }, 500)
    }
  })

  app.post("/acp/session/:id/cancel", async (c) => {
    try {
      await manager.cancel(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Cancel failed"
      return c.json({ error: msg }, 500)
    }
  })

  // --- SSE event stream for a session ---

  app.get("/acp/session/:id/events", (c) => {
    const sessionId = c.req.param("id")
    const conn = manager.getConnectionForSession(sessionId)
    if (!conn) {
      return c.json({ error: "Session not found" }, 404)
    }

    return streamSSE(c, async (stream) => {
      // Send initial connected event
      await stream.writeSSE({ data: JSON.stringify({ type: "acp.connected", properties: { sessionId } }) })

      // Subscribe to session events
      const onEvent = async (event: { type: string; properties: Record<string, unknown> }) => {
        try {
          await stream.writeSSE({ data: JSON.stringify(event) })
        } catch {
          // Stream closed
        }
      }
      conn.onSessionEvent(sessionId, onEvent)

      // Keep connection alive with heartbeat
      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: "heartbeat", properties: {} }) })
        } catch {
          clearInterval(heartbeat)
        }
      }, 15000)

      // Wait until the stream is closed by client
      await stream.sleep(Number.MAX_SAFE_INTEGER)

      // Cleanup
      clearInterval(heartbeat)
      conn.offSessionEvent(sessionId)
    })
  })

  return app
}
