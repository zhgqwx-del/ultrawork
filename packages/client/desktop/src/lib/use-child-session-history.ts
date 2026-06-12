// Lazy child-session history for orchestration StepCards and delegate cards
// (ADR-031 D-4/D-7: MVP lazy load — no live inlining).
//
// Carries the first batch's hard-won semantics (commit df637e3):
// - ALWAYS refetch on expand — a cached snapshot may be a mid-run capture
//   (last message sealed finish:"tool-calls" renders as "streaming" forever).
// - Refetch on the running→terminal transition while expanded.
// - Generation counter: the LAST fetch wins over an in-flight earlier one.

import { useCallback, useEffect, useRef, useState } from "react"
import type { SendMessageResponse } from "@agent/api-client"
import {
  ACP_BACKEND_KIND,
  OPENCODE_BACKEND_KIND,
  isACPAgentId,
  type AgentBackend,
} from "@agent/connector"
import { useConnector } from "@/lib/sse-context"

export function useChildSessionHistory(opts: {
  /** Namespaced agent id of the child session — dispatches the backend
   * explicitly (children are not in the BindingStore; the default-backend
   * fallback would mis-route ACP children to opencode). */
  agentId: string
  sessionId: string | undefined
  /** Child turn reached a terminal state (step/delegate finished). */
  terminal: boolean
  expanded: boolean
}) {
  const { agentId, sessionId, terminal, expanded } = opts
  const connector = useConnector()
  const [messages, setMessages] = useState<SendMessageResponse[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadGenRef = useRef(0)
  const messagesRef = useRef<SendMessageResponse[] | null>(null)
  messagesRef.current = messages

  const loadHistory = useCallback(async () => {
    if (!sessionId) return
    const gen = ++loadGenRef.current
    try {
      const backend = connector.getBackend<AgentBackend>(
        isACPAgentId(agentId) ? ACP_BACKEND_KIND : OPENCODE_BACKEND_KIND,
      )
      if (!backend) throw new Error("backend unavailable")
      const result = await backend.fetchHistory(sessionId)
      if (loadGenRef.current !== gen) return
      setMessages(result.messages)
      setLoadError(null)
    } catch (err) {
      if (loadGenRef.current !== gen) return
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [connector, sessionId, agentId])

  // Expand → fetch (every expansion, not just the first).
  useEffect(() => {
    if (expanded) void loadHistory()
  }, [expanded, loadHistory])

  // Terminal transition while expanded → settle the frozen snapshot.
  useEffect(() => {
    if (terminal && expanded && messagesRef.current !== null) void loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal])

  return { messages, loadError }
}
