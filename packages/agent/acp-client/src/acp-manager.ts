import { ACPConnection } from "./acp-connection"
import type { ACPAgentConfig, ACPAgentInfo, ACPSessionInfo } from "./types"

const CONFIG_PATH = `${process.env.HOME}/.config/ultrawork/agents.json`

interface AgentsFile {
  agents?: Record<string, Omit<ACPAgentConfig, "id">>
  default?: string
}

/**
 * Manages all ACP agent connections and sessions.
 */
export class ACPManager {
  private connections: Map<string, ACPConnection> = new Map()
  private sessions: Map<string, { agentId: string; createdAt: number }> = new Map()
  private configs: Map<string, ACPAgentConfig> = new Map()

  /** Load agent configs from ~/.config/ultrawork/agents.json */
  async loadConfigs(): Promise<void> {
    try {
      const file = Bun.file(CONFIG_PATH)
      if (!await file.exists()) {
        console.log("[ACP] No agents.json found, no external agents configured")
        return
      }
      const data: AgentsFile = await file.json()
      if (!data.agents || typeof data.agents !== "object") return

      for (const [id, config] of Object.entries(data.agents)) {
        // Validate required fields
        if (!config.command || typeof config.command !== "string") {
          console.error(`[ACP] Agent "${id}": missing or invalid "command" field, skipping`)
          continue
        }
        if (!config.label || typeof config.label !== "string") {
          console.error(`[ACP] Agent "${id}": missing or invalid "label" field, skipping`)
          continue
        }
        const agentConfig: ACPAgentConfig = {
          id,
          label: config.label,
          description: config.description,
          command: config.command,
          args: Array.isArray(config.args) ? config.args : [],
          env: config.env && typeof config.env === "object" ? config.env : undefined,
        }
        this.configs.set(id, agentConfig)
        this.connections.set(id, new ACPConnection(agentConfig))
      }
      console.log(`[ACP] Loaded ${this.configs.size} agent config(s)`)
    } catch (err) {
      console.error(`[ACP] Failed to load ${CONFIG_PATH}:`, err)
    }
  }

  /** Get all registered agents with their current status */
  getAgents(): ACPAgentInfo[] {
    const result: ACPAgentInfo[] = []
    for (const [id, conn] of this.connections) {
      const config = this.configs.get(id)!
      result.push({
        id,
        label: config.label,
        description: config.description,
        status: conn.status,
        error: conn.error,
        protocolVersion: conn.protocolVersion,
      })
    }
    return result
  }

  /** Get a specific agent's info */
  getAgent(agentId: string): ACPAgentInfo | undefined {
    const conn = this.connections.get(agentId)
    const config = this.configs.get(agentId)
    if (!conn || !config) return undefined
    return {
      id: agentId,
      label: config.label,
      description: config.description,
      status: conn.status,
      error: conn.error,
      protocolVersion: conn.protocolVersion,
    }
  }

  /** Connect to an agent (spawn subprocess + initialize) */
  async connect(agentId: string): Promise<void> {
    const conn = this.connections.get(agentId)
    if (!conn) throw new Error(`Agent "${agentId}" not found`)
    await conn.connect()
  }

  /** Disconnect an agent */
  async disconnect(agentId: string): Promise<void> {
    const conn = this.connections.get(agentId)
    if (!conn) throw new Error(`Agent "${agentId}" not found`)
    // Clean up sessions for this agent
    for (const [sessionId, info] of this.sessions) {
      if (info.agentId === agentId) {
        conn.offSessionEvent(sessionId)
        this.sessions.delete(sessionId)
      }
    }
    await conn.disconnect()
  }

  /** Create a new session with an agent */
  async createSession(agentId: string, cwd: string): Promise<string> {
    const conn = this.connections.get(agentId)
    if (!conn) throw new Error(`Agent "${agentId}" not found`)

    // Auto-connect if not already
    if (conn.status !== "connected") {
      await conn.connect()
    }

    const sessionId = await conn.newSession(cwd)
    this.sessions.set(sessionId, { agentId, createdAt: Date.now() })
    return sessionId
  }

