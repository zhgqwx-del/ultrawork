import { useState, useEffect, useCallback } from "react"
import { useApi } from "./use-api"
import { fromOpenCodeAgent } from "./agent-types"
import type { UnifiedAgent } from "./agent-types"

/** Default agent ID when no agent is selected or API is unavailable */
export const DEFAULT_AGENT_ID = "opencode:build"

/**
 * Fetches OpenCode built-in agents from GET /agent and converts to UnifiedAgent[].
 * In the future, this hook will also merge in external ACP agents.
 */
export function useAgents() {
  const api = useApi()
  const [agents, setAgents] = useState<UnifiedAgent[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const rawAgents = await api.getAgents()
      // Filter: only show primary/all agents that are not hidden
      const visible = rawAgents.filter(
        (a) => a.mode !== "subagent" && a.hidden !== true,
      )
      const unified = visible.map(fromOpenCodeAgent)
      setAgents(unified)
    } catch {
      // Server may not be ready yet — keep empty list
      setAgents([])
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { agents, loading, refresh }
}
