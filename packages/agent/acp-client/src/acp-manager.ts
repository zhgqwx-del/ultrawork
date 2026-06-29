// Manager: agent connections registry + session routing + SSE fan-out.

import type { StopReason } from "@agentclientprotocol/sdk"
import { ACPConnection, supportsMetaSystemPrompt, type PermissionReply } from "./acp-connection.js"
import { deleteAgentConfig, saveAgentConfig } from "./agents-config.js"
import {
  applyEvent,
  deleteSessionFile,
  isPersistencePoint,
  loadAllSessions,
  saveSession,
} from "./session-store.js"
import type {
  ACPAgentConfig,
  ACPAgentInfo,
  ACPSessionInfo,
  UwPlanStep,
  UwSSEEvent,
  UwStoredMessage,
} from "./types.js"

type Subscriber = (event: UwSSEEvent) => void

interface SessionEntry extends ACPSessionInfo {
  /** The agent-side session id (sessionId is the public/client-facing one). */
  acpSessionId: string
  /** Shaped history, folded from the event stream and persisted at turn ends. */
  messages: UwStoredMessage[]
  /** Latest task plan (ADR-038), folded from plan.updated; served as a snapshot. */
  plan?: UwPlanStep[]
}

export class ACPManager {
  private connections = new Map<string, ACPConnection>()
  private sessions = new Map<string, SessionEntry>()
  private subscribers = new Map<string, Set<Subscriber>>()
  /** Cross-session lifecycle (session.status busy/idle) — served on the global
   * SSE stream, kept off per-session streams + history fold (discussions/022). */
  private globalSubscribers = new Set<Subscriber>()
  /** Sessions with a prompt currently in flight — the source for the
   * snapshot-on-subscribe so busy survives an SSE reconnect / WebView reload. */
  private running = new Set<string>()

  constructor(configs: ACPAgentConfig[]) {
    for (const config of configs) this.register(config)
    // W4b: restore persisted sessions so history survives sidecar restarts.
    // Agent-side context is restored lazily at the next prompt (session/load).
    for (const persisted of loadAllSessions()) {
      this.sessions.set(persisted.sessionId, {
        sessionId: persisted.sessionId,
        acpSessionId: persisted.acpSessionId,
        agentId: persisted.agentId,
        cwd: persisted.cwd,
        createdAt: persisted.createdAt,
        // Pre-flag files (undefined) fall back to the agent-level default at
        // restore time, so enabling orchestratorMcp also covers old sessions.
        orchestrate: persisted.orchestrate,
        systemPrompt: persisted.systemPrompt,
        messages: persisted.messages,
        plan: persisted.plan,
      })
    }
  }

  register(config: ACPAgentConfig): void {
    this.connections.set(
      config.id,
      new ACPConnection(config, (sessionId, event) => this.dispatch(sessionId, event)),
    )
  }

  listAgents(): ACPAgentInfo[] {
    return [...this.connections.values()].map((conn) => ({
      id: conn.config.id,
      label: conn.config.label,
      description: conn.config.description,
      status: conn.status,
      error: conn.error,
      protocolVersion: conn.protocolVersion,
      capabilities: conn.agentCapabilities
        ? {
            loadSession: conn.agentCapabilities.loadSession ?? false,
            image: conn.agentCapabilities.promptCapabilities?.image ?? false,
            audio: conn.agentCapabilities.promptCapabilities?.audio ?? false,
            embeddedContext: conn.agentCapabilities.promptCapabilities?.embeddedContext ?? false,
          }
        : undefined,
    }))
  }

  async connect(agentId: string): Promise<void> {
    await this.requireAgent(agentId).connect()
  }

  async disconnect(agentId: string): Promise<void> {
    // Session entries survive a disconnect: they are persisted and the next
    // prompt restores the agent-side context via session/load (or a fresh
    // session as fallback).
    await this.requireAgent(agentId).disconnect()
  }

