// HTTP layer (:4099): REST control endpoints + per-session SSE stream.

import { Hono } from "hono"
import { cors } from "hono/cors"
import { basicAuth } from "hono/basic-auth"
import { HTTPException } from "hono/http-exception"
import type { MiddlewareHandler } from "hono"
import { streamSSE } from "hono/streaming"
import type { ACPManager } from "./acp-manager.js"

const HEARTBEAT_MS = 15_000

/** Per-install credentials the Tauri host generates and hands to every sidecar. */
export interface SidecarAuth {
  username: string
  password: string
}

/**
 * Basic auth WITHOUT a `WWW-Authenticate` challenge header.
 *
 * hono's `basicAuth` answers 401 with `WWW-Authenticate: Basic`, which tells a
 * browser to run its own credential flow: Chrome holds the fetch open waiting for a
 * native password dialog rather than resolving it (observed in a real browser), and
 * the Tauri WebView would pop a system prompt for a port the user never typed. Every
 * client here is programmatic and attaches the header itself, so a plain 401 is what
 * we want. hono's timing-safe comparison is still doing the work.
 */
function sidecarBasicAuth(auth: SidecarAuth): MiddlewareHandler {
  const check = basicAuth({ username: auth.username, password: auth.password })
  return async (c, next) => {
    try {
      return await check(c, next)
    } catch (err) {
      if (err instanceof HTTPException && err.status === 401) {
        return c.json({ error: "unauthorized" }, 401)
      }
      throw err
    }
  }
}

/**
 * `auth` is required rather than optional so a caller must state its intent.
 * `null` means "no authentication" and is only for unit tests — a loopback port
 * is not a security boundary, any local process can reach it (ADR-028 / 029 §9).
 */
