import { useState, useEffect, useCallback, useRef } from "react"
import type { Session } from "@agent/api-client"
import { ApiError } from "@agent/api-client"
import { useApi } from "./use-api"
import { useWorkspace } from "./workspace-context"
import { useConnector, useSSESubscribe } from "./sse-context"
import { useTeamSessions, type TeamSessionEntry } from "./team-sessions-context"
import { deleteTeamSession } from "./orchestration-client"
import { applyMessageEventToCache, forgetMessageCacheSession } from "./use-session-messages"

/** Filter sessions to only those belonging to the current workspace */
function filterByWorkspace(list: Session[], workspacePath: string | null): Session[] {
  if (!workspacePath) return list
  return list.filter((s) => s.directory === workspacePath)
}

/**
 * Registry entries that need 补显: legacy (pre-018) team sessions hang off the
 * hidden "[team]" parent, so the roots-only list misses them. vendor PATCH
 * can't change parentID, so they are fetched by id and merged instead.
 */
export function pickLegacyTeamEntries(
  entries: TeamSessionEntry[],
  presentIds: ReadonlySet<string>,
  attemptedIds: ReadonlySet<string>,
): TeamSessionEntry[] {
  return entries.filter((e) => !presentIds.has(e.id) && !attemptedIds.has(e.id))
}

/** Merge fetched legacy sessions, dedup by id (SSE may have raced us), newest-updated first. */
export function mergeLegacySessions(current: Session[], fetched: Session[]): Session[] {
  const have = new Set(current.map((s) => s.id))
  const add = fetched.filter((s) => !have.has(s.id))
  if (add.length === 0) return current
  return [...current, ...add].sort((a, b) => b.time.updated - a.time.updated)
}

export function useSessions() {
  const api = useApi()
  const connector = useConnector()
  const { workspacePath } = useWorkspace()
  const { entries: teamEntries, isTeamSession, removeEntry: removeTeamEntry } = useTeamSessions()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set())

  // Team ids as a ref: the SSE handler reads them without resubscribing.
  const teamIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    teamIdsRef.current = new Set(teamEntries.map((e) => e.id))
  }, [teamEntries])

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
    // Update time.updated so StatusIcon can show checkmark (updated - created > 5s).
    // Skip entirely for ids not in the sidebar list (child/subagent/cross-workspace
    // sessions that the global session.status stream also reports) — they'd return
    // a fresh array every idle and churn the list for no visible change.
    setSessions(prev =>
      prev.some(s => s.id === id)
        ? prev.map(s => (s.id === id ? { ...s, time: { ...s.time, updated: Date.now() } } : s))
        : prev,
    )
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

  // Legacy team-session 补显 (018 A-4 fallback). attempted-set keyed per
  // workspace prevents refetch loops; orphaned registry entries (the opencode
  // session was deleted out-of-band) self-prune best-effort.
  const legacyAttemptedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    legacyAttemptedRef.current = new Set()
  }, [workspacePath])

  useEffect(() => {
    if (loading) return
    const missing = pickLegacyTeamEntries(
      teamEntries,
      new Set(sessions.map((s) => s.id)),
      legacyAttemptedRef.current,
    )
    if (missing.length === 0) return
    for (const entry of missing) legacyAttemptedRef.current.add(entry.id)
    let cancelled = false
    void Promise.allSettled(missing.map((entry) => api.getSession(entry.id))).then((results) => {
      if (cancelled) return
      const fetched: Session[] = []
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          fetched.push(result.value as Session)
        } else if (result.reason instanceof ApiError && result.reason.status === 404) {
          removeTeamEntry(missing[i].id)
          void deleteTeamSession(missing[i].id).catch(() => {})
        }
      })
      if (fetched.length > 0) setSessions((prev) => mergeLegacySessions(prev, fetched))
    })
    return () => { cancelled = true }
  }, [teamEntries, sessions, loading, api, removeTeamEntry])

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
      if (isTeamSession(sessionId)) {
        // Team sessions delete through the sidecar registry endpoint, which
        // cleans all three: registry entry + ACP session + opencode session.
        await deleteTeamSession(sessionId)
        removeTeamEntry(sessionId)
      } else {
        // Deletes everywhere by binding: the canonical opencode session (404
        // tolerated — already gone still cleans up locally), any ACP sidecar
        // state (failures swallowed — a dead sidecar must not block deletion),
        // and the session's agent binding.
        await connector.deleteSession(sessionId)
      }
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      forgetMessageCacheSession(sessionId) // L1: don't leak the deleted session's cache
    },
    [connector, isTeamSession, removeTeamEntry]
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
    // Fold EVERY session's opencode message events into the cross-switch cache —
    // even sessions that aren't currently mounted — so switch-back loses no
    // streamed text (discussions/022 Issue 1). Message events don't touch the
    // sidebar list, so return early.
    if (event.type.startsWith("message.")) {
      applyMessageEventToCache(event as any)
      return
    }
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
        // Exception: legacy (pre-018) team sessions still hang off the hidden
        // parent but ARE sidebar citizens via 补显.
        if (info.parentID && !teamIdsRef.current.has(sid)) return prev
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
    } else if (event.type === "session.status") {
      // App-level busy/idle truth, emitted on the GLOBAL stream by both backends
      // (opencode natively; ACP via the sidecar's /acp/global/events, ADR/discussions
      // 022). Maintaining activeSessionIds here — not only from the currently-mounted
      // session's hook — keeps a session that is still running after you switch away
      // marked active, so Session.tsx keeps rendering its in-flight turn as streaming
      // on switch-back instead of false-completing it during model-thinking gaps.
      const sid = event.properties?.sessionID
      const type = event.properties?.status?.type
      if (sid) {
        if (type === "idle") markSessionIdle(sid)
        else markSessionActive(sid) // "busy" / "retry"
      }
    } else if (event.type === "server.instance.disposed") {
      // Instance.dispose() cancels every opencode runner and the trailing
      // session.status:idle may never arrive (SSE disconnects first). Drop ALL
      // busy markers so a backgrounded session can't stay stuck active forever
      // (which would show a permanent spinner + locked input on switch-back).
      // ACP lives in a separate process and isn't disposed here; clearing its
      // markers at worst degrades to a brief false-complete until the next delta
      // / global snapshot — far milder than a stuck spinner (discussions/022 §7).
      setActiveSessionIds((prev) => (prev.size === 0 ? prev : new Set()))
    }
  }, [workspacePath, markSessionActive, markSessionIdle]))

  return { sessions, loading, error, activeSessionIds, refresh, createSession, deleteSession, updateSession, renameSession, markSessionActive, markSessionIdle }
}
