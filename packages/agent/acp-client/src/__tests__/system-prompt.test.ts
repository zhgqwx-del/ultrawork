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
import { assistantIdentityPrompt, DEFAULT_BRAND, resolveIdentity } from "@agent/brand"
import type { RuntimeBrandContext } from "@agent/brand/node"
import { ACPManager } from "../acp-manager.js"
import { loadAllSessions, saveSession } from "../session-store.js"
import type { ACPAgentConfig, UwSSEEvent } from "../types.js"

const MOCK_AGENT = join(import.meta.dir, "..", "..", "scripts", "mock-acp-agent.ts")

const ECHO_CONFIG: ACPAgentConfig = {
  id: "mock",
  label: "Mock Agent",
  command: process.execPath,
  args: ["run", MOCK_AGENT],
  env: { MOCK_ACP_ECHO_PROMPT: "1" },
}

const DEFAULT_IDENTITY_PROMPT = assistantIdentityPrompt()
const MYWORK = resolveIdentity({ brandId: "mywork", productName: "MyWork" })

async function withTmpDataDir(fn: () => Promise<void>, branded = false): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acp-sysprompt-"))
  const envKeys = ["ACP_DATA_DIR", "ULTRAWORK_BRAND_CONTEXT", "ULTRAWORK_BRAND_CONTEXT_FILE", "ULTRAWORK_BRAND_MANAGED", "OPENCODE_APP_NAME"]
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  if (branded) {
    const configRoot = join(dir, "config", "mywork")
    const appRoot = join(dir, ".mywork")
    const context: RuntimeBrandContext = {
      schemaVersion: 1, identity: MYWORK, instanceId: "test_instance",
      appRoot, configRoot, dataRoot: join(dir, "data", "mywork"),
      cacheRoot: join(dir, "cache", "mywork"), stateRoot: join(dir, "state", "mywork"),
      skillsRoot: join(configRoot, "skills"), portsRegistryPath: join(appRoot, "run", "ports.json"),
    }
    process.env.ULTRAWORK_BRAND_CONTEXT = JSON.stringify(context)
    process.env.ULTRAWORK_BRAND_MANAGED = "1"
  } else process.env.ACP_DATA_DIR = dir
  try {
    await fn()
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
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
        await manager.createSession("mock", tmpdir(), SID, { systemPrompt: "LEADER RULES" })
        await manager.prompt(SID, "hello")
        const answer = answerText(events)
        expect(answer).toContain(`[system-meta=LEADER RULES\n\n${DEFAULT_IDENTITY_PROMPT}]`)
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
      await first.createSession("mock", tmpdir(), SID, { systemPrompt: "LEADER RULES" })
      await first.prompt(SID, "hello")
      await first.shutdown()

      const second = new ACPManager([{ ...ECHO_CONFIG, metaSystemPrompt: true }])
      try {
        expect(second.getSession(SID)?.systemPrompt).toBe("LEADER RULES")
        const events = collectInto(second, SID)
        await second.prompt(SID, "again")
        // loadSession forwarded _meta — the mock re-recorded it.
        expect(answerText(events)).toContain(`[system-meta=LEADER RULES\n\n${DEFAULT_IDENTITY_PROMPT}]`)
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
        await manager.createSession("mock", tmpdir(), SID, { systemPrompt: "LEADER RULES" })
        await manager.prompt(SID, "hello")
        const answer = answerText(events)
        expect(answer).toContain(`[prompt=LEADER RULES\n\n${DEFAULT_IDENTITY_PROMPT}\n\nhello]`)
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

  it("adds the default product identity to ordinary sessions without changing the user echo", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_plain"
      const manager = new ACPManager([ECHO_CONFIG])
      try {
        const events = collectInto(manager, SID)
        await manager.createSession("mock", tmpdir(), SID)
        await manager.prompt(SID, "hello")
        const answer = answerText(events)
        expect(answer).toContain(`[prompt=${DEFAULT_IDENTITY_PROMPT}\n\nhello]`)
        expect(answer).not.toContain("[system-meta=")
        expect(userEcho(events)).toBe("hello")
      } finally {
        await manager.shutdown()
      }
    })
  }, 20_000)
})

