// /orchestration/team/* route shapes against stubbed connector + manager.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Connector } from "@agent/connector"
import { teamRoutes, type TeamACPManager } from "../team-routes.js"
import { loadTeamSessions } from "../team-store.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "team-store-"))
  process.env.TEAM_SESSIONS_FILE = join(tmpDir, "team-sessions.json")
})

afterEach(() => {
  delete process.env.TEAM_SESSIONS_FILE
  rmSync(tmpDir, { recursive: true, force: true })
})

interface StubCalls {
  created: Array<{ workspace: string; opts: Record<string, unknown> }>
  deleted: string[]
  acpCreated: Array<{ agentId: string; cwd: string; clientSessionId?: string; opts?: Record<string, unknown> }>
  acpDeleted: string[]
}

function makeDeps(behavior?: {
  failAcp?: boolean
  failHiddenParent?: boolean
}): { deps: Parameters<typeof teamRoutes>[0]; calls: StubCalls } {
  const calls: StubCalls = { created: [], deleted: [], acpCreated: [], acpDeleted: [] }
  let seq = 0
  const connectorFor = (workspace: string) =>
    ({
      createSession: async (opts: Record<string, unknown>) => {
        if (workspace === "/hidden" && behavior?.failHiddenParent) throw new Error("hidden boom")
        calls.created.push({ workspace, opts })
        return { id: workspace === "/hidden" ? "hidden_parent" : `ses_${seq++}`, backend: "opencode", directory: workspace }
      },
      deleteSession: async (id: string) => {
        calls.deleted.push(id)
      },
    }) as unknown as Connector
  const manager: TeamACPManager = {
    createSession: async (agentId, cwd, clientSessionId, opts) => {
      if (behavior?.failAcp) throw new Error("acp boom")
      calls.acpCreated.push({ agentId, cwd, clientSessionId, opts })
      return clientSessionId ?? "acp_raw"
    },
    deleteSession: (id) => {
      calls.acpDeleted.push(id)
      return true
    },
  }
  return { deps: { connectorFor, manager, hiddenParentWorkspace: "/hidden" }, calls }
}

describe("POST /orchestration/team/sessions", () => {
  it("creates an opencode leader under the hidden [team] parent and persists the entry", async () => {
    const { deps, calls } = makeDeps()
    const app = teamRoutes(deps)
    const res = await app.request("/orchestration/team/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspace: "/ws",
        leaderAgentId: "opencode:default",
        members: ["opencode:default", "acp:claude"],
      }),
    })
    expect(res.status).toBe(201)
    const { session } = (await res.json()) as { session: { id: string; members: string[] } }
    expect(session.members).toEqual(["opencode:default", "acp:claude"])

    // Hidden parent first, then the leader bound to it.
    expect(calls.created[0]).toMatchObject({ workspace: "/hidden", opts: { title: "[team]" } })
    expect(calls.created[1]).toMatchObject({
      workspace: "/ws",
      opts: { parentSessionId: "hidden_parent", directory: "/ws" },
    })
    // No ACP session for an opencode leader.
    expect(calls.acpCreated).toHaveLength(0)
    // Registry persisted server-side.
    expect(loadTeamSessions().map((s) => s.id)).toEqual([session.id])
  })

  it("creates the ACP leader session bound to the twin with orchestrate + systemPrompt", async () => {
    const { deps, calls } = makeDeps()
    const app = teamRoutes(deps)
    const res = await app.request("/orchestration/team/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspace: "/ws",
        leaderAgentId: "acp:claude",
        members: ["acp:claude"],
        systemPrompt: "LEADER RULES",
      }),
    })
    expect(res.status).toBe(201)
    const { session } = (await res.json()) as { session: { id: string } }
    expect(calls.acpCreated).toEqual([
      {
        agentId: "claude",
        cwd: "/ws",
        clientSessionId: session.id,
        opts: { orchestrate: true, systemPrompt: "LEADER RULES" },
      },
    ])
  })

  it("rolls back the twin when the ACP leader creation fails", async () => {
    const { deps, calls } = makeDeps({ failAcp: true })
    const app = teamRoutes(deps)
    const res = await app.request("/orchestration/team/sessions", {
      method: "POST",
      body: JSON.stringify({ workspace: "/ws", leaderAgentId: "acp:claude" }),
    })
    expect(res.status).toBe(502)
    expect(calls.deleted).toHaveLength(1)
    expect(loadTeamSessions()).toHaveLength(0)
  })

  it("hidden-parent failure degrades to a parentless leader (and does not poison later calls)", async () => {
    const { deps, calls } = makeDeps({ failHiddenParent: true })
    const app = teamRoutes(deps)
    const res = await app.request("/orchestration/team/sessions", {
      method: "POST",
      body: JSON.stringify({ workspace: "/ws", leaderAgentId: "opencode:default" }),
    })
    expect(res.status).toBe(201)
    expect(calls.created[0].opts.parentSessionId).toBeUndefined()
  })

  it("validates required fields", async () => {
    const { deps } = makeDeps()
    const app = teamRoutes(deps)
    const res = await app.request("/orchestration/team/sessions", {
      method: "POST",
      body: JSON.stringify({ workspace: "/ws" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("GET /orchestration/team/sessions", () => {
  it("filters by workspace, newest first", async () => {
    const { deps } = makeDeps()
    const app = teamRoutes(deps)
    for (const ws of ["/a", "/b", "/a"]) {
      await app.request("/orchestration/team/sessions", {
        method: "POST",
        body: JSON.stringify({ workspace: ws, leaderAgentId: "opencode:default" }),
      })
    }
    const res = await app.request("/orchestration/team/sessions?workspace=/a")
    const { sessions } = (await res.json()) as { sessions: Array<{ workspace: string; createdAt: number }> }
    expect(sessions).toHaveLength(2)
    expect(sessions.every((s) => s.workspace === "/a")).toBe(true)
    expect(sessions[0].createdAt).toBeGreaterThanOrEqual(sessions[1].createdAt)
  })

  it("a fresh route instance reads the registry back from disk", async () => {
    const { deps } = makeDeps()
    const app = teamRoutes(deps)
    await app.request("/orchestration/team/sessions", {
      method: "POST",
      body: JSON.stringify({ workspace: "/ws", leaderAgentId: "opencode:default" }),
    })
    // Sidecar restart = new route instance over the same file.
    const { deps: deps2 } = makeDeps()
    const app2 = teamRoutes(deps2)
    const res = await app2.request("/orchestration/team/sessions")
    const { sessions } = (await res.json()) as { sessions: unknown[] }
    expect(sessions).toHaveLength(1)
  })
})

describe("DELETE /orchestration/team/sessions/:id", () => {
  it("removes the entry and best-effort deletes the conversations", async () => {
    const { deps, calls } = makeDeps()
    const app = teamRoutes(deps)
    const created = await app.request("/orchestration/team/sessions", {
      method: "POST",
      body: JSON.stringify({ workspace: "/ws", leaderAgentId: "acp:claude" }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    const res = await app.request(`/orchestration/team/sessions/${session.id}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(calls.acpDeleted).toEqual([session.id])
    expect(calls.deleted).toContain(session.id)
    expect(loadTeamSessions()).toHaveLength(0)
  })

  it("404s on unknown ids", async () => {
    const { deps } = makeDeps()
    const app = teamRoutes(deps)
    const res = await app.request("/orchestration/team/sessions/nope", { method: "DELETE" })
    expect(res.status).toBe(404)
  })
})
