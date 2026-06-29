import { describe, it, expect, vi, beforeEach } from "vitest"
import { Connector } from "../connector"
import { BindingStore } from "../binding-store"
import type { AgentBackend, BackendCapabilities, ConnectorEvent } from "../index"

const baseCapabilities: BackendCapabilities = {
  providers: false,
  mcp: false,
  file: false,
  agentCrud: false,
  loadSession: false,
  image: false,
  permissions: true,
  questions: false,
  fileDiffs: false,
  plan: false,
  reasoning: false,
  historyReplay: false,
  revert: false,
  globalEvents: false,
  paginatedHistory: false,
  model: false,
  sessionStatus: false,
}

interface FakeBackend extends AgentBackend {
  emitted: Array<(event: ConnectorEvent) => void>
}

function fakeBackend(kind: string, capabilities: Partial<BackendCapabilities> = {}): FakeBackend {
  const caps = { ...baseCapabilities, ...capabilities }
  const backend: FakeBackend = {
    kind,
    transport: kind === "acp" ? "acp-stdio" : "product-native",
    capabilities: caps,
    emitted: [],
    createSession: vi.fn(async (opts) => ({ id: opts.clientSessionId ?? `${kind}-session`, backend: kind })),
    prompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    revert: caps.revert ? vi.fn(async () => {}) : undefined,
    fetchHistory: vi.fn(async () => ({ messages: [], hasMore: false })),
    getPlan: caps.plan ? vi.fn(async () => [{ content: "step", status: "pending" as const }]) : undefined,
    deleteSessionState: vi.fn(async () => {}),
    replyPermission: vi.fn(async () => {}),
    subscribeSession: vi.fn((_sessionId: string, handler: (event: ConnectorEvent) => void) => {
      backend.emitted.push(handler)
      return () => {
        backend.emitted = backend.emitted.filter((h) => h !== handler)
      }
    }),
    subscribeGlobal: caps.globalEvents
      ? vi.fn((handler: (event: ConnectorEvent) => void) => {
          backend.emitted.push(handler)
          return () => {
            backend.emitted = backend.emitted.filter((h) => h !== handler)
          }
        })
      : undefined,
    listAgents: vi.fn(async () => []),
    status: () => "connected" as const,
    ready: async () => {},
    dispose: vi.fn(),
  }
  return backend
}

