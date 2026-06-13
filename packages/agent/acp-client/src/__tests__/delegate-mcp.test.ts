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
    expect(shimDepsFromEnv({ ACP_CLIENT_PORT: "5001" } as NodeJS.ProcessEnv).baseUrl).toBe("http://127.0.0.1:5001")
    expect(shimDepsFromEnv({} as NodeJS.ProcessEnv).baseUrl).toBe("http://127.0.0.1:4099")
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
    await new Promise((resolve) => setTimeout(resolve, 25))
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
})
