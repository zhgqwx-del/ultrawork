// `acp-client delegate-mcp` — stdio MCP shim exposing the orchestrator's
// delegate primitive to a MAIN agent session (ADR-031 ②, D-1 agent-driven).
//
// The shim is spawned by the agent runtime (claude adapter via session/new
// mcpServers, opencode via the opencode.json mcp entry) and forwards tool
// calls over HTTP to the ACP sidecar (:4099) where the orchestrator lives.
// Blocking by design: the delegate tool call resolves with the D-2 contract
// { deliverable, sessionId, tokens, cost }. While the HTTP call is pending we
// send MCP progress notifications every KEEPALIVE_MS — both opencode
// (resetTimeoutOnProgress: true) and Claude Code reset their tool timeout on
// progress, so a long child turn never trips the host's MCP timeout.
//
// stdout belongs to the MCP protocol — log via console.error ONLY.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const KEEPALIVE_MS = 10_000

/** Loose fetch signature so tests can stub it without DOM lib gymnastics. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ShimDeps {
  baseUrl: string
  /** `Authorization: Basic ...`, absent when running without a host credential. */
  authHeader?: string
  fetchImpl?: FetchLike
  keepaliveMs?: number
}

/** Merge the shim's auth header (if any) into a request's headers. */
function withAuth(deps: ShimDeps, headers: Record<string, string> = {}): Record<string, string> {
  return deps.authHeader ? { ...headers, Authorization: deps.authHeader } : headers
}

/**
 * Read the ACP sidecar's port from the Tauri host's runtime registry.
 *
 * Needed because this shim has two very different parents. When the ACP sidecar
 * spawns it, it inherits `ACP_CLIENT_PORT` directly. When *opencode* spawns it
 * (the `orchestrator` MCP entry), there is no such env: opencode cannot be told
 * the ACP port at its own launch, because the ACP sidecar starts afterwards and
 * may still move to a different port. The registry is written after each sidecar
 * is healthy, so by the time a shim runs it holds the truth.
 *
 * Deliberately not read from opencode.json: that file is persisted and would go
 * stale across launches (discussions/029 §4.1 d).
 */
export function acpPortFromPortsRegistry(readFile: (p: string) => string): number | undefined {
  try {
    const home = homedir()
    if (!home) return undefined
    const parsed = JSON.parse(readFile(join(home, ".ultrawork", "run", "ports.json")))
    const port = parsed?.acp?.port
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : undefined
  } catch {
    // No registry (standalone run, host not started yet) — fall through.
    return undefined
  }
}

export function shimDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): ShimDeps {
  // Env wins: the ACP sidecar knows its own port for certain.
  const fromEnv = env.ACP_CLIENT_PORT ? Number(env.ACP_CLIENT_PORT) : undefined
  const port = fromEnv ?? acpPortFromPortsRegistry(readFile) ?? 4099

  // The ACP sidecar requires Basic auth. Whichever process spawned this shim — the
  // ACP sidecar itself or opencode — was given the credential by the Tauri host and
  // we inherit it. Absent (standalone run), send nothing and let the server 401.
  const password = env.ULTRAWORK_SIDECAR_PASSWORD
  const username = env.ULTRAWORK_SIDECAR_USERNAME ?? "opencode"
  const authHeader = password
    ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
    : undefined

  return { baseUrl: `http://127.0.0.1:${port}`, authHeader }
}

export interface ToolResultShape {
  [key: string]: unknown
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

function textResult(text: string, isError = false): ToolResultShape {
  return { content: [{ type: "text", text }], isError: isError || undefined }
}

export interface DelegateToolInput {
  agentId: string
  task: string
  cwd?: string
  model?: string
  timeoutMs?: number
}

/**
 * Core of the `delegate` tool, exported for tests. `onKeepalive` fires every
 * keepaliveMs while the HTTP call is pending (wired to a progress
 * notification by the server registration).
 */
export async function callDelegate(
  deps: ShimDeps,
  input: DelegateToolInput,
  opts: { signal?: AbortSignal; onKeepalive?: () => void; env?: NodeJS.ProcessEnv; ownerSessionId?: string } = {},
): Promise<ToolResultShape> {
  const env = opts.env ?? process.env
  const workspace = input.cwd ?? env.ULTRAWORK_DELEGATE_CWD
  // The leader session that issued this delegate, for per-session DelegateDock
  // scoping (discussions/022): ACP injects it as a per-session env var; opencode
  // passes it through MCP `_meta` (opts.ownerSessionId). Absent → workspace scope.
  const ownerSessionId = opts.ownerSessionId ?? env.ULTRAWORK_DELEGATE_SESSION
  if (!workspace) {
    return textResult(
      "No workspace: pass `cwd` (absolute project root the sub-agent should work in).",
      true,
    )
  }

  const doFetch = deps.fetchImpl ?? fetch
  const keepalive = opts.onKeepalive
    ? setInterval(opts.onKeepalive, deps.keepaliveMs ?? KEEPALIVE_MS)
    : undefined
  try {
    const response = await doFetch(`${deps.baseUrl}/orchestration/delegate`, {
      method: "POST",
      headers: withAuth(deps, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        agentId: input.agentId,
        task: input.task,
        workspace,
        model: input.model,
        timeoutMs: input.timeoutMs,
        ownerSessionId,
      }),
      signal: opts.signal,
    })
    const body = (await response.json().catch(() => null)) as
      | { result?: Record<string, unknown>; error?: string }
      | null
    if (!response.ok || !body?.result) {
      return textResult(`delegate failed (HTTP ${response.status}): ${body?.error ?? "unknown error"}`, true)
    }
    const result = body.result
    // The contract JSON IS the tool result — the parent agent reads it, and
    // the desktop delegate card parses sessionId out of it (D-7).
    return textResult(JSON.stringify(result), result.status !== "completed")
  } catch (err) {
    return textResult(
      `orchestrator sidecar unreachable (${err instanceof Error ? err.message : String(err)}) — ` +
        "the Ultrawork app must be running.",
      true,
    )
  } finally {
    if (keepalive) clearInterval(keepalive)
  }
}

