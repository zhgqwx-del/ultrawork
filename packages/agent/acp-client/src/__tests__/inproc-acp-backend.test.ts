// InProcACPBackend ↔ ACPManager contract (the orchestrator's ACP leg).

import { describe, it, expect } from "bun:test"
import type { ACPManager } from "../acp-manager.js"
import type { UwSSEEvent } from "../types.js"
import { InProcACPBackend } from "../inproc-acp-backend.js"

interface FakeManagerLog {
  createSession: Array<{ agentId: string; cwd: string; clientSessionId?: string; orchestrate?: boolean }>
  prompts: Array<{ sessionId: string; text: string }>
  cancelled: string[]
  deleted: string[]
}

function fakeManager(overrides: Partial<Record<string, unknown>> = {}) {
  const log: FakeManagerLog = { createSession: [], prompts: [], cancelled: [], deleted: [] }
  const subscribers = new Set<(event: UwSSEEvent) => void>()
  const manager = {
    log,
    subscribers,
    createSession: async (
      agentId: string,
      cwd: string,
      clientSessionId?: string,
      opts?: { orchestrate?: boolean },
    ) => {
      log.createSession.push({ agentId, cwd, clientSessionId, orchestrate: opts?.orchestrate })
      return clientSessionId ?? "acp-session-1"
    },
    prompt: async (sessionId: string, text: string) => {
      log.prompts.push({ sessionId, text })
      return "end_turn"
    },
    cancel: async (sessionId: string) => {
      log.cancelled.push(sessionId)
    },
    getMessages: (_sessionId: string) => [{ info: { id: "m1", sessionID: "s1", role: "assistant", time: { created: 1 } }, parts: [] }],
    deleteSession: (sessionId: string) => {
      log.deleted.push(sessionId)
      return true
    },
    replyPermission: () => true,
    subscribe: (_sessionId: string, subscriber: (event: UwSSEEvent) => void) => {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
    listAgents: () => [
      { id: "claude", label: "Claude Code", description: "d", status: "connected" as const },
    ],
    ...overrides,
  }
  return { manager: manager as unknown as ACPManager, log, subscribers }
}

describe("InProcACPBackend", () => {
  it("createSession parses the namespaced agent id, omits the opencode twin, and hard-disables orchestrate", async () => {
    const { manager, log } = fakeManager()
    const backend = new InProcACPBackend(manager)
    const ref = await backend.createSession({ agentId: "acp:claude", directory: "/ws" })
    // orchestrate: false is the ACP-side recursion guard — children never get
    // the delegate MCP even when the agent-level default is on.
    expect(log.createSession).toEqual([
      { agentId: "claude", cwd: "/ws", clientSessionId: undefined, orchestrate: false },
    ])
    expect(ref).toEqual({ id: "acp-session-1", backend: "acp", directory: "/ws" })
  })

  it("requires agentId and directory", async () => {
    const backend = new InProcACPBackend(fakeManager().manager)
    await expect(backend.createSession({ directory: "/ws" })).rejects.toThrow("agentId")
    await expect(backend.createSession({ agentId: "acp:claude" })).rejects.toThrow("directory")
  })

  it("prompt delegates to the manager's blocking prompt", async () => {
    const { manager, log } = fakeManager()
    const backend = new InProcACPBackend(manager)
    await backend.prompt("s1", "hello")
    expect(log.prompts).toEqual([{ sessionId: "s1", text: "hello" }])
  })

  it("fetchHistory serves the shaped store messages", async () => {
    const backend = new InProcACPBackend(fakeManager().manager)
    const result = await backend.fetchHistory("s1")
    expect(result.hasMore).toBe(false)
    expect(result.messages).toHaveLength(1)
  })

  it("fetchHistory of an unknown session is empty, not an error", async () => {
    const { manager } = fakeManager({ getMessages: () => undefined })
    const backend = new InProcACPBackend(manager)
    expect((await backend.fetchHistory("nope")).messages).toEqual([])
  })

  it("replyPermission throws when the manager reports an unknown permission", async () => {
    const { manager } = fakeManager({ replyPermission: () => false })
    const backend = new InProcACPBackend(manager)
    await expect(backend.replyPermission("s1", "p1", "once")).rejects.toThrow("already-resolved")
  })

  it("subscribeSession passes manager events through and unsubscribes", () => {
    const { manager, subscribers } = fakeManager()
    const backend = new InProcACPBackend(manager)
    const seen: string[] = []
    const unsubscribe = backend.subscribeSession("s1", (event) => seen.push(event.type))

    const event = { type: "message.updated", properties: { info: { id: "m", sessionID: "s1", role: "assistant", time: { created: 1 } } } }
    for (const sub of subscribers) sub(event as UwSSEEvent)
    expect(seen).toEqual(["message.updated"])

    unsubscribe()
    expect(subscribers.size).toBe(0)
  })

  it("listAgents maps to namespaced UnifiedAgents", async () => {
    const backend = new InProcACPBackend(fakeManager().manager)
    expect(await backend.listAgents()).toEqual([
      { id: "acp:claude", name: "Claude Code", description: "d", source: "acp", status: "connected", error: undefined },
    ])
  })
})
