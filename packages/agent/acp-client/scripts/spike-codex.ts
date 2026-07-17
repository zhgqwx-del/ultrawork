// Gating spike for OpenAI Codex CLI: drive a REAL codex (via the ACP bridge
// @agentclientprotocol/codex-acp, which wraps the codex runtime) through the
// sidecar shaping pipeline. This decides three questions that desk research
// could NOT (READMEs don't document them):
//
//   Q1 PROTOCOL: our client ships @agentclientprotocol/sdk@0.25.0 (protocol
//      integer from PROTOCOL_VERSION); codex-acp@latest depends on sdk@^1.2.1
//      (1.x). Does `initialize` negotiate a shared version, or does the newer
//      bridge refuse to speak our 0.x protocol? → picks the A/B fork:
//        A = we must bump the sidecar's @agentclientprotocol/sdk to 1.x
//        B = pin an older codex-acp (0.0.x) that matches our 0.x SDK
//   Q2 AUTH: codex-acp's README does NOT promise it reuses ~/.codex/auth.json.
//      Does a headless run authenticate off the local ChatGPT/API login, or
//      does it stall / error asking for a key? NO_BROWSER=1 is set so it can
//      never pop a browser and hang the sidecar.
//   Q3 SANDBOX/APPROVAL: run a tool prompt (ls + write a file) and watch
//      whether codex's own sandbox blocks it before our permission loop, or
//      whether it surfaces an ACP permission.asked we can answer.
//
// Run (protocol+auth only):   bun run --bun packages/agent/acp-client/scripts/spike-codex.ts
// Run (tool/sandbox probe):   bun run --bun packages/agent/acp-client/scripts/spike-codex.ts tool
// Retry with an older bridge: CODEX_ACP_PKG=@agentclientprotocol/codex-acp@0.0.40 bun run --bun … [tool]

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACPConnection } from "../src/acp-connection.js"
import type { UwSSEEvent } from "../src/types.js"

const FIXTURE_PATH = join(
  import.meta.dir,
  "../../../client/desktop/src/__tests__/fixtures/acp-codex-turn.json",
)

// Overridable so we can retry the 0.0.x pin (Q1 fork B) without editing.
const PKG = process.env.CODEX_ACP_PKG ?? "@agentclientprotocol/codex-acp"

const mode = process.argv[2] // "tool" | "escape" | "perm" | undefined
const useTool = mode === "tool" || mode === "escape" || mode === "perm"
if (mode === "escape" && !process.env.CODEX_SPIKE_OUT) {
  console.error("[spike] escape mode requires CODEX_SPIKE_OUT=<abs path outside cwd>")
  process.exit(2)
}
// "perm": drive codex to escalate via ACP so our permission loop lights up.
// Set INITIAL_AGENT_MODE=read-only in the env → a shell write is sandbox-blocked
// → codex's on-request policy asks the client (handleCommandExecution →
// session/request_permission) → our createClient.requestPermission emits
// permission.asked, which THIS spike auto-approves to prove the round-trip.
const PROMPT = process.env.CODEX_SPIKE_PROMPT
  ? process.env.CODEX_SPIKE_PROMPT
  : mode === "perm"
    ? "Using the shell, create a file named codex-perm.txt in the current directory containing the word ok, then confirm in one short sentence."
    : mode === "escape"
      ? // Force a sandbox escalation (write OUTSIDE the workspace).
        `Using tools, create a file at the absolute path ${process.env.CODEX_SPIKE_OUT} containing the word ok. If a tool is blocked, stop and say so.`
      : useTool
        ? "Using tools, list the files in the current directory, then create a file named codex-spike.txt containing the word ok, and finish with one short sentence summarizing what you did."
        : "Reply with exactly one short sentence and do not use any tools: say hello and name which model you are."

// Sandbox cwd: a throwaway dir with two known files (mirrors spike-hermes).
// ⚠️ Default is under $TMPDIR — codex's workspace-write sandbox treats TMPDIR /
// /tmp as writable (excludeTmpdirEnvVar/excludeSlashTmp = false), so in-workspace
// writes there NEVER prompt. To reproduce a REAL (non-temp) workspace's approval
// behavior, pass CODEX_SPIKE_CWD=<abs non-tmp dir>.
const cwd = process.env.CODEX_SPIKE_CWD ?? mkdtempSync(join(tmpdir(), "acp-spike-codex-"))
writeFileSync(join(cwd, "alpha.txt"), "alpha\n")
writeFileSync(join(cwd, "beta.md"), "# beta\n")
console.log(`[spike] cwd: ${cwd}  pkg: ${PKG}  mode: ${useTool ? "tool" : "no-tool"}`)

