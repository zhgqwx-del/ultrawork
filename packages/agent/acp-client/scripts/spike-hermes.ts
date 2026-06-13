// Gating spike for NousResearch/hermes-agent (branch A): drive a REAL hermes
// (via `hermes acp`, reusing the local ~/.hermes config) through the sidecar
// shaping pipeline. Validates that hermes' ACP-stdio server negotiates our
// PROTOCOL_VERSION (1), creates a session, and resolves a prompt — the only
// real risk for treating hermes as a plain ACP agent like claude/gemini/qoder.
//
// Run: bun run --bun packages/agent/acp-client/scripts/spike-hermes.ts
//
// First arg "tool" runs a tool-using prompt (exercises shell hooks / cwd);
// default is a no-tool prompt to isolate protocol negotiation.

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACPConnection } from "../src/acp-connection.js"
import type { UwSSEEvent } from "../src/types.js"

const FIXTURE_PATH = join(
  import.meta.dir,
  "../../../client/desktop/src/__tests__/fixtures/acp-hermes-turn.json",
)

const useTool = process.argv[2] === "tool"
const PROMPT = useTool
  ? "List the files in the current directory using a tool (e.g. ls), then answer with one short sentence summarizing what you see."
  : "Reply with exactly one short sentence and do not use any tools: say hello and name yourself."

// Sandbox cwd: a throwaway dir with two known files.
const cwd = mkdtempSync(join(tmpdir(), "acp-spike-hermes-"))
writeFileSync(join(cwd, "alpha.txt"), "alpha\n")
writeFileSync(join(cwd, "beta.md"), "# beta\n")
console.log(`[spike] cwd: ${cwd}  mode: ${useTool ? "tool" : "no-tool"}`)

const events: UwSSEEvent[] = []
const conn = new ACPConnection(
  {
    id: "hermes",
    label: "Hermes",
    command: "hermes",
    // --accept-hooks: auto-approve unseen shell hooks without a TTY (headless).
    args: ["acp", "--accept-hooks"],
  },
  (_sessionId, event) => {
    events.push(event)
    console.log(`[event] ${summarize(event)}`)
  },
)

let ok = false
try {
  console.log("[spike] connecting (initialize)…")
  await conn.connect(cwd)
  console.log(
    `[spike] connected: protocol v${conn.protocolVersion}, capabilities: ${JSON.stringify(conn.agentCapabilities)}`,
  )
  if (conn.protocolVersion !== 1) {
    console.log(`[spike] ⚠️ protocol version is ${conn.protocolVersion}, expected 1 — branch A compatibility at risk`)
  }
  console.log("[spike] creating session…")
  const sessionId = await conn.newSession(cwd)
  console.log(`[spike] session: ${sessionId}`)
  console.log(`[spike] prompting: ${PROMPT}`)
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

// --- summary: what would the renderer see? ---
const messages = new Map<string, { finish?: string; types: string[] }>()
for (const e of events) {
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
console.log(ok ? "\n[spike] ✅ connect + session + prompt completed" : "\n[spike] ❌ run did NOT complete — inspect log above")
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
    default:
      return event.type
  }
}