  /**
   * Create a session. With `clientSessionId` (the desktop's own session id),
   * all shaped events carry that id and the caller addresses the session by
   * it — the frontend needs no id translation at all.
   */
  async createSession(
    agentId: string,
    cwd: string,
    clientSessionId?: string,
    opts?: { orchestrate?: boolean; systemPrompt?: string },
  ): Promise<string> {
    const conn = this.requireAgent(agentId)
    if (conn.status !== "connected") await conn.connect(cwd)
    // Per-session delegate MCP injection (ADR-031 D-3): explicit override
    // wins, else the agent-level default. Orchestrator children pass an
    // explicit false (InProcACPBackend) — the recursion guard.
    const orchestrate = opts?.orchestrate ?? conn.config.orchestratorMcp ?? false
    const systemPrompt = opts?.systemPrompt
    const acpSessionId = await conn.newSession(cwd, clientSessionId, { orchestrate, systemPrompt })
    const sessionId = clientSessionId ?? acpSessionId
    const entry: SessionEntry = {
      sessionId,
      acpSessionId,
      agentId,
      cwd,
      createdAt: Date.now(),
      orchestrate,
      systemPrompt,
      messages: [],
    }
    this.sessions.set(sessionId, entry)
    // Persist the mapping right away so a crash mid-conversation still leaves
    // the session restorable.
    this.persist(entry)
    return sessionId
  }

  async prompt(sessionId: string, text: string): Promise<StopReason> {
    const entry = this.requireSession(sessionId)
    const conn = this.requireAgent(entry.agentId)
    // Bracket the whole turn with busy/idle on the global stream so the desktop's
    // app-level activeSessionIds survives switching away mid-turn (discussions/022,
    // mirrors opencode's session.status). Emitted before restore so a slow
    // session/load still shows busy immediately; the finally guarantees a matching
    // idle even if restore/prompt throws.
    this.emitStatus(sessionId, "busy")
    try {
      await this.restoreAgentSession(conn, entry)
      // Fallback system-prompt delivery for agents without _meta.systemPrompt:
      // prefix the FIRST prompt only (later turns already have it in context).
      // Residual gap (accepted): a load-failure fresh session on such an agent
      // restarts mid-history and never re-receives the prefix.
      const needsPrefix =
        entry.systemPrompt && !supportsMetaSystemPrompt(conn.config) && entry.messages.length === 0
      return await conn.prompt(
        entry.acpSessionId,
        text,
        needsPrefix ? { systemPrefix: entry.systemPrompt } : undefined,
      )
    } finally {
      this.emitStatus(sessionId, "idle")
    }
  }

  /**
   * Ensure the agent-side session behind `entry` is live (W4b). After a
   * sidecar/agent restart the persisted mapping survives but the connection
   * has no shaper for it: restore the agent context via session/load (replay
   * suppressed), falling back to a fresh session when the agent can't load
   * (capability off, or the agent itself lost the session).
   */
  private async restoreAgentSession(conn: ACPConnection, entry: SessionEntry): Promise<void> {
    if (conn.status !== "connected") await conn.connect(entry.cwd)
    if (conn.hasSession(entry.acpSessionId)) return

    // Re-inject the delegate MCP across restarts; sessions persisted before
    // the flag existed inherit the agent-level default.
    const orchestrate = entry.orchestrate ?? conn.config.orchestratorMcp ?? false
    const systemPrompt = entry.systemPrompt
    if (conn.agentCapabilities?.loadSession) {
      try {
        await conn.loadSession(entry.acpSessionId, entry.cwd, entry.sessionId, {
          orchestrate,
          systemPrompt,
        })
        return
      } catch (err) {
        console.error(
          `[acp:${entry.agentId}] session/load failed for ${entry.acpSessionId}, starting fresh:`,
          err,
        )
      }
    } else {
      console.error(
        `[acp:${entry.agentId}] agent has no loadSession capability — continuing ${entry.sessionId} without prior context`,
      )
    }
    entry.acpSessionId = await conn.newSession(entry.cwd, entry.sessionId, {
      orchestrate,
      systemPrompt,
    })
    this.persist(entry)
  }

  async cancel(sessionId: string): Promise<void> {
    const entry = this.requireSession(sessionId)
    await this.requireAgent(entry.agentId).cancel(entry.acpSessionId)
  }

  getSession(sessionId: string): ACPSessionInfo | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * All known sessions (memory map, restored from disk at startup). The
   * desktop hydrates its session↔agent bindings from this at launch, so a
   * cleared WebView localStorage no longer orphans ACP sessions (ADR-030).
   */
  listSessions(): ACPSessionInfo[] {
    return [...this.sessions.values()].map((entry) => ({
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      orchestrate: entry.orchestrate,
      systemPrompt: entry.systemPrompt,
    }))
  }

  getAgentConfig(agentId: string): ACPAgentConfig | undefined {
    return this.connections.get(agentId)?.config
  }

  /** Persist + (re)register an agent; an existing connection is replaced. */
  saveAgent(config: ACPAgentConfig): void {
    saveAgentConfig(config)
    void this.connections.get(config.id)?.disconnect()
    this.register(config)
  }

