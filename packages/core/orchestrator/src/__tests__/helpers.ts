import { vi } from "vitest"
import {
  BindingStore,
  Connector,
  sessionIdOf,
  type AgentBackend,
  type BackendCapabilities,
  type ConnectorEvent,
  type CreateSessionOptions,
} from "@agent/connector"

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

export interface FakeBackend extends AgentBackend {
  /** Broadcast an event to session subscribers (sessionIdOf-filtered, like the real backends). */
  emit(event: ConnectorEvent): void
  createdSessions: CreateSessionOptions[]
}

export interface FakeBackendOptions {
  kind: string
  /** true = opencode-like (fire-and-forget prompt + idle events); false = ACP-like (blocking prompt). */
  sessionStatus?: boolean
  /** Programmable prompt behavior. opencode-like: emit terminal events here (prompt itself resolves
   * immediately). ACP-like: the returned promise blocking IS the turn. */
  onPrompt?: (sessionId: string, text: string, emit: (event: ConnectorEvent) => void) => void | Promise<void>
}

export function fakeBackend(opts: FakeBackendOptions): FakeBackend {
  const sessionStatus = opts.sessionStatus ?? false
  let sessionCounter = 0
  const handlers = new Set<(event: ConnectorEvent) => void>()
  const emit = (event: ConnectorEvent) => {
    for (const handler of [...handlers]) handler(event)
  }
  const backend: FakeBackend = {
    kind: opts.kind,
    transport: sessionStatus ? "product-native" : "acp-stdio",
    capabilities: { ...baseCapabilities, sessionStatus, globalEvents: sessionStatus },
    createdSessions: [],
    emit,
    createSession: vi.fn(async (o: CreateSessionOptions = {}) => {
      backend.createdSessions.push(o)
      return { id: o.clientSessionId ?? `${opts.kind}-s${++sessionCounter}`, backend: opts.kind }
    }),
    prompt: vi.fn(async (sessionId: string, text: string) => {
      await opts.onPrompt?.(sessionId, text, emit)
    }),
    cancel: vi.fn(async () => {}),
    fetchHistory: vi.fn(async () => ({ messages: [], hasMore: false })),
    deleteSessionState: vi.fn(async () => {}),
    replyPermission: vi.fn(async () => {}),
    subscribeSession: (sessionId: string, handler: (event: ConnectorEvent) => void) => {
      const wrapped = (event: ConnectorEvent) => {
        const sid = sessionIdOf(event)
        if (sid === undefined || sid === sessionId) handler(event)
      }
      handlers.add(wrapped)
      return () => handlers.delete(wrapped)
    },
    subscribeGlobal: sessionStatus
      ? (handler: (event: ConnectorEvent) => void) => {
          handlers.add(handler)
          return () => handlers.delete(handler)
        }
      : undefined,
    listAgents: vi.fn(async () => []),
    status: () => "connected" as const,
    ready: async () => {},
    dispose: vi.fn(),
  }
  return backend
}

export function makeConnector(backends: FakeBackend[]): Connector {
  const connector = new Connector({ bindings: new BindingStore() })
  for (const backend of backends) connector.registerBackend(backend)
  return connector
}

// --- event factories (opencode SSE shapes) ---

export function busyEvent(sessionID: string): ConnectorEvent {
  return { type: "session.status", properties: { sessionID, status: { type: "busy" } } }
}

export function idleEvent(sessionID: string): ConnectorEvent {
  return { type: "session.status", properties: { sessionID, status: { type: "idle" } } }
}

export function finishEvent(sessionID: string, finish = "stop"): ConnectorEvent {
  return {
    type: "message.updated",
    properties: {
      info: { id: `msg-${sessionID}`, sessionID, role: "assistant", time: { created: 1 }, finish },
    },
  } as ConnectorEvent
}

export function sessionErrorEvent(sessionID: string, message: string): ConnectorEvent {
  return { type: "session.error", properties: { sessionID, error: { message } } }
}

export function permissionAskedEvent(sessionID: string): ConnectorEvent {
  return {
    type: "permission.asked",
    properties: { sessionID, id: `perm-${sessionID}`, permission: "bash" },
  } as ConnectorEvent
}

export interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
