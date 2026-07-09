// delegate-mcp shim core: HTTP forwarding + contract/error mapping (mock fetch).

import { describe, it, expect } from "bun:test"
import { callDelegate, callListAgents, shimDepsFromEnv, type FetchLike, type ShimDeps } from "../delegate-mcp.js"
import { delegateShimCommand } from "../acp-connection.js"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function deps(fetchImpl: FetchLike, extra: Partial<ShimDeps> = {}): ShimDeps {
  return { baseUrl: "http://127.0.0.1:4099", fetchImpl, ...extra }
}

describe("delegate-mcp shim", () => {
  it("resolves the ACP_CLIENT_PORT env into the base URL", () => {
    const noRegistry = () => {
      throw new Error("ENOENT")
    }
    expect(shimDepsFromEnv({ ACP_CLIENT_PORT: "5001" } as NodeJS.ProcessEnv, noRegistry).baseUrl).toBe("http://127.0.0.1:5001")
    expect(shimDepsFromEnv({} as NodeJS.ProcessEnv, noRegistry).baseUrl).toBe("http://127.0.0.1:4099")
  })

  // opencode spawns this shim without ACP_CLIENT_PORT — it cannot know the ACP port
  // at its own launch (the ACP sidecar starts later and may still move). The runtime
  // registry is the cycle-breaker. See discussions/029 §4.1 (d).
  describe("ACP port resolution without env", () => {
    const registry = (body: string) => () => body

    it("reads the port from ~/.ultrawork/run/ports.json", () => {
      const json = JSON.stringify({ acp: { port: 51237, pid: 42 } })
      expect(shimDepsFromEnv({} as NodeJS.ProcessEnv, registry(json)).baseUrl).toBe("http://127.0.0.1:51237")
    })

    it("prefers the env over the registry when both are present", () => {
      const json = JSON.stringify({ acp: { port: 51237 } })
      const env = { ACP_CLIENT_PORT: "5001" } as NodeJS.ProcessEnv
      expect(shimDepsFromEnv(env, registry(json)).baseUrl).toBe("http://127.0.0.1:5001")
    })

    it.each([
      ["a missing file", () => { throw new Error("ENOENT") }],
      ["invalid JSON", registry("not json{{")],
      ["no acp entry", registry(JSON.stringify({ opencode: { port: 4096 } }))],
      ["a non-numeric port", registry(JSON.stringify({ acp: { port: "51237" } }))],
      ["an out-of-range port", registry(JSON.stringify({ acp: { port: 0 } }))],
    ])("falls back to 4099 on %s", (_label, readFile) => {
      expect(shimDepsFromEnv({} as NodeJS.ProcessEnv, readFile as (p: string) => string).baseUrl).toBe(
        "http://127.0.0.1:4099",
      )
    })
  })

  it("forwards the request and passes the contract JSON through", async () => {
    let captured: { url: string; body: any } | undefined
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) }
      return jsonResponse({
        result: { status: "completed", sessionId: "child-1", deliverable: "done", tokens: { input: 1, output: 2 } },
      })
    }) as unknown as FetchLike

    const result = await callDelegate(deps(fetchImpl), {
      agentId: "acp:claude",
      task: "do it",
      cwd: "/abs/ws",
      model: "openai/gpt",
      timeoutMs: 1234,
    })

    expect(captured!.url).toBe("http://127.0.0.1:4099/orchestration/delegate")
    expect(captured!.body).toEqual({
      agentId: "acp:claude",
      task: "do it",
      workspace: "/abs/ws",
      model: "openai/gpt",
      timeoutMs: 1234,
    })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "completed", deliverable: "done" })
  })

  it("tags the request with ownerSessionId — from opts (opencode _meta) or env (ACP) (discussions/022)", async () => {
    const capture = () => {
      let body: any
      const fetchImpl = (async (_u: any, init: any) => {
        body = JSON.parse(init.body)
        return jsonResponse({ result: { status: "completed", sessionId: "c" } })
      }) as unknown as FetchLike
      return { fetchImpl, get: () => body }
    }

    // opencode: forwarded via opts.ownerSessionId (MCP _meta).
    const a = capture()
    await callDelegate(deps(a.fetchImpl), { agentId: "x", task: "t", cwd: "/ws" }, { ownerSessionId: "ses_leader_oc" })
    expect(a.get().ownerSessionId).toBe("ses_leader_oc")

    // ACP: forwarded via the per-session env var.
    const b = capture()
    await callDelegate(deps(b.fetchImpl), { agentId: "x", task: "t", cwd: "/ws" }, { env: { ULTRAWORK_DELEGATE_SESSION: "ses_leader_acp" } as NodeJS.ProcessEnv })
    expect(b.get().ownerSessionId).toBe("ses_leader_acp")

    // Absent → omitted (workspace-scope fallback in the dock). Pass an explicit
    // empty env so a stray ULTRAWORK_DELEGATE_SESSION in the real environment
    // can't make this flaky.
    const c = capture()
    await callDelegate(deps(c.fetchImpl), { agentId: "x", task: "t", cwd: "/ws" }, { env: {} as NodeJS.ProcessEnv })
    expect("ownerSessionId" in c.get()).toBe(false)
  })

  it("falls back to ULTRAWORK_DELEGATE_CWD and errors when no cwd at all", async () => {
    let captured: any
    const fetchImpl = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return jsonResponse({ result: { status: "completed", sessionId: "s" } })
    }) as unknown as FetchLike

    await callDelegate(
      deps(fetchImpl),
      { agentId: "a", task: "t" },
      { env: { ULTRAWORK_DELEGATE_CWD: "/from/env" } as NodeJS.ProcessEnv },
    )
    expect(captured.workspace).toBe("/from/env")

    const missing = await callDelegate(deps(fetchImpl), { agentId: "a", task: "t" }, { env: {} as NodeJS.ProcessEnv })
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toContain("cwd")
  })

  it("marks non-completed statuses as tool errors but still returns the contract", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ result: { status: "timeout", sessionId: "s1", error: "turn timed out" } })) as unknown as FetchLike
    const result = await callDelegate(deps(fetchImpl), { agentId: "a", task: "t", cwd: "/ws" })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "timeout", error: "turn timed out" })
  })

  it("maps HTTP errors and unreachable sidecar to tool errors", async () => {
    const httpError = (async () => jsonResponse({ error: "agentId is required" }, 400)) as unknown as FetchLike
    const bad = await callDelegate(deps(httpError), { agentId: "", task: "t", cwd: "/ws" })
    expect(bad.isError).toBe(true)
    expect(bad.content[0].text).toContain("agentId is required")

    const down = (async () => {
      throw new Error("connect ECONNREFUSED")
    }) as unknown as FetchLike
    const unreachable = await callDelegate(deps(down), { agentId: "a", task: "t", cwd: "/ws" })
    expect(unreachable.isError).toBe(true)
    expect(unreachable.content[0].text).toContain("unreachable")
  })

  it("fires the keepalive while the HTTP call is pending and stops after", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fetchImpl = (async () => {
      await gate
      return jsonResponse({ result: { status: "completed", sessionId: "s" } })
    }) as unknown as FetchLike

    let ticks = 0
    const pending = callDelegate(deps(fetchImpl, { keepaliveMs: 5 }), { agentId: "a", task: "t", cwd: "/ws" }, {
      onKeepalive: () => {
        ticks++
      },
    })
    // Windows timer granularity is ~15ms, so a 5ms keepalive fires far less often
    // than on Linux/macOS — widen the window so ≥2 ticks is reliable everywhere.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(ticks).toBeGreaterThanOrEqual(2)
    release()
    await pending
    const after = ticks
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ticks).toBe(after)
  })

  it("list_agents passes the agent list through and maps failures", async () => {
    const ok = (async () => jsonResponse({ agents: [{ id: "opencode:default", name: "OpenCode" }] })) as unknown as FetchLike
    const result = await callListAgents(deps(ok))
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text)[0].id).toBe("opencode:default")

    const down = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as FetchLike
    expect((await callListAgents(deps(down))).isError).toBe(true)
  })

  it("list_agents threads cwd as ?workspace= so the sidecar scopes to Team members (018)", async () => {
    let calledUrl = ""
    const capture = (async (url: string | URL) => {
      calledUrl = String(url)
      return jsonResponse({ agents: [] })
    }) as unknown as FetchLike
    await callListAgents(deps(capture), "/team ws")
    expect(calledUrl).toContain("/orchestration/agents?workspace=%2Fteam%20ws")
    // No cwd → unscoped global list.
    await callListAgents(deps(capture))
    expect(calledUrl.endsWith("/orchestration/agents")).toBe(true)
  })
})

