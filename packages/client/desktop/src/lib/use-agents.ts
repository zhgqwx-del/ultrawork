import { useState, useEffect, useCallback } from "react"
import { useApi } from "./use-api"
import { fromOpenCodeAgent, makeAgentId } from "./agent-types"
import { fetchACPAgents } from "./agent-router"
import type { UnifiedAgent, AgentStatus } from "./agent-types"
import type { ACPAgentInfo } from "./agent-router"

/** Default agent ID when no agent is selected or API is unavailable */
export const DEFAULT_AGENT_ID = "opencode:build"

/** Convert an ACP agent info (from sidecar) to UnifiedAgent */
function fromACPAgent(agent: ACPAgentInfo): UnifiedAgent {
  const statusMap: Record<string, AgentStatus> = {
    disconnected: "available",
    connecting: "connecting",
    connected: "connected",
    error: "error",
  }
  return {
    id: makeAgentId("acp", agent.id),
    name: agent.label,
    description: agent.description,
    source: "acp",
    status: statusMap[agent.status] ?? "available",
  }
}

/**
 * Fetches agents from both OpenCode (GET /agent) and ACP Sidecar (GET /acp/agents),
 * merges them into a unified list.
 */
export function useAgents() {
  const api = useApi()
  const [agents, setAgents] = useState<UnifiedAgent[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    // Fetch from both sources in parallel
    const [openCodeResult, acpResult] = await Promise.allSettled([
      api.getAgents(),
      fetchACPAgents(),
    ])

    const unified: UnifiedAgent[] = []

    // OpenCode built-in agents
    if (openCodeResult.status === "fulfilled") {
      const visible = openCodeResult.value.filter(
        (a) => a.mode !== "subagent" && a.hidden !== true,
      )
      unified.push(...visible.map(fromOpenCodeAgent))
    }

    // External ACP agents
    if (acpResult.status === "fulfilled") {
      unified.push(...acpResult.value.map(fromACPAgent))
    }

    setAgents(unified)
    setLoading(false)
  }, [api])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { agents, loading, refresh }
}
