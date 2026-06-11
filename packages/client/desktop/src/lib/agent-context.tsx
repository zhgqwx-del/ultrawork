// Agent registry + per-session agent binding (ADR-027 档1: one session, one
// agent). The opencode default binding leaves the existing flow untouched.
//
// Bindings live in the Connector's BindingStore (ADR-030): localStorage is a
// warm cache, hydrated from the ACP sidecar's persisted sessions at launch so
// cleared WebView data / another device no longer orphans ACP sessions.

import { createContext, useContext, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import {
  ACPBackend,
  ACP_BACKEND_KIND,
  OPENCODE_DEFAULT_AGENT_ID,
  makeAgentId,
  toBindingEntries,
  type UnifiedAgent,
} from "@agent/connector"
import { useConnector } from "./sse-context"

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

export function AgentProvider({ children }: { children: ReactNode }) {
  const connector = useConnector()
  const [agents, setAgents] = useState<UnifiedAgent[]>([OPENCODE_AGENT])
  const [acpAvailable, setAcpAvailable] = useState(false)
  const refreshing = useRef(false)

  const refreshAgents = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const acp = connector.getBackend<ACPBackend>(ACP_BACKEND_KIND)
      const healthy = acp ? await acp.http.health() : false
      setAcpAvailable(healthy)
      if (!healthy || !acp) {
        setAgents([OPENCODE_AGENT])
        return
      }
      const acpAgents = await acp.http.listAgents()
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
      // Hydrate session↔agent bindings from the sidecar's persisted sessions
      // (sidecar wins over the localStorage cache; best-effort).
      try {
        connector.bindings.hydrate(toBindingEntries(await acp.http.listSessions()))
      } catch (err) {
        console.debug("ACP binding hydration failed:", err)
      }
    } catch {
      setAgents([OPENCODE_AGENT])
    } finally {
      refreshing.current = false
    }
  }, [connector])

  useEffect(() => {
    void refreshAgents()
  }, [refreshAgents])

  // Mirror binding changes into React (stable snapshot via version counter)
  const bindingsVersion = useSyncExternalStore(
    useCallback((cb) => connector.bindings.onChange(cb), [connector]),
    () => connector.bindings.version,
  )

  const getSessionAgentId = useCallback(
    (sessionId: string | undefined) => connector.bindings.get(sessionId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connector, bindingsVersion],
  )

  const bindSessionAgent = useCallback(
    (sessionId: string, agentId: string) => connector.bindings.bind(sessionId, agentId),
    [connector],
  )

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
