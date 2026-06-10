// Manager: agent connections registry + session routing + SSE fan-out.

import type { StopReason } from "@agentclientprotocol/sdk"
import { ACPConnection } from "./acp-connection.js"
import type { ACPAgentConfig, ACPAgentInfo, ACPSessionInfo, UwSSEEvent } from "./types.js"

type Subscriber = (event: UwSSEEvent) => void

export class ACPManager {
  private connections = new Map<string, ACPConnection>()
  private sessions = new Map<string, ACPSessionInfo>()
  private subscribers = new Map<string, Set<Subscriber>>()

  constructor(configs: ACPAgentConfig[]) {
    for (const config of configs) this.register(config)
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

  disconnect(agentId: string): void {
    this.requireAgent(agentId).disconnect()
    for (const [sessionId, info] of this.sessions) {
      if (info.agentId === agentId) this.sessions.delete(sessionId)
    }
  }

  async createSession(agentId: string, cwd: string): Promise<string> {
    const conn = this.requireAgent(agentId)
    if (conn.status !== "connected") await conn.connect()
    const sessionId = await conn.newSession(cwd)
    this.sessions.set(sessionId, { sessionId, agentId, cwd, createdAt: Date.now() })
    return sessionId
  }

  async prompt(sessionId: string, text: string): Promise<StopReason> {
    return this.requireSessionAgent(sessionId).prompt(sessionId, text)
  }

  async cancel(sessionId: string): Promise<void> {
    await this.requireSessionAgent(sessionId).cancel(sessionId)
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
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

  shutdown(): void {
    for (const conn of this.connections.values()) conn.disconnect()
  }

  private dispatch(sessionId: string, event: UwSSEEvent): void {
    const set = this.subscribers.get(sessionId)
    if (!set) return
    for (const subscriber of set) subscriber(event)
  }

  private requireAgent(agentId: string): ACPConnection {
    const conn = this.connections.get(agentId)
    if (!conn) throw new Error(`Unknown agent: ${agentId}`)
    return conn
  }

  private requireSessionAgent(sessionId: string): ACPConnection {
    const info = this.sessions.get(sessionId)
    if (!info) throw new Error(`Unknown session: ${sessionId}`)
    return this.requireAgent(info.agentId)
  }
}
