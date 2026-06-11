import { OPENCODE_DEFAULT_AGENT_ID, parseAgentId, type BackendKind, type Unsubscribe } from "./types"

/**
 * Pluggable persistence for session↔agent bindings. Desktop injects a
 * localStorage adapter (key "uw.acp.sessionAgents"); gateway passes none.
 * The cache is a warm fallback — the source of truth after hydration is the
 * ACP sidecar's persisted sessions (GET /acp/sessions).
 */
export interface BindingCache {
  load(): Record<string, string>
  save(bindings: Record<string, string>): void
}

export interface BindingStoreOptions {
  cache?: BindingCache
  defaultAgentId?: string
}

/**
 * Session-level backend binding (ADR-030 D-4). Maps sessionId → namespaced
 * agent id ("acp:claude"). Binding to the default agent removes the entry
 * (legacy agent-context.tsx semantics: absence == opencode).
 */
export class BindingStore {
  private bindings: Record<string, string>
  /** Keys mutated locally after construction — hydrate() must not overwrite them. */
  private dirty = new Set<string>()
  private listeners = new Set<() => void>()
  /** Monotonic change counter — a cheap stable snapshot for useSyncExternalStore. */
  private changeVersion = 0

  constructor(private opts: BindingStoreOptions = {}) {
    this.bindings = {}
    if (opts.cache) {
      try {
        const loaded = opts.cache.load()
        if (loaded && typeof loaded === "object") this.bindings = { ...loaded }
      } catch (err) {
        console.error("BindingStore: failed to load cache:", err)
      }
    }
  }

  get defaultAgentId(): string {
    return this.opts.defaultAgentId ?? OPENCODE_DEFAULT_AGENT_ID
  }

  /** Namespaced agent id for a session; default agent when unbound. */
  get(sessionId: string | undefined): string {
    if (!sessionId) return this.defaultAgentId
    return this.bindings[sessionId] ?? this.defaultAgentId
  }

  /** Backend kind for a session (parsed from the binding's namespace). */
  backendOf(sessionId: string | undefined): BackendKind {
    return parseAgentId(this.get(sessionId)).source
  }

  /** Raw (un-namespaced) agent id for a session. */
  rawAgentIdOf(sessionId: string | undefined): string {
    return parseAgentId(this.get(sessionId)).rawId
  }

  bind(sessionId: string, agentId: string): void {
    if (agentId === this.defaultAgentId) {
      delete this.bindings[sessionId]
    } else {
      this.bindings[sessionId] = agentId
    }
    this.dirty.add(sessionId)
    this.persist()
    this.notify()
  }

  remove(sessionId: string): void {
    this.dirty.add(sessionId)
    if (!(sessionId in this.bindings)) return
    delete this.bindings[sessionId]
    this.persist()
    this.notify()
  }

  /**
   * Merge sidecar-persisted bindings (sidecar wins over cache, but local
   * mutations made after construction win over the — possibly stale — sidecar
   * response). Cache-only entries are kept: they cover the window between
   * binding and the first prompt, when the sidecar has no record yet.
   */
  hydrate(entries: Array<{ sessionId: string; agentId: string }>): void {
    let changed = false
    for (const entry of entries) {
      if (this.dirty.has(entry.sessionId)) continue
      if (this.bindings[entry.sessionId] !== entry.agentId) {
        this.bindings[entry.sessionId] = entry.agentId
        changed = true
      }
    }
    if (changed) {
      this.persist()
      this.notify()
    }
  }

  /** Immutable snapshot (stable for useSyncExternalStore-style consumers). */
  snapshot(): Record<string, string> {
    return { ...this.bindings }
  }

  get version(): number {
    return this.changeVersion
  }

  onChange(cb: () => void): Unsubscribe {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private persist(): void {
    if (!this.opts.cache) return
    try {
      this.opts.cache.save({ ...this.bindings })
    } catch (err) {
      console.error("BindingStore: failed to save cache:", err)
    }
  }

  private notify(): void {
    this.changeVersion++
    this.listeners.forEach((cb) => cb())
  }
}
