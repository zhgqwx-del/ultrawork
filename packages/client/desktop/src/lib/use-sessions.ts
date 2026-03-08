import { useState, useEffect, useCallback } from "react"
import type { Session } from "@agent/api-client"
import { useApi } from "./use-api"
import { useWorkspace } from "./workspace-context"

/** Filter sessions to only those belonging to the current workspace */
function filterByWorkspace(list: Session[], workspacePath: string | null): Session[] {
  if (!workspacePath) return list
  return list.filter((s) => s.directory === workspacePath)
}

export function useSessions() {
  const api = useApi()
  const { workspacePath } = useWorkspace()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set())

  const markSessionActive = useCallback((id: string) => {
    setActiveSessionIds(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const markSessionIdle = useCallback((id: string) => {
    setActiveSessionIds(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    // Update time.updated so StatusIcon can show checkmark (updated - created > 5s)
    setSessions(prev => prev.map(s =>
      s.id === id ? { ...s, time: { ...s.time, updated: Date.now() } } : s
    ))
  }, [])

  const refresh = useCallback(async () => {
    try {
      // Pass directory for server-side filtering + client-side as safety net
      const list = await api.listSessions({
        roots: true,
        limit: 50,
        directory: workspacePath || undefined,
      })
      setSessions(filterByWorkspace(list, workspacePath))
      setError(null)
    } catch (err) {
      console.error("Failed to load sessions:", err)
      setError(err instanceof Error ? err.message : "Failed to load sessions")
    }
  }, [api, workspacePath])

  useEffect(() => {
    let cancelled = false
    api.listSessions({
      roots: true,
      limit: 50,
      directory: workspacePath || undefined,
    }).then(list => {
      if (!cancelled) {
        setSessions(filterByWorkspace(list, workspacePath))
        setError(null)
        setLoading(false)
      }
    }).catch(err => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "Failed to load sessions")
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [api, workspacePath])

  const createSession = useCallback(async () => {
    const session = await api.createSession()
    setSessions(prev => [session as Session, ...prev])
    return session
  }, [api])

  const deleteSession = useCallback(
    async (sessionId: string) => {
      await api.deleteSession(sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    },
    [api]
  )

  const updateSession = useCallback((id: string, updates: Partial<Session>) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === id ? { ...session, ...updates } : session
      )
    )
  }, [])

  const renameSession = useCallback(
    async (sessionId: string, newTitle: string) => {
      await api.updateSession(sessionId, { title: newTitle })
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId ? { ...session, title: newTitle } : session
        )
      )
    },
    [api]
  )

  return { sessions, loading, error, activeSessionIds, refresh, createSession, deleteSession, updateSession, renameSession, markSessionActive, markSessionIdle }
}
