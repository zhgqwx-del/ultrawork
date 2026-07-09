// Inbound Basic auth on the ACP sidecar (029 阶段 ④b / ADR-045).
//
// This is the highest-value of the three: /orchestration/delegate spawns agents. It
// previously relied on a single e2e that CI never runs, so a dropped middleware would
// ship green. Also pins that routes mounted LATER (index.ts `app.route(...)`) are
// still behind the middleware — hono matches `app.use("*")` by path at request time.

import { describe, it, expect } from "bun:test"
import { Hono } from "hono"
import { createServer } from "../acp-server.js"
import type { ACPManager } from "../acp-manager.js"

const AUTH = { username: "opencode", password: "s3cret" }
const header = (u: string, p: string) => ({ authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") })
const good = header("opencode", "s3cret")

function manager(): ACPManager {
  return {
    listAgents: () => [],
    on: () => {},
    off: () => {},
  } as unknown as ACPManager
}

const authedApp = () => createServer(manager(), AUTH)

describe("acp-server inbound Basic auth", () => {
  it("rejects a request with no credentials", async () => {
    expect((await authedApp().request("/acp/health")).status).toBe(401)
  })

  it.each([
    ["a wrong password", "opencode", "wrong"],
    ["a wrong username", "mallory", "s3cret"],
  ])("rejects %s", async (_label, u, p) => {
    expect((await authedApp().request("/acp/health", { headers: header(u, p) })).status).toBe(401)
  })

  // The positive direction: without it, `app.use(() => 401)` would satisfy the above.
  it("accepts the correct credentials", async () => {
    const res = await authedApp().request("/acp/health", { headers: good })
    expect(res.status).toBe(200)
  })

  // `/orchestration/*` is mounted onto this app in index.ts, AFTER createServer ran.
  // If `app.use("*")` did not match by path at request time, delegation would be open
  // to every local process.
  it("protects routes mounted after the middleware (/orchestration/*)", async () => {
    const app = authedApp()
    const later = new Hono()
    later.post("/orchestration/delegate", (c) => c.json({ ok: true }))
    later.get("/orchestration/runs/:id/events", (c) => c.text("stream"))
    app.route("/", later)

    expect((await app.request("/orchestration/delegate", { method: "POST" })).status).toBe(401)
    expect((await app.request("/orchestration/runs/r1/events")).status).toBe(401)

    const ok = await app.request("/orchestration/delegate", { method: "POST", headers: good })
    expect(ok.status).toBe(200)
  })

  it("lets an unauthenticated CORS preflight through", async () => {
    const res = await authedApp().request("/acp/health", {
      method: "OPTIONS",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    })
    expect(res.status).not.toBe(401)
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost")
  })

  it("serves everything unauthenticated when auth is null (unit-test mode)", async () => {
    expect((await createServer(manager(), null).request("/acp/health")).status).toBe(200)
  })
})