/** Core of the `list_agents` tool, exported for tests. */
export async function callListAgents(deps: ShimDeps, cwd?: string): Promise<ToolResultShape> {
  const doFetch = deps.fetchImpl ?? fetch
  // Pass the workspace so the sidecar scopes the list to this Team's members
  // (018); omitting it returns the global list (general delegate case).
  const url = cwd
    ? `${deps.baseUrl}/orchestration/agents?workspace=${encodeURIComponent(cwd)}`
    : `${deps.baseUrl}/orchestration/agents`
  try {
    const response = await doFetch(url, { headers: withAuth(deps) })
    const body = (await response.json().catch(() => null)) as { agents?: unknown[] } | null
    if (!response.ok || !body?.agents) {
      return textResult(`list_agents failed (HTTP ${response.status})`, true)
    }
    return textResult(JSON.stringify(body.agents))
  } catch (err) {
    return textResult(
      `orchestrator sidecar unreachable (${err instanceof Error ? err.message : String(err)})`,
      true,
    )
  }
}

export function createDelegateMcpServer(deps: ShimDeps): McpServer {
  const shimRuntimeDeps = deps
  const server = new McpServer({ name: "orchestrator", version: "0.1.0" })

  server.tool(
    "delegate",
    "Delegate a self-contained subtask to another AI agent and wait for its deliverable. " +
      "The sub-agent runs in its own session and only receives the task text you write — " +
      "include every needed file path and acceptance criterion in `task`. " +
      "Returns JSON: { status, sessionId, deliverable, tokens, cost }. " +
      "Use list_agents first to discover valid agentId values. " +
      "Long tasks are fine (the call blocks until the sub-agent finishes).",
    {
      agentId: z.string().describe('Target agent id from list_agents, e.g. "opencode:default" or "acp:claude"'),
      task: z.string().describe("Self-contained subtask prompt (the sub-agent sees ONLY this text)"),
      cwd: z.string().optional().describe("Absolute workspace for the sub-agent (defaults to the current project)"),
      model: z.string().optional().describe('Model override "providerID/modelID" (opencode targets only)'),
      timeoutMs: z.number().optional().describe("Per-task timeout in ms (default 10 min)"),
    },
    async (input, extra) => {
      console.error(`[delegate-mcp] delegate(${input.agentId}): ${input.task.slice(0, 80)}`)
      const progressToken = extra._meta?.progressToken
      let progress = 0
      const onKeepalive =
        progressToken === undefined
          ? undefined
          : () => {
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: ++progress, message: "sub-agent working…" },
                })
                .catch(() => {})
            }
      // opencode forwards the leader sessionID via MCP `_meta` (vendor patch);
      // ACP supplies it via env inside callDelegate.
      const ownerSessionId = (extra._meta as Record<string, unknown> | undefined)?.ultrawork_session
      return callDelegate(shimRuntimeDeps, input, {
        signal: extra.signal,
        onKeepalive,
        ownerSessionId: typeof ownerSessionId === "string" ? ownerSessionId : undefined,
      })
    },
  )

  server.tool(
    "list_agents",
    "List the AI agents available as delegate targets, with their ids and connection status. " +
      "Pass `cwd` (your workspace) to scope the list to your Team's members.",
    {
      cwd: z.string().optional().describe("Absolute workspace; scopes the list to this Team's members"),
    },
    async (input) => callListAgents(shimRuntimeDeps, input.cwd),
  )

  return server
}

export async function runDelegateMcp(): Promise<void> {
  const deps = shimDepsFromEnv()
  console.error(`[delegate-mcp] starting stdio shim → ${deps.baseUrl}`)
  const server = createDelegateMcpServer(deps)
  await server.connect(new StdioServerTransport())
  console.error("[delegate-mcp] connected")
}
