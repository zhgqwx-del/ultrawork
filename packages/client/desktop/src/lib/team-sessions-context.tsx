// Team-session registry, desktop side (018 统一交互). One workspace-scoped
// snapshot of the sidecar registry, shared by the sidebar (badge + legacy 补显),
// Home (creation) and the Session page (leader prompt injection). The ACP host
// starts after the renderer gate: an unavailable registry is still unknown,
// never proof that a persisted Team is a single-agent session.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useAgents } from "./agent-context"
import { useWorkspace } from "./workspace-context"
import { listTeamSessions, type TeamSessionEntry } from "./orchestration-client"
import { sidecarPortsVersion, subscribeSidecarPorts } from "./sidecar-ports"

export type { TeamSessionEntry }

interface TeamSessionsValue {
  entries: TeamSessionEntry[]
  /** No authoritative snapshot has loaded for the current workspace yet. */
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
  const { bindSessionAgent, acpAvailable } = useAgents()
  const portsVersion = useSyncExternalStore(subscribeSidecarPorts, sidecarPortsVersion)
  const [snapshot, setSnapshot] = useState<{ workspace: string | null; entries: TeamSessionEntry[]; loaded: boolean }>({
    workspace: workspacePath, entries: [], loaded: false,
  })
  const workspaceRef = useRef(workspacePath)
  workspaceRef.current = workspacePath
  const editsRef = useRef({ workspace: workspacePath, revision: 0,
    entries: new Map<string, { revision: number; entry: TeamSessionEntry | null }>(),
  })
  if (editsRef.current.workspace !== workspacePath) {
    editsRef.current = { workspace: workspacePath, revision: 0, entries: new Map() }
  }
  const reloadRef = useRef<(() => Promise<void>) | undefined>(undefined)
  // Do not expose the old workspace's Team identity for even the render before
  // the effect cleanup. Failed background reads retain a known snapshot.
  const entries = snapshot.workspace === workspacePath ? snapshot.entries : []
  const loading = !!workspacePath && (snapshot.workspace !== workspacePath || !snapshot.loaded)

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

  const refresh = useCallback(() => reloadRef.current?.() ?? Promise.resolve(), [])

  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let request: AbortController | undefined
    let inFlight: Promise<void> | undefined
    let failures = 0
    const current = () => !cancelled && workspaceRef.current === workspacePath
    const load = (): Promise<void> => {
      if (!workspacePath || !current()) return Promise.resolve()
      if (inFlight) return inFlight
      clearTimeout(retry)
      request = new AbortController()
      const controller = request
      const timeout = setTimeout(() => controller.abort(), 10_000)
      deadline = timeout
      const revision = editsRef.current.revision
      inFlight = (async () => {
        try {
          const list = await listTeamSessions(workspacePath, controller.signal)
          if (!current()) return
          const merged = new Map(list.map((entry) => [entry.id, entry]))
          // A stale GET must not erase a newly created Team or resurrect a
          // removed one while that request was in flight.
          for (const [id, edit] of editsRef.current.entries) {
            if (edit.revision <= revision) continue
            if (edit.entry) merged.set(id, edit.entry)
            else merged.delete(id)
          }
          const next = [...merged.values()]
          setSnapshot({ workspace: workspacePath, entries: next, loaded: true })
          bindLeaders(next)
          failures = 0
        } catch {
          if (!current()) return
          // Only unsuccessful reads retry. Success leaves no polling timer;
          // availability/port changes also retry immediately.
          failures += 1
          retry = setTimeout(() => { void load() }, Math.min(1_000 * 2 ** Math.min(failures - 1, 4), 15_000))
        } finally {
          clearTimeout(timeout)
          inFlight = undefined
        }
      })()
      return inFlight
    }
    reloadRef.current = load
    void load()
    return () => {
      cancelled = true
      clearTimeout(retry)
      clearTimeout(deadline)
      request?.abort()
      if (reloadRef.current === load) reloadRef.current = undefined
    }
  }, [workspacePath, bindLeaders, acpAvailable, portsVersion])

  const addEntry = useCallback((entry: TeamSessionEntry) => {
    if (entry.workspace !== workspaceRef.current) return
    const edits = editsRef.current
    edits.entries.set(entry.id, { revision: ++edits.revision, entry })
    setSnapshot((prev) => {
      const list = prev.workspace === edits.workspace ? prev.entries : []
      return { workspace: edits.workspace, loaded: prev.workspace === edits.workspace && prev.loaded,
        entries: list.some((e) => e.id === entry.id) ? list : [entry, ...list] }
    })
  }, [])

  const removeEntry = useCallback((sessionId: string) => {
    const edits = editsRef.current
    edits.entries.set(sessionId, { revision: ++edits.revision, entry: null })
    setSnapshot((prev) => prev.workspace !== edits.workspace ? prev : { ...prev, entries: prev.entries.filter((e) => e.id !== sessionId) })
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