const events: UwSSEEvent[] = []
const conn = new ACPConnection(
  {
    id: "codex",
    label: "Codex CLI",
    // No --bun: the bridge bundles @openai/codex (a heavy runtime); gemini's
    // template made the same call. bunx resolves PKG's `codex-acp` bin.
    command: "bunx",
    args: [PKG],
    // NO_BROWSER: never advertise/trigger browser login in a headless sidecar
    // (Q2). Auth must come from the local ~/.codex or an env key.
    // CODEX_CONFIG (Q3 round 2): forwarded verbatim so we can steer codex's
    // approval_policy/sandbox_mode and check whether escalation surfaces as an
    // ACP requestPermission (→ our permission loop lights up). Passing nothing
    // reproduces the default auto-execute behavior of round 1.
    env: {
      NO_BROWSER: "1",
      ...(process.env.CODEX_CONFIG ? { CODEX_CONFIG: process.env.CODEX_CONFIG } : {}),
      // INITIAL_AGENT_MODE (bridge, src 25665): read-only | agent | agent-full-access.
      // "perm" mode passes read-only so a shell write must escalate for approval.
      ...(process.env.INITIAL_AGENT_MODE ? { INITIAL_AGENT_MODE: process.env.INITIAL_AGENT_MODE } : {}),
    },
  },
  (_sessionId, event) => {
    events.push(event)
    console.log(`[event] ${summarize(event)}`)
    // Prove the full round-trip: when codex escalates, auto-approve so the
    // gated tool actually proceeds (not just that the prompt appeared).
    if (event.type === "permission.asked") {
      const granted = conn.replyPermission(event.properties.id, "once")
      console.log(`[spike] 🔓 permission.asked → auto-approved (once): ${event.properties.id} (accepted=${granted})`)
    }
  },
)

let ok = false
let sawPermission = false
try {
  console.log("[spike] connecting (initialize)… [Q1 protocol, Q2 auth]")
  await conn.connect(cwd)
  console.log(
    `[spike] connected: protocol v${conn.protocolVersion}, capabilities: ${JSON.stringify(conn.agentCapabilities)}`,
  )
  console.log(
    `[spike] Q1 → negotiated protocol v${conn.protocolVersion} between our 0.25 client and ${PKG}. ` +
      `(fork A if this errored/degraded, fork B = pin an older bridge)`,
  )
  console.log("[spike] creating session…")
  // CODEX_SPIKE_ORCHESTRATE=1 injects the delegate MCP (Team leader path) so we
  // can observe whether codex-as-leader's orchestrator_delegate call surfaces a
  // permission prompt (reproduces the real-app Team-leader popup).
  const orchestrate = process.env.CODEX_SPIKE_ORCHESTRATE === "1"
  const sessionId = orchestrate
    ? await conn.newSession(cwd, undefined, { orchestrate: true, systemPrompt: process.env.CODEX_SPIKE_SYSPROMPT })
    : await conn.newSession(cwd)
  console.log(`[spike] session: ${sessionId}`)
  console.log(`[spike] prompting (${useTool ? "tool/sandbox — Q3" : "no-tool"}): ${PROMPT}`)
  const stopReason = await conn.prompt(sessionId, PROMPT)
  console.log(`[spike] stopReason: ${stopReason}`)
  ok = true
} catch (err) {
  console.log(`[spike] ❌ error: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await conn.disconnect()
}

mkdirSync(join(FIXTURE_PATH, ".."), { recursive: true })
writeFileSync(FIXTURE_PATH, JSON.stringify(events, null, 2) + "\n")
console.log(`\n[spike] wrote ${events.length} events → ${FIXTURE_PATH}`)

// --- summary: what would the renderer see? + Q3 signal ---
const messages = new Map<string, { finish?: string; types: string[] }>()
for (const e of events) {
  if (e.type === "permission.asked") sawPermission = true
  if (e.type === "message.part.updated") {
    const p = e.properties.part
    const m = messages.get(p.messageID) ?? { types: [] }
    if (!messages.has(p.messageID)) messages.set(p.messageID, m)
    m.types.push(p.type)
  } else if (e.type === "message.updated") {
    const info = e.properties.info
    const m = messages.get(info.id) ?? { types: [] }
    if (!messages.has(info.id)) messages.set(info.id, m)
    m.finish = info.finish
    if (info.tokens) console.log(`[summary] tokens: ${JSON.stringify(info.tokens)} cost: ${info.cost ?? "-"}`)
  }
}
console.log("[summary] messages in turn:")
let i = 0
for (const [id, m] of messages) {
  console.log(`  #${i++} ${id}: parts=[${m.types.join(", ")}] finish=${m.finish ?? "∅"}`)
}
if (useTool) {
  console.log(
    `[summary] Q3 sandbox/approval: permission.asked seen = ${sawPermission}; ` +
      `tool parts present = ${[...messages.values()].some((m) => m.types.includes("tool"))}. ` +
      `(if a tool was requested but blocked with no permission.asked, codex's own sandbox pre-empted our loop → needs a managed config)`,
  )
}
console.log(
  ok
    ? "\n[spike] ✅ connect + session + prompt completed — inspect Q1/Q2/Q3 lines above"
    : "\n[spike] ❌ run did NOT complete — inspect the log above (likely Q1 protocol or Q2 auth)",
)
process.exit(ok ? 0 : 1)

function summarize(event: UwSSEEvent): string {
  switch (event.type) {
    case "message.part.updated": {
      const p = event.properties.part
      const extra =
        p.type === "tool"
          ? ` ${p.callID} ${p.state.status}`
          : ` "${(p as { text?: string }).text?.slice(0, 40) ?? ""}"`
      return `part.updated ${p.messageID} ${p.type}${extra}`
    }
    case "message.part.delta":
      return `part.delta   ${event.properties.messageID} +"${event.properties.delta.slice(0, 40)}"`
    case "message.updated": {
      const info = event.properties.info
      return `msg.updated  ${info.id} finish=${info.finish}`
    }
    case "permission.asked":
      return `permission.asked ${event.properties.id} ${JSON.stringify(event.properties.permission).slice(0, 80)}`
    default:
      return event.type
  }
}
