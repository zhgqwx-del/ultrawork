// Agent registry + per-session agent binding (ADR-027 档1: one session, one
// agent). The opencode default binding leaves the existing flow untouched.

import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { fetchACPAgents, checkACPHealth } from "./agent-router"
import { OPENCODE_DEFAULT_AGENT_ID, makeAgentId, type UnifiedAgent } from "./agent-types"

const BINDINGS_STORAGE_KEY = "uw.acp.sessionAgents"

const OPENCODE_AGENT: UnifiedAgent = {
  id: OPENCODE_DEFAULT_AGENT_ID,
  name: "OpenCode",
  source: "opencode",
  status: "available",
}

interface AgentContextValue {
  /** opencode default + ACP agents (when the sidecar is reachable). */
  agents: UnifiedAgent[]
  /** False when the ACP sidecar (:4099) is unreachable. */
  acpAvailable: boolean
  refreshAgents: () => Promise<void>
  /** Agent bound to a session (defaults to opencode). */
  getSessionAgentId: (sessionId: string | undefined) => string
  bindSessionAgent: (sessionId: string, agentId: string) => void
}

const AgentContext = createContext<AgentContextValue | null>(null)

function loadBindings(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(BINDINGS_STORAGE_KEY) ?? "{}") as Record<string, string>
  } catch {
    return {}
  }
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<UnifiedAgent[]>([OPENCODE_AGENT])
  const [acpAvailable, setAcpAvailable] = useState(false)
  const [bindings, setBindings] = useState<Record<string, string>>(loadBindings)
  const refreshing = useRef(false)

  const refreshAgents = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const healthy = await checkACPHealth()
      setAcpAvailable(healthy)
      if (!healthy) {
        setAgents([OPENCODE_AGENT])
        return
      }
      const acpAgents = await fetchACPAgents()
      setAgents([
        OPENCODE_AGENT,
        ...acpAgents.map(
          (a): UnifiedAgent => ({
            id: makeAgentId("acp", a.id),
            name: a.label,
            description: a.description,
            source: "acp",
            status: a.status,
            error: a.error,
          }),
        ),
      ])
    } catch {
      setAgents([OPENCODE_AGENT])
    } finally {
      refreshing.current = false
    }
  }, [])

  useEffect(() => {
    void refreshAgents()
  }, [refreshAgents])

  const getSessionAgentId = useCallback(
    (sessionId: string | undefined) =>
      (sessionId && bindings[sessionId]) || OPENCODE_DEFAULT_AGENT_ID,
    [bindings],
  )

  const bindSessionAgent = useCallback((sessionId: string, agentId: string) => {
    setBindings((prev) => {
      const next = { ...prev }
      if (agentId === OPENCODE_DEFAULT_AGENT_ID) delete next[sessionId]
      else next[sessionId] = agentId
      try {
        localStorage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // storage full/unavailable — binding stays in-memory
      }
      return next
    })
  }, [])

  return (
    <AgentContext.Provider
      value={{ agents, acpAvailable, refreshAgents, getSessionAgentId, bindSessionAgent }}
    >
      {children}
    </AgentContext.Provider>
  )
}

export function useAgents(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error("useAgents must be used within AgentProvider")
  return ctx
}
