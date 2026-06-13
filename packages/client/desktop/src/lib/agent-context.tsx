// Agent registry + per-session agent binding (ADR-027 档1: one session, one
// agent). The opencode default binding leaves the existing flow untouched.
//
// Bindings live in the Connector's BindingStore (ADR-030): localStorage is a
// warm cache, hydrated from the ACP sidecar's persisted sessions at launch so
// cleared WebView data / another device no longer orphans ACP sessions.

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import {
  ACPBackend,
  ACP_BACKEND_KIND,
  OPENCODE_DEFAULT_AGENT_ID,
  makeAgentId,
  toBindingEntries,
  type UnifiedAgent,
} from "@agent/connector"
import { useConnector, useSSEConnected } from "./sse-context"

const OPENCODE_AGENT: UnifiedAgent = {
  id: OPENCODE_DEFAULT_AGENT_ID,
  name: "OpenCode",
  source: "opencode",
  // Placeholder; the live status is derived from the global SSE heartbeat in
  // the provider (the opencode backend has no per-agent health endpoint).
  status: "disconnected",
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
  const sseConnected = useSSEConnected()
  const [agents, setAgents] = useState<UnifiedAgent[]>([OPENCODE_AGENT])
  const [acpAvailable, setAcpAvailable] = useState(false)
  const refreshing = useRef(false)

  // 019 D5b: the opencode default agent's health = the global SSE heartbeat
  // (useSSEConnected), not a hardcoded "available". ACP agents keep their own
  // status from listAgents(). The connection signal surfaces on the
  // AgentSelector trigger chip, replacing the footer WiFi banner.
  const liveAgents = useMemo<UnifiedAgent[]>(
    () =>
      agents.map((a) =>
        a.id === OPENCODE_DEFAULT_AGENT_ID
          ? { ...a, status: sseConnected ? "connected" : "disconnected" }
          : a,
      ),
    [agents, sseConnected],
  )

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

  // 019 D5b follow-up: ACP per-agent status from listAgents() is only a
  // snapshot (refreshed on mount + dropdown open). A lazily-connected agent
  // that just came online via a prompt would otherwise stay gray on the
  // AgentSelector trigger chip until the next dropdown open. Poll the sidecar's
  // per-agent status while it's reachable so the chip dot is eventually
  // consistent (connect / disconnect / error). opencode needs no poll — its
  // dot is driven live by useSSEConnected.
  useEffect(() => {
    if (!acpAvailable) return
    const acp = connector.getBackend<ACPBackend>(ACP_BACKEND_KIND)
    if (!acp) return
    let cancelled = false
    const id = setInterval(async () => {
      try {
        const fresh = await acp.http.listAgents()
        if (cancelled) return
        const byId = new Map(fresh.map((a) => [makeAgentId("acp", a.id), a]))
        setAgents((prev) => {
          let changed = false
          const next = prev.map((a) => {
            const f = byId.get(a.id)
            if (!f || (a.status === f.status && a.error === f.error)) return a
            changed = true
            return { ...a, status: f.status, error: f.error }
          })
          return changed ? next : prev
        })
      } catch {
        // Transient (sidecar busy/restarting); the next tick retries.
      }
    }, 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [acpAvailable, connector])

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
      value={{ agents: liveAgents, acpAvailable, refreshAgents, getSessionAgentId, bindSessionAgent }}
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
