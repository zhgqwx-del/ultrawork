import { useState, useEffect, useCallback } from "react"
import type { Session } from "@agent/api-client"
import { useApi } from "./use-api"

export function useSessions() {
  const api = useApi()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await api.listSessions({ roots: true, limit: 50 })
      setSessions(list)
      setError(null)
    } catch (err) {
      console.error("Failed to load sessions:", err)
      setError(err instanceof Error ? err.message : "Failed to load sessions")
    }
  }, [api])

  useEffect(() => {
    let cancelled = false
    api.listSessions({ roots: true, limit: 50 }).then(list => {
      if (!cancelled) {
        setSessions(list)
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
  }, [api])

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

  return { sessions, loading, error, refresh, createSession, deleteSession }
}
