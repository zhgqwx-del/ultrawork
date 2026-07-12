import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { Session } from "@agent/api-client"
import {
  isSessionUnread,
  markSessionRead,
  forgetSessionRead,
  useMarkReadWhileOpen,
  __resetUnreadForTest,
  __setSeedForTest,
} from "@/lib/use-unread"

const HOUR = 3600_000
const now = Date.now()
/** The instant the feature "shipped" for this test run. */
const seed = now - 24 * HOUR

function session(id: string, updated: number): Session {
  return {
    id,
    slug: id,
    version: "1",
    projectID: "p",
    directory: "/w",
    title: id,
    time: { created: updated - HOUR, updated },
  } as Session
}

beforeEach(() => {
  localStorage.clear()
  __resetUnreadForTest()
  __setSeedForTest(seed)
})

describe("unread", () => {
  it("does not light up every historical session on first run", () => {
    // Cold start: nothing has a read timestamp yet. Without the seed floor the
    // whole sidebar would go unread the day this ships.
    const old = session("old", seed - 30 * HOUR)
    expect(isSessionUnread(old)).toBe(false)
  })

  it("marks a session unread once it is active after you last saw it", () => {
    const s = session("channel", now)
    expect(isSessionUnread(s)).toBe(true)
  })

  it("clears once read, and re-arms on the next activity", () => {
    const s = session("channel", now - HOUR)
    markSessionRead(s.id, s.time.updated)
    expect(isSessionUnread(s)).toBe(false)

    // A new IM message lands.
    expect(isSessionUnread(session("channel", now))).toBe(true)
  })

  it("keeps the OPEN session read when its own turn finishes", () => {
    // The trap: useSessions locally stamps time.updated = Date.now() on idle so
    // StatusIcon can show a completion tick. The session you are watching would
    // otherwise flag itself unread the moment it finished answering you.
    const { rerender } = renderHook(
      ({ updated }: { updated: number }) => useMarkReadWhileOpen("open", updated),
      { initialProps: { updated: now - HOUR } },
    )
    expect(isSessionUnread(session("open", now - HOUR))).toBe(false)

    // Turn completes → local idle stamp bumps time.updated.
    act(() => rerender({ updated: now }))
    expect(isSessionUnread(session("open", now))).toBe(false)
  })

  it("still marks OTHER sessions unread while one is open", () => {
    renderHook(() => useMarkReadWhileOpen("open", now))
    expect(isSessionUnread(session("other", now))).toBe(true)
  })

  it("forgets read state for a deleted session", () => {
    markSessionRead("gone", now)
    forgetSessionRead("gone")
    // Back to the seed floor: a post-seed timestamp reads unread again.
    expect(isSessionUnread(session("gone", now))).toBe(true)
  })

  it("survives a session whose updated moves backwards (server refresh)", () => {
    // markSessionIdle fakes time.updated locally; a later refetch can hand back
    // the server's smaller real value. Read state must not regress.
    markSessionRead("s", now)
    expect(isSessionUnread(session("s", now - 5 * HOUR))).toBe(false)
  })
})
