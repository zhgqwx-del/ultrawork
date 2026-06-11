// W1 spike: drive a REAL claude (via @agentclientprotocol/claude-agent-acp, reusing
// the local Claude Code login) through the sidecar shaping pipeline and dump
// the shaped SSE stream as a fixture for the desktop buildTurnModel test.
//
// Run: bun run --bun packages/agent/acp-client/scripts/spike-claude.ts

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACPConnection } from "../src/acp-connection.js"
import type { UwSSEEvent } from "../src/types.js"

const FIXTURE_PATH = join(
  import.meta.dir,
  "../../../client/desktop/src/__tests__/fixtures/acp-claude-turn.json",
)

const PROMPT =
  "List the files in the current directory using a tool (e.g. ls), then answer with one short sentence summarizing what you see."

// Sandbox cwd: a throwaway dir with two known files.
const cwd = mkdtempSync(join(tmpdir(), "acp-spike-"))
writeFileSync(join(cwd, "alpha.txt"), "alpha\n")
writeFileSync(join(cwd, "beta.md"), "# beta\n")
console.log(`[spike] cwd: ${cwd}`)

const events: UwSSEEvent[] = []
const conn = new ACPConnection(
  {
    id: "claude",
    label: "Claude Code",
    command: "bunx",
    args: ["--bun", "@agentclientprotocol/claude-agent-acp"],
  },
  (_sessionId, event) => {
    events.push(event)
    console.log(`[event] ${summarize(event)}`)
  },
)

try {
  console.log("[spike] connecting (initialize)…")
  await conn.connect()
  console.log(
    `[spike] connected: protocol v${conn.protocolVersion}, capabilities: ${JSON.stringify(conn.agentCapabilities)}`,
  )
  console.log("[spike] creating session…")
  const sessionId = await conn.newSession(cwd)
  console.log(`[spike] session: ${sessionId}`)
  console.log(`[spike] prompting: ${PROMPT}`)
  const stopReason = await conn.prompt(sessionId, PROMPT)
  console.log(`[spike] stopReason: ${stopReason}`)
} finally {
  conn.disconnect()
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
const list = [...messages.values()]
const last = list[list.length - 1]
const ok =
  list.length >= 2 &&
  last !== undefined &&
  last.finish !== undefined &&
  last.finish !== "tool-calls" &&
  !last.types.includes("tool") &&
  last.types.includes("text") &&
  list.some((m) => m.types.includes("tool"))
console.log(
  ok
    ? "\n[spike] ✅ shape OK: tool steps in process messages, text-only answer message, terminal finish"
    : "\n[spike] ❌ shape NOT OK — inspect the event log above",
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
    default:
      return event.type
  }
}