export function createServer(manager: ACPManager, auth: SidecarAuth | null): Hono {
  const app = new Hono()

  app.use(
    "*",
    cors({
      // `http://tauri.localhost` is the Windows production fallback the other two
      // sidecars already allow.
      origin: [
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
        "http://localhost:1420",
      ],
    }),
  )

  // After cors(): hono's cors middleware answers the preflight OPTIONS itself and
  // never calls next(), so the browser's unauthenticated preflight is not rejected.
  // Health is behind auth too — `prepare_port` treats a healthy responder as its own
  // sidecar and reuses it, so answering /acp/health must prove the credential.
  //
  // This covers /orchestration/* as well: index.ts mounts those routes onto this
  // same app, and `app.use("*")` matches by path at request time.
  if (auth) {
    app.use("*", sidecarBasicAuth(auth))
  }

  app.get("/acp/health", (c) =>
    c.json({
      status: "ok",
      agents: manager.listAgents().map((a) => ({ id: a.id, status: a.status })),
    }),
  )

  app.get("/acp/agents", (c) => c.json(manager.listAgents()))

  app.post("/acp/agents/:id/connect", async (c) => {
    try {
      await manager.connect(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502)
    }
  })

  app.post("/acp/agents/:id/disconnect", async (c) => {
    try {
      await manager.disconnect(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: errMsg(err) }, 404)
    }
  })

  app.get("/acp/agents/:id/config", (c) => {
    const config = manager.getAgentConfig(c.req.param("id"))
    return config ? c.json(config) : c.json({ error: "unknown agent" }, 404)
  })

  app.put("/acp/agents/:id", async (c) => {
    const id = c.req.param("id")
    const body = await c.req
      .json<{
        label?: string
        description?: string
        command?: string
        args?: string[]
        env?: Record<string, string>
        knowledgeMcp?: boolean
        orchestratorMcp?: boolean
        thoughtLevel?: string
      }>()
      .catch(() => null)
    if (!body?.label || !body?.command) {
      return c.json({ error: "label and command are required" }, 400)
    }
    manager.saveAgent({
      id,
      label: body.label,
      description: body.description,
      command: body.command,
      args: body.args ?? [],
      env: body.env,
      knowledgeMcp: body.knowledgeMcp ?? false,
      orchestratorMcp: body.orchestratorMcp ?? false,
      thoughtLevel: body.thoughtLevel || undefined,
    })
    return c.json({ ok: true })
  })

  app.delete("/acp/agents/:id", async (c) => {
    try {
      await manager.deleteAgent(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: errMsg(err) }, 404)
    }
  })

  app.post("/acp/session", async (c) => {
    const body = await c.req
      .json<{
        agentId?: string
        cwd?: string
        clientSessionId?: string
        orchestrate?: boolean
        systemPrompt?: string
      }>()
      .catch(() => null)
    if (!body?.agentId || !body?.cwd) {
      return c.json({ error: "agentId and cwd are required" }, 400)
    }
    try {
      const sessionId = await manager.createSession(body.agentId, body.cwd, body.clientSessionId, {
        orchestrate: body.orchestrate,
        systemPrompt: body.systemPrompt,
      })
      return c.json({ sessionId }, 201)
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502)
    }
  })

  // All sessions with their agent bindings — desktop binding hydration (ADR-030).
  app.get("/acp/sessions", (c) => c.json(manager.listSessions()))

  app.get("/acp/session/:id", (c) => {
    const info = manager.getSession(c.req.param("id"))
    return info ? c.json(info) : c.json({ error: "unknown session" }, 404)
  })

  // Persisted shaped history (W4b) in the desktop's render shape.
  app.get("/acp/session/:id/messages", (c) => {
    const messages = manager.getMessages(c.req.param("id"))
    return messages ? c.json({ messages }) : c.json({ error: "unknown session" }, 404)
  })

  // Task-plan snapshot (ADR-038): switch-back hydration for the plan panel.
  // ACP has no SQLite todo store; the manager folds plan.updated into a
  // per-session snapshot. Unknown sessions return an empty plan, not 404 (the
  // panel just shows nothing — matches opencode's "no todos" behaviour).
  app.get("/acp/session/:id/plan", (c) => {
    return c.json({ entries: manager.getPlan(c.req.param("id")) })
  })

  app.delete("/acp/session/:id", (c) => {
    const ok = manager.deleteSession(c.req.param("id"))
    return ok ? c.json({ ok: true }) : c.json({ error: "unknown session" }, 404)
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

  // Permission-dock reply for a suspended ACP request_permission RPC.
  app.post("/acp/session/:id/permission", async (c) => {
    const sessionId = c.req.param("id")
    const body = await c.req
      .json<{ permissionId?: string; reply?: "once" | "always" | "reject" }>()
      .catch(() => null)
    if (!body?.permissionId || !body?.reply || !["once", "always", "reject"].includes(body.reply)) {
      return c.json({ error: "permissionId and reply (once|always|reject) are required" }, 400)
    }
    const ok = manager.replyPermission(sessionId, body.permissionId, body.reply)
    return ok ? c.json({ ok: true }) : c.json({ error: "unknown or already-resolved permission" }, 404)
  })

  app.post("/acp/session/:id/cancel", async (c) => {
    try {
      await manager.cancel(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: errMsg(err) }, 404)
    }
  })

  // Global lifecycle stream: cross-session session.status (busy/idle) only.
  // Per-session message events stay on /acp/session/:id/events; this lets the
  // desktop maintain app-level activeSessionIds (busy markers that survive
  // switching away mid-turn) without subscribing to every session (discussions/022).
  app.get("/acp/global/events", (c) => {
    return streamSSE(c, async (stream) => {
      const unsubscribe = manager.subscribeGlobal((event) => {
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

  // Unknown session ids are allowed on purpose: the desktop subscribes by its
  // own session id before the ACP session exists; events flow once a session
  // is created with that clientSessionId.
  app.get("/acp/session/:id/events", (c) => {
    const sessionId = c.req.param("id")
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
