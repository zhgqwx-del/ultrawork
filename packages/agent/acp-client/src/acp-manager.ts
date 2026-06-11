// Manager: agent connections registry + session routing + SSE fan-out.

import type { StopReason } from "@agentclientprotocol/sdk"
import { ACPConnection, type PermissionReply } from "./acp-connection.js"
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
  UwSSEEvent,
  UwStoredMessage,
} from "./types.js"

type Subscriber = (event: UwSSEEvent) => void

interface SessionEntry extends ACPSessionInfo {
  /** The agent-side session id (sessionId is the public/client-facing one). */
  acpSessionId: string
  /** Shaped history, folded from the event stream and persisted at turn ends. */
  messages: UwStoredMessage[]
}

export class ACPManager {
  private connections = new Map<string, ACPConnection>()
  private sessions = new Map<string, SessionEntry>()
  private subscribers = new Map<string, Set<Subscriber>>()

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
        messages: persisted.messages,
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
  async createSession(agentId: string, cwd: string, clientSessionId?: string): Promise<string> {
    const conn = this.requireAgent(agentId)
    if (conn.status !== "connected") await conn.connect(cwd)
    const acpSessionId = await conn.newSession(cwd, clientSessionId)
    const sessionId = clientSessionId ?? acpSessionId
    const entry: SessionEntry = {
      sessionId,
      acpSessionId,
      agentId,
      cwd,
      createdAt: Date.now(),
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
    await this.restoreAgentSession(conn, entry)
    return conn.prompt(entry.acpSessionId, text)
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

    if (conn.agentCapabilities?.loadSession) {
      try {
        await conn.loadSession(entry.acpSessionId, entry.cwd, entry.sessionId)
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
    entry.acpSessionId = await conn.newSession(entry.cwd, entry.sessionId)
    this.persist(entry)
  }

  async cancel(sessionId: string): Promise<void> {
    const entry = this.requireSession(sessionId)
    await this.requireAgent(entry.agentId).cancel(entry.acpSessionId)
  }

  getSession(sessionId: string): ACPSessionInfo | undefined {
    return this.sessions.get(sessionId)
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

  async shutdown(): Promise<void> {
    await Promise.all([...this.connections.values()].map((conn) => conn.disconnect()))
  }

  private dispatch(sessionId: string, event: UwSSEEvent): void {
    // Fold into the stored history before fan-out (runs even with no
    // subscriber — persistence must not depend on an open SSE stream).
    const entry = this.sessions.get(sessionId)
    if (entry) {
      applyEvent(entry.messages, event)
      if (isPersistencePoint(event)) this.persist(entry)
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
        messages: entry.messages,
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
