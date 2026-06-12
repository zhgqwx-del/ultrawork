// Team-session endpoints (017 Team 页). Creation lives in the sidecar because
// only it can reach the hidden-parent workspace (a non-workspace directory the
// desktop's workspace-scoped ApiClient can't address):
//
//   POST: hidden "[team]" parent (lazy, once) → Leader/twin opencode session
//   under the user workspace with parentID = that parent (sidebar exclusion,
//   same mechanism as orchestrator children) → for ACP leaders additionally
//   the ACP session bound to the twin id with orchestrate + systemPrompt.
//
// opencode leaders get their delegate tools from the global orchestrator MCP
// entry, which the DESKTOP silently ensures (write_mcp_config needs Tauri).

import { Hono } from "hono"
import type { Connector } from "@agent/connector"
import { loadTeamSessions, saveTeamSessions, type TeamSessionEntry } from "./team-store.js"

/** The slice of ACPManager the team routes need (structural, for tests). */
export interface TeamACPManager {
  createSession(
    agentId: string,
    cwd: string,
    clientSessionId?: string,
    opts?: { orchestrate?: boolean; systemPrompt?: string },
  ): Promise<string>
  deleteSession(sessionId: string): boolean
}

export interface TeamRouteDeps {
  connectorFor(workspace: string): Connector
  manager: TeamACPManager
  /** Non-workspace dir for the hidden "[team]" parent; unset disables hiding (tests). */
  hiddenParentWorkspace?: string
}

export function teamRoutes(deps: TeamRouteDeps): Hono {
  const app = new Hono()
  const sessions: TeamSessionEntry[] = loadTeamSessions()

  /** One long-lived hidden opencode parent shared by ALL team leaders (sidebar guard). */
  let hiddenParentId: Promise<string> | undefined
  const ensureHiddenParent = (): Promise<string> | undefined => {
    const dir = deps.hiddenParentWorkspace
    if (!dir) return undefined
    if (!hiddenParentId) {
      hiddenParentId = deps
        .connectorFor(dir)
        .createSession({ backend: "opencode", title: "[team]" })
        .then((ref) => ref.id)
      // A failed creation must not poison every later team session.
      hiddenParentId.catch(() => {
        hiddenParentId = undefined
      })
    }
    return hiddenParentId
  }

  app.post("/orchestration/team/sessions", async (c) => {
    const body = await c.req
      .json<{
        workspace?: string
        leaderAgentId?: string
        members?: string[]
        systemPrompt?: string
        title?: string
      }>()
      .catch(() => null)
    if (!body?.workspace || !body?.leaderAgentId) {
      return c.json({ error: "workspace and leaderAgentId are required" }, 400)
    }

    try {
      const parentSessionId = await ensureHiddenParent()?.catch(() => undefined)
      const connector = deps.connectorFor(body.workspace)
      const ref = await connector.createSession({
        backend: "opencode",
        directory: body.workspace,
        parentSessionId,
        title: body.title,
      })

      if (body.leaderAgentId.startsWith("acp:")) {
        const rawId = body.leaderAgentId.slice("acp:".length)
        try {
          await deps.manager.createSession(rawId, body.workspace, ref.id, {
            orchestrate: true,
            systemPrompt: body.systemPrompt,
          })
        } catch (err) {
          // Don't leave a half-created team session behind.
          await connector.deleteSession(ref.id).catch(() => {})
          throw err
        }
      }

      const entry: TeamSessionEntry = {
        id: ref.id,
        workspace: body.workspace,
        leaderAgentId: body.leaderAgentId,
        members: body.members ?? [],
        title: body.title,
        createdAt: Date.now(),
      }
      sessions.push(entry)
      saveTeamSessions(sessions)
      return c.json({ session: entry }, 201)
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502)
    }
  })

  app.get("/orchestration/team/sessions", (c) => {
    const workspace = c.req.query("workspace")
    const filtered = workspace ? sessions.filter((s) => s.workspace === workspace) : sessions
    // Newest first — the history list renders this order directly.
    return c.json({ sessions: [...filtered].sort((a, b) => b.createdAt - a.createdAt) })
  })

  app.delete("/orchestration/team/sessions/:id", async (c) => {
    const id = c.req.param("id")
    const idx = sessions.findIndex((s) => s.id === id)
    if (idx < 0) return c.json({ error: "unknown team session" }, 404)
    const [entry] = sessions.splice(idx, 1)
    saveTeamSessions(sessions)
    // Best-effort cleanup of the underlying conversations; the registry
    // removal alone already hides the session from every list.
    if (entry.leaderAgentId.startsWith("acp:")) deps.manager.deleteSession(id)
    await deps.connectorFor(entry.workspace).deleteSession(id).catch(() => {})
    return c.json({ ok: true })
  })

  return app
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