  async deleteAgent(agentId: string): Promise<void> {
    const conn = this.requireAgent(agentId)
    this.connections.delete(agentId)
    deleteAgentConfig(agentId)
    for (const [sessionId, info] of this.sessions) {
      if (info.agentId === agentId) {
        this.sessions.delete(sessionId)
        deleteSessionFile(sessionId)
      }
    }
    await conn.disconnect()
  }

  /** Route a permission-dock reply to the connection holding the request. */
  replyPermission(sessionId: string, permissionId: string, reply: PermissionReply): boolean {
    const entry = this.sessions.get(sessionId)
    if (entry) {
      const conn = this.connections.get(entry.agentId)
      if (conn?.replyPermission(permissionId, reply)) return true
    }
    for (const conn of this.connections.values()) {
      if (conn.hasPendingPermission(permissionId)) return conn.replyPermission(permissionId, reply)
    }
    return false
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Shaped history for a session (W4b), in the desktop's render shape. */
  getMessages(sessionId: string): UwStoredMessage[] | undefined {
    return this.sessions.get(sessionId)?.messages
  }

  /** Latest task-plan snapshot for a session (ADR-038). [] when none/unknown. */
  getPlan(sessionId: string): UwPlanStep[] {
    return this.sessions.get(sessionId)?.plan ?? []
  }

  /** Drop a session and its persisted history. Returns false if unknown. */
  deleteSession(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId)
    deleteSessionFile(sessionId)
    return existed
  }

  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    let set = this.subscribers.get(sessionId)
    if (!set) {
      set = new Set()
      this.subscribers.set(sessionId, set)
    }
    set.add(subscriber)
    return () => {
      set.delete(subscriber)
      if (set.size === 0) this.subscribers.delete(sessionId)
    }
  }

  /** Subscribe to cross-session lifecycle events (session.status busy/idle). */
  subscribeGlobal(subscriber: Subscriber): () => void {
    this.globalSubscribers.add(subscriber)
    // Snapshot-on-subscribe (mirrors delegate.snapshot): a fresh OR reconnecting
    // client immediately learns which sessions are mid-turn, so a busy marker
    // survives an SSE reconnect or a WebView reload during a turn — and isn't
    // lost just because the busy transition predated this subscription
    // (discussions/022, closes the ACP cold-start gap on app reload).
    for (const sessionId of this.running) {
      subscriber({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } })
    }
    return () => {
      this.globalSubscribers.delete(subscriber)
    }
  }

  /** Broadcast a session busy/idle transition to global subscribers only.
   * Keeps `running` in lock-step so subscribeGlobal can snapshot the live set. */
  private emitStatus(sessionId: string, type: "busy" | "idle"): void {
    if (type === "busy") this.running.add(sessionId)
    else this.running.delete(sessionId)
    const event: UwSSEEvent = {
      type: "session.status",
      properties: { sessionID: sessionId, status: { type } },
    }
    for (const subscriber of this.globalSubscribers) subscriber(event)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.connections.values()].map((conn) => conn.disconnect()))
  }

  private dispatch(sessionId: string, event: UwSSEEvent): void {
    // Fold into the stored history before fan-out (runs even with no
    // subscriber — persistence must not depend on an open SSE stream).
    const entry = this.sessions.get(sessionId)
    if (entry) {
      // Plan is session-level state, not a message — fold it onto the entry
      // (whole list) and persist so switch-back / restart still shows it.
      if (event.type === "plan.updated") {
        entry.plan = event.properties.entries
        this.persist(entry)
      } else {
        applyEvent(entry.messages, event)
        if (isPersistencePoint(event)) this.persist(entry)
      }
    }
    const set = this.subscribers.get(sessionId)
    if (!set) return
    for (const subscriber of set) subscriber(event)
  }

  private persist(entry: SessionEntry): void {
    try {
      saveSession({
        version: 1,
        sessionId: entry.sessionId,
        acpSessionId: entry.acpSessionId,
        agentId: entry.agentId,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        updatedAt: Date.now(),
        orchestrate: entry.orchestrate,
        systemPrompt: entry.systemPrompt,
        messages: entry.messages,
        plan: entry.plan,
      })
    } catch (err) {
      console.error(`[acp] failed to persist session ${entry.sessionId}:`, err)
    }
  }

  private requireAgent(agentId: string): ACPConnection {
    const conn = this.connections.get(agentId)
    if (!conn) throw new Error(`Unknown agent: ${agentId}`)
    return conn
  }

  private requireSession(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`Unknown session: ${sessionId}`)
    return entry
  }
}