describe("Connector", () => {
  let opencode: FakeBackend
  let acp: FakeBackend
  let connector: Connector

  beforeEach(() => {
    opencode = fakeBackend("opencode", { globalEvents: true, revert: true, questions: true })
    acp = fakeBackend("acp", { agentCrud: true, loadSession: true })
    connector = new Connector({ bindings: new BindingStore() })
    connector.registerBackend(opencode)
    connector.registerBackend(acp)
  })

  describe("dispatch by session binding (D-4)", () => {
    it("routes unbound sessions to the default backend with boundAgentId=default", async () => {
      await connector.prompt("s1", "hello", { agent: "build" })
      expect(opencode.prompt).toHaveBeenCalledWith("s1", "hello", { agent: "build", boundAgentId: "default" })
      expect(acp.prompt).not.toHaveBeenCalled()
    })

    it("routes bound sessions to their backend with the raw agent id", async () => {
      connector.bindings.bind("s1", "acp:claude")
      await connector.prompt("s1", "hello")
      expect(acp.prompt).toHaveBeenCalledWith("s1", "hello", { boundAgentId: "claude" })
      expect(opencode.prompt).not.toHaveBeenCalled()
    })

    it("cancel / fetchHistory / replyPermission follow the binding", async () => {
      connector.bindings.bind("s1", "acp:claude")
      await connector.cancel("s1")
      await connector.fetchHistory("s1", { limit: 10 })
      await connector.replyPermission("s1", "p1", "reject")
      expect(acp.cancel).toHaveBeenCalledWith("s1")
      expect(acp.fetchHistory).toHaveBeenCalledWith("s1", { limit: 10 })
      expect(acp.replyPermission).toHaveBeenCalledWith("s1", "p1", "reject")
    })

    it("falls back to the default backend when the bound kind is unregistered", async () => {
      connector.bindings.bind("s1", "acp:claude")
      const lonely = new Connector({ bindings: connector.bindings })
      lonely.registerBackend(opencode)
      await lonely.cancel("s1")
      expect(opencode.cancel).toHaveBeenCalledWith("s1")
    })

    it("capabilitiesOf reflects the bound backend", () => {
      expect(connector.capabilitiesOf("s1").revert).toBe(true)
      connector.bindings.bind("s1", "acp:claude")
      expect(connector.capabilitiesOf("s1").revert).toBe(false)
      expect(connector.capabilitiesOf("s1").agentCrud).toBe(true)
    })
  })

  describe("revert gating", () => {
    it("delegates revert when supported", async () => {
      await connector.revert("s1", "m1")
      expect(opencode.revert).toHaveBeenCalledWith("s1", "m1")
    })

    it("throws for backends without revert capability", async () => {
      connector.bindings.bind("s1", "acp:claude")
      await expect(connector.revert("s1", "m1")).rejects.toThrow(/does not support revert/)
    })
  })

  describe("getPlan gating (ADR-038)", () => {
    it("delegates to the bound backend when plan is supported", async () => {
      const planful = fakeBackend("opencode", { globalEvents: true, plan: true })
      const c = new Connector({ bindings: new BindingStore() })
      c.registerBackend(planful)
      await expect(c.getPlan("s1")).resolves.toEqual([{ content: "step", status: "pending" }])
      expect(planful.getPlan).toHaveBeenCalledWith("s1")
    })

    it("returns [] for backends without plan capability (no throw)", async () => {
      connector.bindings.bind("s1", "acp:claude") // acp fake has plan:false
      await expect(connector.getPlan("s1")).resolves.toEqual([])
      expect(acp.getPlan).toBeUndefined()
    })
  })

  describe("createSession", () => {
    it("creates on the default backend and leaves no binding", async () => {
      const ref = await connector.createSession({})
      expect(opencode.createSession).toHaveBeenCalled()
      expect(ref.backend).toBe("opencode")
      expect(connector.bindings.snapshot()).toEqual({})
    })

    it("creates on the backend implied by agentId and binds the session", async () => {
      const ref = await connector.createSession({ agentId: "acp:claude", clientSessionId: "client-1" })
      expect(acp.createSession).toHaveBeenCalled()
      expect(ref.id).toBe("client-1")
      expect(connector.bindings.get("client-1")).toBe("acp:claude")
    })
  })

  describe("deleteSession", () => {
    it("default-bound: deletes only on the default backend and clears binding", async () => {
      await connector.deleteSession("s1")
      expect(opencode.deleteSessionState).toHaveBeenCalledWith("s1")
      expect(acp.deleteSessionState).not.toHaveBeenCalled()
    })

    it("acp-bound: deletes the canonical session AND the bound backend state", async () => {
      connector.bindings.bind("s1", "acp:claude")
      await connector.deleteSession("s1")
      expect(opencode.deleteSessionState).toHaveBeenCalledWith("s1")
      expect(acp.deleteSessionState).toHaveBeenCalledWith("s1")
      expect(connector.bindings.get("s1")).toBe(connector.bindings.defaultAgentId)
    })
  })

  describe("dual-form subscribe (D-2)", () => {
    it("subscribeGlobal fans out only to backends with globalEvents", () => {
      connector.subscribeGlobal(() => {})
      expect(opencode.subscribeGlobal).toHaveBeenCalled()
      expect(acp.emitted).toHaveLength(0)
    })

    it("subscribeSession on a default-bound session uses only the default backend", () => {
      connector.subscribeSession("s1", () => {})
      expect(opencode.subscribeSession).toHaveBeenCalledWith("s1", expect.any(Function))
      expect(acp.subscribeSession).not.toHaveBeenCalled()
    })

    it("subscribeSession on an acp-bound session merges both streams", () => {
      connector.bindings.bind("s1", "acp:claude")
      const received: string[] = []
      const unsub = connector.subscribeSession("s1", (e) => received.push(e.type))

      expect(acp.subscribeSession).toHaveBeenCalledWith("s1", expect.any(Function))
      expect(opencode.subscribeSession).toHaveBeenCalledWith("s1", expect.any(Function))

      // sidecar stream delivers message events; opencode stream delivers the
      // canonical session.updated (title rename) — both reach the handler
      acp.emitted.forEach((h) => h({ type: "message.updated", properties: { info: { sessionID: "s1" } } }))
      opencode.emitted.forEach((h) => h({ type: "session.updated", properties: { sessionID: "s1", title: "T" } }))
      expect(received).toEqual(["message.updated", "session.updated"])

      unsub()
      expect(acp.emitted).toHaveLength(0)
      expect(opencode.emitted).toHaveLength(0)
    })
  })

  describe("aggregates", () => {
    it("listAgents merges all backends and tolerates failures", async () => {
      opencode.listAgents = vi.fn(async () => [
        { id: "opencode:default", name: "OpenCode", source: "opencode" as const, status: "available" as const },
      ])
      acp.listAgents = vi.fn(async () => {
        throw new Error("sidecar down")
      })
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const agents = await connector.listAgents()
      errSpy.mockRestore()
      expect(agents).toHaveLength(1)
      expect(agents[0].id).toBe("opencode:default")
    })

    it("dispose disposes every backend", () => {
      connector.dispose()
      expect(opencode.dispose).toHaveBeenCalled()
      expect(acp.dispose).toHaveBeenCalled()
    })
  })
})
