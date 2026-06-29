import type { PlanStep } from "@agent/api-client"
import { BindingStore } from "./binding-store"
import type { ConnectorEvent } from "./events"
import { OPENCODE_BACKEND_KIND } from "./backends/opencode"
import {
  parseAgentId,
  type AgentBackend,
  type BackendCapabilities,
  type BackendKind,
  type ConnectionStatus,
  type ConnectorHooks,
  type CreateSessionOptions,
  type FetchHistoryOptions,
  type FetchHistoryResult,
  type PermissionReply,
  type PromptOptions,
  type SessionRef,
  type UnifiedAgent,
  type Unsubscribe,
} from "./types"

export interface ConnectorOptions {
  /** Default backend for unbound sessions (ADR-030 D-4). Default: "opencode". */
  defaultBackend?: BackendKind
  bindings?: BindingStore
  /** Lifecycle mount points (D-7) — e.g. memory injection attaches here. */
  hooks?: ConnectorHooks
}

/**
 * Backend-agnostic control plane (ADR-030 D-1): call (REST semantics) +
 * subscribe (event stream), dispatched per session binding. Consumers never
 * touch protocol/process details; the core surface here is also the stage-3
 * orchestrator primitive set (spawn/steer/await/cancel, D-6).
 */
export class Connector {
  readonly bindings: BindingStore
  private backends = new Map<BackendKind, AgentBackend>()
  private readonly defaultKind: BackendKind

  private hooks: ConnectorHooks

  constructor(opts: ConnectorOptions = {}) {
    this.defaultKind = opts.defaultBackend ?? OPENCODE_BACKEND_KIND
    this.bindings = opts.bindings ?? new BindingStore()
    this.hooks = opts.hooks ?? {}
  }

  // --- backend registry (open, D-8) ---

  registerBackend(backend: AgentBackend): void {
    this.backends.set(backend.kind, backend)
  }

  getBackend<T extends AgentBackend = AgentBackend>(kind: BackendKind): T | undefined {
    return this.backends.get(kind) as T | undefined
  }

  /** Resolve the backend a session is bound to; falls back to the default backend. */
  backendFor(sessionId: string | undefined): AgentBackend {
    const kind = this.bindings.backendOf(sessionId)
    const backend = this.backends.get(kind) ?? this.backends.get(this.defaultKind)
    if (!backend) {
      throw new Error(`No backend registered for "${kind}" (default "${this.defaultKind}" missing too)`)
    }
    return backend
  }

  capabilitiesOf(sessionId: string | undefined): BackendCapabilities {
    return this.backendFor(sessionId).capabilities
  }

  // --- unified control surface (dispatched by session binding, D-4) ---

  async createSession(opts: CreateSessionOptions & { backend?: BackendKind } = {}): Promise<SessionRef> {
    const kind = opts.backend ?? (opts.agentId ? parseAgentId(opts.agentId).source : this.defaultKind)
    const backend = this.backends.get(kind)
    if (!backend) throw new Error(`No backend registered for "${kind}"`)
    const ref = await backend.createSession(opts)
    if (opts.agentId && opts.agentId !== this.bindings.defaultAgentId) {
      this.bindings.bind(ref.id, opts.agentId)
    }
    await this.hooks.onSessionCreate?.(ref)
    return ref
  }

  prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<void> {
    return this.backendFor(sessionId).prompt(sessionId, text, {
      ...opts,
      boundAgentId: this.bindings.rawAgentIdOf(sessionId),
    })
  }

  cancel(sessionId: string): Promise<void> {
    return this.backendFor(sessionId).cancel(sessionId)
  }

  async revert(sessionId: string, messageID: string): Promise<void> {
    const backend = this.backendFor(sessionId)
    if (!backend.capabilities.revert || !backend.revert) {
      throw new Error(`Backend "${backend.kind}" does not support revert`)
    }
    await backend.revert(sessionId, messageID)
  }

  fetchHistory(sessionId: string, opts?: FetchHistoryOptions): Promise<FetchHistoryResult> {
    return this.backendFor(sessionId).fetchHistory(sessionId, opts)
  }

  /**
   * Current task-plan snapshot for a session (ADR-038). Hydrates the plan
   * panel on open / switch-back. Returns [] for backends without plan support.
   */
  getPlan(sessionId: string): Promise<PlanStep[]> {
    const backend = this.backendFor(sessionId)
    if (!backend.capabilities.plan || !backend.getPlan) return Promise.resolve([])
    return backend.getPlan(sessionId)
  }

  replyPermission(sessionId: string, permissionId: string, reply: PermissionReply): Promise<void> {
    return this.backendFor(sessionId).replyPermission(sessionId, permissionId, reply)
  }

  /**
   * Delete a session everywhere: the canonical session lives on the default
   * backend (opencode sidebar entry) even when bound elsewhere; the bound
   * backend holds the shaped history (ACP sidecar persistence).
   */
  async deleteSession(sessionId: string): Promise<void> {
    const bound = this.backendFor(sessionId)
    if (bound.kind !== this.defaultKind) {
      const def = this.backends.get(this.defaultKind)
      if (def) await def.deleteSessionState(sessionId)
    }
    await bound.deleteSessionState(sessionId)
    this.bindings.remove(sessionId)
  }

  // --- events (dual-form subscribe, ADR-030 D-2) ---

  /** Fan out over every backend with a global stream (opencode + ACP). */
  subscribeGlobal(handler: (event: ConnectorEvent) => void): Unsubscribe {
    const unsubs: Unsubscribe[] = []
    for (const backend of this.backends.values()) {
      if (backend.capabilities.globalEvents && backend.subscribeGlobal) {
        unsubs.push(backend.subscribeGlobal(handler))
      }
    }
    return () => unsubs.forEach((u) => u())
  }

  /**
   * Per-session events. For sessions bound to a non-default backend this
   * merges two streams: the bound backend's own stream (messages/permissions)
   * AND the default backend's global stream filtered to this session — the
   * canonical session record (title rename, deletion) lives there.
   */
  subscribeSession(sessionId: string, handler: (event: ConnectorEvent) => void): Unsubscribe {
    const bound = this.backendFor(sessionId)
    const unsubs: Unsubscribe[] = [bound.subscribeSession(sessionId, handler)]
    if (bound.kind !== this.defaultKind) {
      const def = this.backends.get(this.defaultKind)
      if (def && def.capabilities.globalEvents) {
        unsubs.push(def.subscribeSession(sessionId, handler))
      }
    }
    return () => unsubs.forEach((u) => u())
  }

  // --- aggregate surfaces ---

  async listAgents(): Promise<UnifiedAgent[]> {
    const results = await Promise.all(
      [...this.backends.values()].map((b) =>
        b.listAgents().catch((err) => {
          console.error(`listAgents failed for backend "${b.kind}":`, err)
          return [] as UnifiedAgent[]
        }),
      ),
    )
    return results.flat()
  }

  onStatusChange(cb: (kind: BackendKind, status: ConnectionStatus) => void): Unsubscribe {
    const unsubs: Unsubscribe[] = []
    for (const backend of this.backends.values()) {
      if (backend.onStatusChange) {
        unsubs.push(backend.onStatusChange((status) => cb(backend.kind, status)))
      }
    }
    return () => unsubs.forEach((u) => u())
  }

  /**
   * Dispose backend connections. The registry is intentionally kept: React
   * StrictMode re-runs effects after cleanup, and a re-setup must still find
   * its backends (backends reconnect lazily via connectGlobal/subscribe).
   */
  dispose(): void {
    for (const backend of this.backends.values()) backend.dispose()
  }
}