describe("brand identity across ACP session lifecycles", () => {
  for (const metaSystemPrompt of [false, true]) {
    for (const role of [undefined, "TEAM LEADER: delegate to the configured members", "PIPELINE MEMBER: preserve the assigned task"]) {
      it(`uses MyWork for ${role ?? "single agent"}, meta=${metaSystemPrompt}`, async () => {
        await withTmpDataDir(async () => {
          const sid = "ses_mywork"
          const manager = new ACPManager([{ ...ECHO_CONFIG, metaSystemPrompt }])
          try {
            const events = collectInto(manager, sid)
            await manager.createSession("mock", tmpdir(), sid, { systemPrompt: role, orchestrate: false })
            await manager.prompt(sid, "你是谁？")
            const identity = assistantIdentityPrompt(MYWORK)
            const system = role ? `${role}\n\n${identity}` : identity
            expect(answerText(events)).toContain(metaSystemPrompt ? `[system-meta=${system}]` : `[prompt=${system}\n\n你是谁？]`)
            expect(answerText(events)).not.toContain(DEFAULT_IDENTITY_PROMPT)
            expect(userEcho(events)).toBe("你是谁？")
            expect(manager.getSession(sid)?.systemPrompt).toBe(role)
          } finally {
            await manager.shutdown()
          }
        }, true)
      }, 20_000)
    }
  }

  it("retains the delivered prefix marker across successful session/load without prefixing twice", async () => {
    await withTmpDataDir(async () => {
      const sid = "ses_prefix_restart"
      const first = new ACPManager([ECHO_CONFIG])
      try {
        collectInto(first, sid)
        await first.createSession("mock", tmpdir(), sid)
        await first.prompt(sid, "first")
      } finally { await first.shutdown() }
      expect(loadAllSessions()[0].hostIdentityPrompt).toBe(DEFAULT_IDENTITY_PROMPT)
      const second = new ACPManager([ECHO_CONFIG])
      try {
        const events = collectInto(second, sid)
        await second.prompt(sid, "again")
        expect(answerText(events)).toContain("[prompt=again]")
        expect(answerText(events)).not.toContain("<host_application_identity>")
      } finally { await second.shutdown() }
    })
  }, 30_000)

  it("upgrades a persisted pre-brand session once while preserving history and its role", async () => {
    await withTmpDataDir(async () => {
      const sid = "ses_legacy"
      const history = [{ info: { id: "historic", sessionID: sid, role: "assistant" as const, time: { created: 1 } }, parts: [] }]
      saveSession({ version: 1, sessionId: sid, acpSessionId: "old-session", agentId: "mock", cwd: tmpdir(), createdAt: 1, updatedAt: 1, systemPrompt: "LEADER RULES", messages: history })
      const manager = new ACPManager([ECHO_CONFIG])
      try {
        const events = collectInto(manager, sid)
        await manager.prompt(sid, "hello")
        expect(answerText(events)).toContain(`[prompt=LEADER RULES\n\n${DEFAULT_IDENTITY_PROMPT}\n\nhello]`)
        expect(manager.getMessages(sid)?.[0]).toEqual(history[0])
        const next = collectInto(manager, sid)
        await manager.prompt(sid, "again")
        expect(answerText(next)).toContain("[prompt=again]")
      } finally { await manager.shutdown() }
    })
  }, 30_000)

  const restartCases: Record<string, string>[] = [{ MOCK_ACP_FAIL_LOAD: "1" }, { MOCK_ACP_NO_LOAD: "1" }]
  for (const restartEnv of restartCases) {
    it(`restores identity and role when the underlying context is lost (${Object.keys(restartEnv)[0]})`, async () => {
      await withTmpDataDir(async () => {
        const sid = "ses_context_lost"
        const first = new ACPManager([ECHO_CONFIG])
        try {
          collectInto(first, sid)
          await first.createSession("mock", tmpdir(), sid, { systemPrompt: "LEADER RULES" })
          await first.prompt(sid, "first")
        } finally { await first.shutdown() }
        const second = new ACPManager([{ ...ECHO_CONFIG, env: { ...ECHO_CONFIG.env, ...restartEnv } }])
        try {
          const events = collectInto(second, sid)
          await second.prompt(sid, "again")
          expect(answerText(events)).toContain(`[prompt=LEADER RULES\n\n${DEFAULT_IDENTITY_PROMPT}\n\nagain]`)
          expect(userEcho(events)).toBe("again")
        } finally { await second.shutdown() }
      })
    }, 30_000)
  }

  it("re-delivers a changed identity version instead of trusting a stale persisted marker", async () => {
    await withTmpDataDir(async () => {
      const sid = "ses_stale_identity"
      saveSession({ version: 1, sessionId: sid, acpSessionId: "old-session", agentId: "mock", cwd: tmpdir(), createdAt: 1, updatedAt: 1, hostIdentityPrompt: assistantIdentityPrompt(DEFAULT_BRAND), messages: [] })
      const manager = new ACPManager([ECHO_CONFIG])
      try {
        const events = collectInto(manager, sid)
        await manager.prompt(sid, "hello")
        expect(answerText(events)).toContain(`[prompt=${assistantIdentityPrompt(MYWORK)}\n\nhello]`)
        expect(loadAllSessions()[0].hostIdentityPrompt).toBe(assistantIdentityPrompt(MYWORK))
      } finally { await manager.shutdown() }
    }, true)
  }, 20_000)

  it("refreshes a restored same-brand contract when identity language guidance changes", async () => {
    await withTmpDataDir(async () => {
      const sid = "ses_same_brand_contract_upgrade"
      const current = assistantIdentityPrompt(MYWORK)
      const previous = current.replace(/^Write self-introductions[^\n]*\n/m, "")
      expect(previous).not.toBe(current)
      expect(previous).toContain('The host application is "MyWork"')
      saveSession({ version: 1, sessionId: sid, acpSessionId: "old-session", agentId: "mock", cwd: tmpdir(), createdAt: 1, updatedAt: 1, hostIdentityPrompt: previous, messages: [] })
      const manager = new ACPManager([ECHO_CONFIG])
      try {
        const events = collectInto(manager, sid)
        await manager.prompt(sid, "Who are you?")
        expect(answerText(events)).toContain(`[prompt=${current}\n\nWho are you?]`)
        expect(userEcho(events)).toBe("Who are you?")
        expect(loadAllSessions()[0].hostIdentityPrompt).toBe(current)
      } finally { await manager.shutdown() }
    }, true)
  }, 20_000)

  it("does not mark a failed first prompt as delivered, so retry keeps the identity", async () => {
    await withTmpDataDir(async () => {
      const sid = "ses_retry_identity"
      const manager = new ACPManager([{ ...ECHO_CONFIG, env: { ...ECHO_CONFIG.env, MOCK_ACP_FAIL_FIRST_PROMPT: "1" } }])
      try {
        collectInto(manager, sid)
        await manager.createSession("mock", tmpdir(), sid)
        // Consume the real stdio rejection before synchronous assertions so
        // the RPC is driven by an ordinary await on every platform.
        let failure: unknown
        try { await manager.prompt(sid, "first") } catch (error) { failure = error }
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain("Internal error")
        expect((failure as { code: number }).code).toBe(-32603)
        expect(loadAllSessions()[0].hostIdentityPrompt).toBeUndefined()
        const events = collectInto(manager, sid)
        await manager.prompt(sid, "retry")
        expect(answerText(events)).toContain(`[prompt=${DEFAULT_IDENTITY_PROMPT}\n\nretry]`)
        expect(loadAllSessions()[0].hostIdentityPrompt).toBe(DEFAULT_IDENTITY_PROMPT)
      } finally { await manager.shutdown() }
    })
  }, 20_000)
})
