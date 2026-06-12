// Team-session registry, desktop side (018 统一交互). One workspace-scoped
// load of the sidecar registry, shared by the sidebar (badge + legacy 补显),
// Home (creation) and the Session page (leader prompt injection). Sidecar
// unreachable degrades to an empty registry — every consumer must keep
// working badge-less.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useAgents } from "./agent-context"
import { useWorkspace } from "./workspace-context"
import { listTeamSessions, type TeamSessionEntry } from "./orchestration-client"

export type { TeamSessionEntry }

interface TeamSessionsValue {
  entries: TeamSessionEntry[]
  loading: boolean
  entryOf: (sessionId: string | undefined) => TeamSessionEntry | undefined
  isTeamSession: (sessionId: string) => boolean
  addEntry: (entry: TeamSessionEntry) => void
  removeEntry: (sessionId: string) => void
  refresh: () => Promise<void>
}

const TeamSessionsContext = createContext<TeamSessionsValue | null>(null)

export function TeamSessionsProvider({ children }: { children: React.ReactNode }) {
  const { workspacePath } = useWorkspace()
  const { bindSessionAgent } = useAgents()
  const [entries, setEntries] = useState<TeamSessionEntry[]>([])
  const [loading, setLoading] = useState(true)

  // ACP leaders need their session→agent binding before the first prompt.
  // Hydration (GET /acp/sessions) covers sessions that already prompted once;
  // binding at registry load covers the rest, so opening straight from the
  // sidebar works (generalizes the old Team tab's open-time rebind).
  const bindLeaders = useCallback(
    (list: TeamSessionEntry[]) => {
      for (const entry of list) {
        if (entry.leaderAgentId.startsWith("acp:")) bindSessionAgent(entry.id, entry.leaderAgentId)
      }
    },
    [bindSessionAgent],
  )

  const refresh = useCallback(async () => {
    try {
      const list = await listTeamSessions(workspacePath ?? undefined)
      setEntries(list)
      bindLeaders(list)
    } catch {
      // sidecar down — keep whatever we have (empty on first load)
    } finally {
      setLoading(false)
    }
  }, [workspacePath, bindLeaders])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listTeamSessions(workspacePath ?? undefined)
      .then((list) => {
        if (cancelled) return
        setEntries(list)
        bindLeaders(list)
      })
      .catch(() => {
        if (!cancelled) setEntries([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspacePath, bindLeaders])

  const addEntry = useCallback((entry: TeamSessionEntry) => {
    setEntries((prev) => (prev.some((e) => e.id === entry.id) ? prev : [entry, ...prev]))
  }, [])

  const removeEntry = useCallback((sessionId: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== sessionId))
  }, [])

  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])
  const entryOf = useCallback(
    (sessionId: string | undefined) => (sessionId ? byId.get(sessionId) : undefined),
    [byId],
  )
  const isTeamSession = useCallback((sessionId: string) => byId.has(sessionId), [byId])

  const value = useMemo(
    () => ({ entries, loading, entryOf, isTeamSession, addEntry, removeEntry, refresh }),
    [entries, loading, entryOf, isTeamSession, addEntry, removeEntry, refresh],
  )

  return <TeamSessionsContext.Provider value={value}>{children}</TeamSessionsContext.Provider>
}

export function useTeamSessions(): TeamSessionsValue {
  const ctx = useContext(TeamSessionsContext)
  if (!ctx) throw new Error("useTeamSessions must be used within TeamSessionsProvider")
  return ctx
}