  /** Send a prompt to a session */
  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const info = this.sessions.get(sessionId)
    if (!info) throw new Error(`Session "${sessionId}" not found`)
    const conn = this.connections.get(info.agentId)
    if (!conn) throw new Error(`Agent "${info.agentId}" not found`)
    return conn.prompt(sessionId, text)
  }

  /** Cancel a prompt in a session */
  async cancel(sessionId: string): Promise<void> {
    const info = this.sessions.get(sessionId)
    if (!info) throw new Error(`Session "${sessionId}" not found`)
    const conn = this.connections.get(info.agentId)
    if (!conn) throw new Error(`Agent "${info.agentId}" not found`)
    await conn.cancel(sessionId)
  }

  /** Get the connection for a session (for SSE subscriptions) */
  getConnectionForSession(sessionId: string): ACPConnection | undefined {
    const info = this.sessions.get(sessionId)
    if (!info) return undefined
    return this.connections.get(info.agentId)
  }

  /** Get session info */
  getSession(sessionId: string): ACPSessionInfo | undefined {
    const info = this.sessions.get(sessionId)
    if (!info) return undefined
    return { sessionId, agentId: info.agentId, createdAt: info.createdAt }
  }

  /** Add or update an agent config and save to disk */
  async saveAgent(config: ACPAgentConfig): Promise<void> {
    // Disconnect old connection if exists
    if (this.connections.has(config.id)) {
      await this.disconnect(config.id).catch(() => {})
    }
    this.configs.set(config.id, config)
    this.connections.set(config.id, new ACPConnection(config))
    await this.persistConfigs()
    // Auto-connect the new agent
    this.connect(config.id).catch((err) => {
      console.error(`[ACP] Auto-connect failed for "${config.id}":`, err instanceof Error ? err.message : err)
    })
  }

  /** Remove an agent config and save to disk */
  async removeAgent(agentId: string): Promise<void> {
    if (this.connections.has(agentId)) {
      await this.disconnect(agentId).catch(() => {})
    }
    this.configs.delete(agentId)
    this.connections.delete(agentId)
    await this.persistConfigs()
  }

  /** Reload configs from disk (disconnect removed, connect new) */
  async reloadConfigs(): Promise<void> {
    // Disconnect all current agents
    await this.shutdown()
    this.configs.clear()
    // Reload
    await this.loadConfigs()
    // Auto-connect all
    for (const agent of this.getAgents()) {
      this.connect(agent.id).catch((err) => {
        console.error(`[ACP] Auto-connect failed for "${agent.id}":`, err instanceof Error ? err.message : err)
      })
    }
  }

  /** Get a specific agent's config (for editing) */
  getAgentConfig(agentId: string): ACPAgentConfig | undefined {
    return this.configs.get(agentId)
  }

  /** Write current configs to ~/.config/ultrawork/agents.json */
  private async persistConfigs(): Promise<void> {
    const agents: Record<string, Omit<ACPAgentConfig, "id">> = {}
    for (const [id, config] of this.configs) {
      const { id: _id, ...rest } = config
      agents[id] = rest
    }
    const data: AgentsFile = { agents }
    const dir = CONFIG_PATH.substring(0, CONFIG_PATH.lastIndexOf("/"))
    await Bun.write(CONFIG_PATH, JSON.stringify(data, null, 2) + "\n")
    console.log(`[ACP] Saved ${this.configs.size} agent config(s) to ${CONFIG_PATH}`)
  }

  /** Disconnect all agents and clean up */
  async shutdown(): Promise<void> {
    console.log("[ACP] Shutting down all agents...")
    const promises: Promise<void>[] = []
    for (const [id] of this.connections) {
      promises.push(this.disconnect(id).catch(() => {}))
    }
    await Promise.all(promises)
    this.sessions.clear()
  }
}