describe("delegateShimCommand", () => {
  it("uses the compiled binary's own path", () => {
    expect(delegateShimCommand("/Applications/Ultrawork.app/Contents/MacOS/acp-client")).toBe(
      "/Applications/Ultrawork.app/Contents/MacOS/acp-client",
    )
  })

  it("rejects a bun runtime path (manual `bun src/index.ts`) when resolving the shim", () => {
    // The fallback checks ~/.ultrawork/sidecars/acp-client; on dev machines it
    // may exist, so only assert the bun path itself is never returned.
    expect(delegateShimCommand("/Users/x/.bun/bin/bun")).not.toBe("/Users/x/.bun/bin/bun")
  })
  // The ACP sidecar requires Basic auth (029 ④b). The shim inherits the credential
  // from whichever process spawned it — the ACP sidecar, or opencode.
  describe("auth header", () => {
    const noRegistry = () => { throw new Error("ENOENT") }

    it("builds a Basic header from the inherited credential", () => {
      const env = { ULTRAWORK_SIDECAR_PASSWORD: "s3cret" } as NodeJS.ProcessEnv
      const deps = shimDepsFromEnv(env, noRegistry)
      expect(deps.authHeader).toBe("Basic " + Buffer.from("opencode:s3cret").toString("base64"))
    })

    it("honours a non-default username", () => {
      const env = { ULTRAWORK_SIDECAR_PASSWORD: "s3cret", ULTRAWORK_SIDECAR_USERNAME: "alice" } as NodeJS.ProcessEnv
      expect(shimDepsFromEnv(env, noRegistry).authHeader).toBe("Basic " + Buffer.from("alice:s3cret").toString("base64"))
    })

    it("sends no header when no credential was inherited", () => {
      expect(shimDepsFromEnv({} as NodeJS.ProcessEnv, noRegistry).authHeader).toBeUndefined()
    })

    it("attaches the header to a delegate call", async () => {
      let captured: Record<string, string> | undefined
      const fetchImpl = (async (_url: any, init: any) => {
        captured = init.headers
        return jsonResponse({ result: { status: "completed", sessionId: "s", deliverable: "d", tokens: {} } })
      }) as unknown as FetchLike
      await callDelegate({ baseUrl: "http://127.0.0.1:4099", authHeader: "Basic abc", fetchImpl }, {
        agentId: "acp:claude", task: "t", cwd: "/w",
      })
      expect(captured?.Authorization).toBe("Basic abc")
    })

    it("attaches the header to a list_agents call", async () => {
      let captured: Record<string, string> | undefined
      const fetchImpl = (async (_url: any, init: any) => {
        captured = init?.headers
        return jsonResponse({ agents: [] })
      }) as unknown as FetchLike
      await callListAgents({ baseUrl: "http://127.0.0.1:4099", authHeader: "Basic abc", fetchImpl })
      expect(captured?.Authorization).toBe("Basic abc")
    })

    // The negative direction: a shim that always sent some header would pass the above.
    it("omits Authorization entirely when there is no credential", async () => {
      let captured: Record<string, string> | undefined
      const fetchImpl = (async (_url: any, init: any) => {
        captured = init?.headers
        return jsonResponse({ agents: [] })
      }) as unknown as FetchLike
      await callListAgents({ baseUrl: "http://127.0.0.1:4099", fetchImpl })
      expect(captured?.Authorization).toBeUndefined()
    })
  })
})
