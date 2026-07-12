// Unread markers for the sidebar. A session is unread when it has been active
// since you last looked at it — the "is there anything new" signal that makes the
// list findable without relying on remembered positions.
//
// Module-level store (not a Provider): the sidebar reads it and the session page
// writes it, so per-hook state like useFavorites would desync the two.

import { useSyncExternalStore, useEffect } from "react"
import type { Session } from "@agent/api-client"

const READ_KEY = "ultrawork:session-read-at"
const SEED_KEY = "ultrawork:unread-seed-at"

function loadReadAt(): Record<string, number> {
  try {
    const raw = localStorage.getItem(READ_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/**
 * Cold-start floor. Without it, every session that ever existed would light up
 * unread the first time this ships (none of them have a read timestamp yet).
 * Anything last active BEFORE the feature existed counts as already seen; only
 * activity after this instant can mark a session unread.
 */
function loadSeedAt(): number {
  try {
    const raw = localStorage.getItem(SEED_KEY)
    if (raw) return Number(raw)
    const now = Date.now()
    localStorage.setItem(SEED_KEY, String(now))
    return now
  } catch {
    return Date.now()
  }
}

let readAt = loadReadAt()
let seedAt = loadSeedAt()
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

function persist(): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(readAt))
  } catch {
    // localStorage full or disabled — unread degrades to in-memory only
  }
}

export function isSessionUnread(session: Session): boolean {
  return session.time.updated > (readAt[session.id] ?? seedAt)
}

/** Idempotent: re-marking an already-read session is a no-op, so it is safe to
 *  call on every render of an open session. */
export function markSessionRead(sessionId: string, activeAt: number): void {
  if ((readAt[sessionId] ?? 0) >= activeAt) return
  readAt = { ...readAt, [sessionId]: activeAt }
  persist()
  emit()
}

export function forgetSessionRead(sessionId: string): void {
  if (!(sessionId in readAt)) return
  const next = { ...readAt }
  delete next[sessionId]
  readAt = next
  persist()
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only: reset the module store between cases. */
export function __resetUnreadForTest(): void {
  readAt = {}
  seedAt = Date.now()
  version = 0
  listeners.clear()
}

/** Test-only: the cold-start floor, so tests can place fixtures either side of it. */
export function __setSeedForTest(at: number): void {
  seedAt = at
}

export function useUnread() {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  )
  return { isUnread: isSessionUnread, markRead: markSessionRead }
}

/**
 * Keeps the open session read as it streams. useSessions locally stamps
 * time.updated = Date.now() when a session goes idle (so StatusIcon can show its
 * completion tick) — without this, the session you are actively watching would
 * flag itself unread the moment its own turn finished.
 */
export function useMarkReadWhileOpen(sessionId: string | undefined, updatedAt: number | undefined): void {
  useEffect(() => {
    if (!sessionId || updatedAt === undefined) return
    markSessionRead(sessionId, updatedAt)
  }, [sessionId, updatedAt])
}
