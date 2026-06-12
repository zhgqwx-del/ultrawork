import { useState, useEffect, useCallback } from "react"
import type { Session } from "@agent/api-client"
import { ApiError } from "@agent/api-client"
import { useApi } from "./use-api"
import { useWorkspace } from "./workspace-context"
import { useConnector, useSSESubscribe } from "./sse-context"

/** Filter sessions to only those belonging to the current workspace */
function filterByWorkspace(list: Session[], workspacePath: string | null): Session[] {
  if (!workspacePath) return list
  return list.filter((s) => s.directory === workspacePath)
}

export function useSessions() {
  const api = useApi()
  const connector = useConnector()
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
    // Guard: SSE session.updated may have already inserted this session
    setSessions(prev =>
      prev.some(s => s.id === session.id) ? prev : [session as Session, ...prev]
    )
    return session
  }, [api])

  const deleteSession = useCallback(
    async (sessionId: string) => {
      // Deletes everywhere by binding: the canonical opencode session (404
      // tolerated — already gone still cleans up locally), any ACP sidecar
      // state (failures swallowed — a dead sidecar must not block deletion),
      // and the session's agent binding.
      await connector.deleteSession(sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    },
    [connector]
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
      try {
        await api.updateSession(sessionId, { title: newTitle })
      } catch (err) {
        // If server returns 404, remove the stale session from local state
        if (err instanceof ApiError && err.status === 404) {
          setSessions((prev) => prev.filter((s) => s.id !== sessionId))
          return
        }
        throw err
      }
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId ? { ...session, title: newTitle } : session
        )
      )
    },
    [api]
  )

  // Listen for SSE session events to keep sidebar in sync
  useSSESubscribe(useCallback((event: { type: string; properties: any }) => {
    if (event.type === "session.updated") {
      const info = event.properties?.info ?? event.properties
      const sid = info?.id ?? info?.sessionID
      if (!sid) return

      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.id === sid)
        if (idx >= 0) {
          // Update existing session (title, time, etc.)
          const updated = { ...prev[idx], ...info }
          const next = [...prev]
          next[idx] = updated
          return next
        }
        // Child sessions (orchestrator children, opencode task subagents)
        // never enter the sidebar — the list endpoint filters roots only.
        if (info.parentID) return prev
        // New session from another source (e.g. channel gateway)
        // Only add if it belongs to current workspace
        if (workspacePath && info.directory && info.directory !== workspacePath) return prev
        // Guard: don't add if already present (race with createSession optimistic insert)
        if (prev.some((s) => s.id === sid)) return prev
        return [info as Session, ...prev]
      })
    } else if (event.type === "session.deleted") {
      const sid = event.properties?.id ?? event.properties?.sessionID
      if (sid) {
        setSessions((prev) => prev.filter((s) => s.id !== sid))
      }
    }
  }, [workspacePath]))

  return { sessions, loading, error, activeSessionIds, refresh, createSession, deleteSession, updateSession, renameSession, markSessionActive, markSessionIdle }
}
