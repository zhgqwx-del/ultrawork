// Session system-prompt delivery (Team-page Leader, 017 §2.3):
// - _meta.systemPrompt append for adapters that honor it (claude-agent-acp ≥0.44)
// - first-prompt prefix fallback for adapters that don't
// Offline e2e against the mock ACP agent (real JSON-RPC over stdio), with
// MOCK_ACP_ECHO_PROMPT=1 so the wire prompt / received _meta are observable.

import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { supportsMetaSystemPrompt } from "../acp-connection.js"
import { ACPManager } from "../acp-manager.js"
import type { ACPAgentConfig, UwSSEEvent } from "../types.js"

const MOCK_AGENT = join(import.meta.dir, "..", "..", "scripts", "mock-acp-agent.ts")

const ECHO_CONFIG: ACPAgentConfig = {
  id: "mock",
  label: "Mock Agent",
  command: process.execPath,
  args: ["run", MOCK_AGENT],
  env: { MOCK_ACP_ECHO_PROMPT: "1" },
}

async function withTmpDataDir(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acp-sysprompt-"))
  const prev = process.env.ACP_DATA_DIR
  process.env.ACP_DATA_DIR = dir
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.ACP_DATA_DIR
    else process.env.ACP_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Concatenated final text of all assistant text parts (acp_msg_*), in order. */
function answerText(events: UwSSEEvent[]): string {
  const parts = new Map<string, string>() // partID → latest accumulated text
  for (const e of events) {
    if (
      e.type === "message.part.updated" &&
      e.properties.part.type === "text" &&
      e.properties.part.messageID.startsWith("acp_msg_")
    ) {
      parts.set(e.properties.part.id, e.properties.part.text)
    }
  }
  return [...parts.values()].join("\n")
}

/** The shaped user echo (what the UI renders as the user's bubble, acp_usr_*). */
function userEcho(events: UwSSEEvent[]): string | undefined {
  for (const e of events) {
    if (
      e.type === "message.part.updated" &&
      e.properties.part.type === "text" &&
      e.properties.part.messageID.startsWith("acp_usr_")
    ) {
      return e.properties.part.text
    }
  }
  return undefined
}

function collectInto(manager: ACPManager, sid: string): UwSSEEvent[] {
  const events: UwSSEEvent[] = []
  manager.subscribe(sid, (event) => {
    events.push(event)
    if (event.type === "permission.asked") {
      setTimeout(() => manager.replyPermission(sid, event.properties.id, "once"), 10)
    }
  })
  return events
}

describe("supportsMetaSystemPrompt", () => {
  it("detects the claude adapter from the spawn command", () => {
    expect(
      supportsMetaSystemPrompt({
        command: "bunx",
        args: ["--bun", "@agentclientprotocol/claude-agent-acp@0.44.0"],
      }),
    ).toBe(true)
    expect(supportsMetaSystemPrompt({ command: "qodercli", args: ["--acp"] })).toBe(false)
  })

  it("explicit config flag overrides detection", () => {
    expect(supportsMetaSystemPrompt({ command: "anything", args: [], metaSystemPrompt: true })).toBe(true)
    expect(
      supportsMetaSystemPrompt({
        command: "bunx",
        args: ["@agentclientprotocol/claude-agent-acp"],
        metaSystemPrompt: false,
      }),
    ).toBe(false)
  })
})

describe("_meta.systemPrompt path (adapter supports it)", () => {
  it("delivers via session/new _meta and keeps the wire prompt clean", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_meta"
      const manager = new ACPManager([{ ...ECHO_CONFIG, metaSystemPrompt: true }])
      try {
        const events = collectInto(manager, SID)
        await manager.createSession("mock", "/tmp", SID, { systemPrompt: "LEADER RULES" })
        await manager.prompt(SID, "hello")
        const answer = answerText(events)
        expect(answer).toContain("[system-meta=LEADER RULES]")
        // The wire prompt must NOT carry the prefix (meta path owns delivery).
        expect(answer).toContain("[prompt=hello]")
      } finally {
        await manager.shutdown()
      }
    })
  }, 20_000)

  it("re-injects via session/load _meta after a restart", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_meta_restart"
      const first = new ACPManager([{ ...ECHO_CONFIG, metaSystemPrompt: true }])
      collectInto(first, SID)
      await first.createSession("mock", "/tmp", SID, { systemPrompt: "LEADER RULES" })
      await first.prompt(SID, "hello")
      await first.shutdown()

      const second = new ACPManager([{ ...ECHO_CONFIG, metaSystemPrompt: true }])
      try {
        expect(second.getSession(SID)?.systemPrompt).toBe("LEADER RULES")
        const events = collectInto(second, SID)
        await second.prompt(SID, "again")
        // loadSession forwarded _meta — the mock re-recorded it.
        expect(answerText(events)).toContain("[system-meta=LEADER RULES]")
      } finally {
        await second.shutdown()
      }
    })
  }, 30_000)
})

describe("first-prompt prefix fallback (adapter without _meta support)", () => {
  it("prefixes only the first wire prompt; the user echo stays clean", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_fallback"
      const manager = new ACPManager([ECHO_CONFIG]) // mock command → no meta support
      try {
        const events = collectInto(manager, SID)
        await manager.createSession("mock", "/tmp", SID, { systemPrompt: "LEADER RULES" })
        await manager.prompt(SID, "hello")
        const answer = answerText(events)
        expect(answer).toContain("[prompt=LEADER RULES\n\nhello]")
        expect(answer).not.toContain("[system-meta=")
        // The UI-facing user bubble never shows the instructions.
        expect(userEcho(events)).toBe("hello")

        // Second turn: context already has the instructions — no prefix.
        const events2 = collectInto(manager, SID)
        await manager.prompt(SID, "second")
        expect(answerText(events2)).toContain("[prompt=second]")
      } finally {
        await manager.shutdown()
      }
    })
  }, 20_000)

  it("sessions without a systemPrompt are untouched", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_plain"
      const manager = new ACPManager([ECHO_CONFIG])
      try {
        const events = collectInto(manager, SID)
        await manager.createSession("mock", "/tmp", SID)
        await manager.prompt(SID, "hello")
        const answer = answerText(events)
        expect(answer).toContain("[prompt=hello]")
        expect(answer).not.toContain("[system-meta=")
      } finally {
        await manager.shutdown()
      }
    })
  }, 20_000)
})
