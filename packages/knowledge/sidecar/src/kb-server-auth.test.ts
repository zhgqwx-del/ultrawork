// Inbound Basic auth on the knowledge sidecar (029 阶段 ④b / ADR-045).
//
// The gateway's identical middleware has a CI suite; this one previously relied on a
// single e2e that CI never runs, so a dropped `app.use(basicAuth(...))` would ship
// green. A loopback port is not a boundary — any local process can reach /kb/*.

import { describe, it, expect } from "bun:test"
import { createApp, type AppDeps } from "./kb-server"

const AUTH = { username: "opencode", password: "s3cret" }
const header = (u: string, p: string) => ({ authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") })

function deps(): AppDeps {
  return {
    indexer: {
      addProgressListener: () => {},
      listFolders: () => [],
      getStatus: () => undefined,
    } as unknown as AppDeps["indexer"],
    search: () => [],
    store: { listKnowledgeSources: () => [] } as unknown as AppDeps["store"],
  }
}

const authedApp = () => createApp(deps(), AUTH)

describe("kb-server inbound Basic auth", () => {
  it("rejects a request with no credentials", async () => {
    expect((await authedApp().request("/kb/health")).status).toBe(401)
  })

  it("rejects a wrong password", async () => {
    const res = await authedApp().request("/kb/health", { headers: header("opencode", "wrong") })
    expect(res.status).toBe(401)
  })

  it("rejects a wrong username", async () => {
    const res = await authedApp().request("/kb/health", { headers: header("mallory", "s3cret") })
    expect(res.status).toBe(401)
  })

  // The positive direction: without it, `app.use(() => 401)` would satisfy the above.
  it("accepts the correct credentials", async () => {
    const res = await authedApp().request("/kb/health", { headers: header("opencode", "s3cret") })
    expect(res.status).toBe(200)
  })

  it("protects data routes, not just health", async () => {
    expect((await authedApp().request("/kb/sources")).status).toBe(401)
    const ok = await authedApp().request("/kb/sources", { headers: header("opencode", "s3cret") })
    expect(ok.status).toBe(200)
  })

  // hono's cors() answers the preflight itself and never calls next(); a 401 here would
  // break every cross-origin request from the Tauri webview before it is even sent.
  it("lets an unauthenticated CORS preflight through", async () => {
    const res = await authedApp().request("/kb/sources", {
      method: "OPTIONS",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    })
    expect(res.status).not.toBe(401)
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost")
  })

  // A `WWW-Authenticate` challenge makes a browser run its own credential flow: Chrome
  // holds the fetch open waiting for a native password dialog (observed in a real
  // browser). Every client here attaches the header itself.
  it("answers 401 without a WWW-Authenticate challenge", async () => {
    const res = await authedApp().request("/kb/health")
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBeNull()
  })

  it("serves everything unauthenticated when auth is null (unit-test mode)", async () => {
    expect((await createApp(deps(), null).request("/kb/health")).status).toBe(200)
  })
})
