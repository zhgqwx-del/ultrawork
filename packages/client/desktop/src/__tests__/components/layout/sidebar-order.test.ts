import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { Session } from "@agent/api-client"
import {
  orderSessions,
  snapshotOrder,
  groupSessionsByDate,
  type FrozenOrder,
} from "@/components/layout/left-sidebar"

const HOUR = 3600_000
const DAY = 24 * HOUR

function session(id: string, created: number, updated: number): Session {
  return {
    id,
    slug: id,
    version: "1",
    projectID: "p",
    directory: "/w",
    title: id,
    time: { created, updated },
  } as Session
}

// Grouping keys off wall-clock day boundaries: `groupSessionsByDate` reads the
// LIVE clock (`new Date()`), so fixtures and the code under test must agree on
// "now". Pin BOTH: a fixed midday `now` (12:00, safely mid-day so a `now-60_000`
// "just active" fixture stays inside today) AND `setSystemTime(now)` per test so
// the source sees the same instant. Anchoring to real `Date.now()` opened a
// ~60s/day flake: run in the first minute after local midnight and `now-60_000`
// fell into yesterday, so a session expected under 「today」 grouped under 「昨天」.
// Note: `now` is computed at module load, before beforeEach — it MUST be a fixed
// literal, not Date.now(), or it would desync from the faked system clock.
const now = new Date(2026, 0, 15, 12, 0, 0).getTime()
const todayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime()

const t = (key: string) => key

describe("sidebar order (P0)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("sorts by last activity, not by creation", () => {
    // The channel session: created weeks ago, woken by an IM message a minute ago.
    const channel = session("channel", now - 30 * DAY, now - 60_000)
    const local = session("local", now - 2 * HOUR, now - 2 * HOUR)

    const ordered = orderSessions([local, channel], null)

    expect(ordered.map((s) => s.id)).toEqual(["channel", "local"])
  })

  it("groups an old-but-just-active session under today, not 更早", () => {
    // The exact bug: sorted by time.updated but grouped by time.created, a channel
    // session woken today stayed buried in 「更早」 even after a manual refresh.
    const channel = session("channel", now - 30 * DAY, now - 60_000)

    const groups = groupSessionsByDate([channel], t, null)

    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe("dateGroup.today")
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["channel"])
  })

  it("still groups a genuinely stale session under 更早", () => {
    const stale = session("stale", now - 30 * DAY, now - 30 * DAY)
    expect(groupSessionsByDate([stale], t, null)[0].label).toBe("dateGroup.earlier")
  })

  it("keeps rows still while frozen, even as time.updated moves", () => {
    const a = session("a", todayStart, now - 3 * HOUR)
    const b = session("b", todayStart, now - 2 * HOUR)
    const frozen: FrozenOrder = snapshotOrder(orderSessions([a, b], null))
    expect(orderSessions([a, b], frozen).map((s) => s.id)).toEqual(["b", "a"])

    // `a` gets an IM message mid-hover — it must NOT jump the cursor.
    const bumped = session("a", todayStart, now)
    expect(orderSessions([bumped, b], frozen).map((s) => s.id)).toEqual(["b", "a"])
  })

  it("holds a frozen row in its original date group even if it would jump groups", () => {
    // Freeze while `old` sits in 更早, then let an IM message land on it. Grouping
    // reads the same frozen key as the sort, so the row cannot hop groups either.
    const old = session("old", now - 30 * DAY, now - 30 * DAY)
    const frozen = snapshotOrder([old])

    const bumped = session("old", now - 30 * DAY, now)
    const groups = groupSessionsByDate(orderSessions([bumped], frozen), t, frozen)

    expect(groups[0].label).toBe("dateGroup.earlier")
  })

  it("withholds sessions born during a freeze rather than splicing them on top", () => {
    const a = session("a", todayStart, now - HOUR)
    const frozen = snapshotOrder([a])

    const fresh = session("fresh", now, now)
    expect(orderSessions([fresh, a], frozen).map((s) => s.id)).toEqual(["a"])

    // ...and they appear the moment the pointer leaves.
    expect(orderSessions([fresh, a], null).map((s) => s.id)).toEqual(["fresh", "a"])
  })
})
