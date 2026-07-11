import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Artifact } from "@/components/session/artifact-preview"

/**
 * "How many artifacts has the user not looked at yet" (ADR-048 D1).
 *
 * Two things here are deliberate, and both were found by adversarial review after
 * the naive version (a per-mount `seenCount` number) shipped in a draft:
 *
 * 1. **Seen is a set of PATHS, not a count.** A high-water count breaks the moment
 *    the artifact list gets SHORTER — the agent renames `draft.html` → `report.html`
 *    or cleans up a temp output, `length - seen` goes negative, and a genuinely new
 *    deliverable is silently swallowed with no badge. Identity is immune.
 *
 * 2. **Seen survives a session switch** (keyed by session id, held in a ref). A
 *    per-mount reset means returning to a session you already read lights up
 *    "3 new artifacts" about the very three you just looked at — and a badge that
 *    cries wolf is a badge users learn to ignore.
 *
 * Artifacts that already existed when the session was opened are seeded as seen:
 * they're history, not news. Seeding waits for `settled`, because the workspace
 * scan lands asynchronously and seeding off a half-built list would flag its late
 * arrivals as new.
 */
export function useArtifactUnread(
  sessionId: string | undefined,
  artifacts: Artifact[],
  opts: { loading: boolean; settled: boolean; hasHistory: boolean },
): { unread: number; markSeen: () => void } {
  const seenBySession = useRef(new Map<string, Set<string>>())
  const [tick, setTick] = useState(0)

  const { loading, settled, hasHistory } = opts

  useEffect(() => {
    if (!sessionId || loading) return
    if (seenBySession.current.has(sessionId)) return
    // Wait for the workspace scan ONLY when there's history that the scan could
    // still be discovering. A brand-new session has no past artifacts to seed, and
    // waiting would be a deadlock: the scan is idle-only, so `settled` stays false
    // for the whole first turn — by the time it flips, the artifacts the turn just
    // produced are already in the list and would be seeded away as "already seen".
    // The badge would never light on a fresh session's first turn, which is exactly
    // the case it exists for.
    if (hasHistory && !settled) return
    seenBySession.current.set(sessionId, new Set(artifacts.map((a) => a.path)))
    setTick((n) => n + 1)
  }, [sessionId, loading, settled, hasHistory, artifacts])

  const unread = useMemo(() => {
    const seen = sessionId ? seenBySession.current.get(sessionId) : undefined
    if (!seen) return 0 // not seeded yet — never flash a badge for history
    return artifacts.reduce((n, a) => (seen.has(a.path) ? n : n + 1), 0)
    // `tick` is how the ref announces it changed; it has no other reader.
  }, [sessionId, artifacts, tick])

  const markSeen = useCallback(() => {
    if (!sessionId) return
    seenBySession.current.set(sessionId, new Set(artifacts.map((a) => a.path)))
    setTick((n) => n + 1)
  }, [sessionId, artifacts])

  return { unread, markSeen }
}
