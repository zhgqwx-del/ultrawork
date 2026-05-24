import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react"
import { useAgents, DEFAULT_AGENT_ID } from "./use-agents"
import { useSSESubscribe } from "./sse-context"
import { parseAgentId, makeAgentId } from "./agent-types"
import type { UnifiedAgent } from "./agent-types"
import type { SSEEvent } from "./sse-client"

interface AgentContextValue {
  /** All available agents (OpenCode built-in + future ACP agents) */
  agents: UnifiedAgent[]
  /** Whether agents are still loading */
  loading: boolean
  /** Currently selected agent ID (e.g. "opencode:build") */
  currentAgentId: string
  /** Currently selected agent object, or undefined if not found */
  currentAgent: UnifiedAgent | undefined
  /** Switch to a different agent */
  setCurrentAgent: (agentId: string) => void
  /** Refresh the agent list */
  refreshAgents: () => Promise<void>
  /**
   * Get the raw agent ID to pass to promptAsync.
   * Returns undefined if using default agent (no explicit agent param needed).
   */
  getPromptAgent: () => string | undefined
}

const AgentContext = createContext<AgentContextValue | undefined>(undefined)

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const { agents, loading, refresh } = useAgents()
  const [currentAgentId, setCurrentAgentId] = useState(DEFAULT_AGENT_ID)

  // If current selection becomes invalid (e.g. agent list changed), fall back to default
  useEffect(() => {
    if (!loading && agents.length > 0) {
      const exists = agents.some((a) => a.id === currentAgentId)
      if (!exists) {
        setCurrentAgentId(agents[0]?.id ?? DEFAULT_AGENT_ID)
      }
    }
  }, [agents, loading, currentAgentId])

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === currentAgentId),
    [agents, currentAgentId],
  )

  const setCurrentAgent = useCallback((agentId: string) => {
    setCurrentAgentId(agentId)
  }, [])

  const getPromptAgent = useCallback((): string | undefined => {
    // For OpenCode agents, pass the raw ID (e.g. "build", "plan") to promptAsync
    // For ACP agents (future), routing is handled by AgentRouter, not promptAsync
    const { source, rawId } = parseAgentId(currentAgentId)
    if (source === "opencode") {
      return rawId
    }
    // ACP agents don't use promptAsync — return undefined
    return undefined
  }, [currentAgentId])

  // Detect agent switches from SSE events (e.g. plan_exit creates a synthetic
  // user message with agent: "build", causing the backend to switch agents)
  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      if (event.type !== "message.updated") return
      const { info } = event.properties as { info: { role: string; agent?: string } }
      // Only react to user messages that carry an explicit agent field
      // (synthetic messages created by plan_exit / plan_enter)
      if (info.role !== "user" || !info.agent) return
      const newAgentId = makeAgentId("opencode", info.agent)
      if (newAgentId !== currentAgentId) {
        setCurrentAgentId(newAgentId)
      }
    },
    [currentAgentId],
  )
  useSSESubscribe(handleSSEEvent)

  const value = useMemo(
    () => ({
      agents,
      loading,
      currentAgentId,
      currentAgent,
      setCurrentAgent,
      refreshAgents: refresh,
      getPromptAgent,
    }),
    [agents, loading, currentAgentId, currentAgent, setCurrentAgent, refresh, getPromptAgent],
  )

  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  )
}

export function useAgent() {
  const context = useContext(AgentContext)
  if (!context) {
    throw new Error("useAgent must be used within AgentProvider")
  }
  return context
}
