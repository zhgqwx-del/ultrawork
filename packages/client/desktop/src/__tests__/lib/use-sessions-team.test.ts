// Pure helpers behind the legacy team-session 补显 (018 A-4 fallback):
// pre-018 leaders hang off the hidden parent, so the roots-only list misses
// them and they are fetched by id and merged.

import { describe, it, expect } from "vitest"
import { pickLegacyTeamEntries, mergeLegacySessions } from "@/lib/use-sessions"
import type { Session } from "@agent/api-client"

function entry(id: string) {
  return { id, workspace: "/ws", leaderAgentId: "opencode:default", members: [], createdAt: 1 }
}

function session(id: string, updated: number): Session {
  return { id, title: id, directory: "/ws", time: { created: 0, updated } } as Session
}

describe("pickLegacyTeamEntries", () => {
  it("returns only entries absent from both the session list and the attempted set", () => {
    const entries = [entry("a"), entry("b"), entry("c")]
    const picked = pickLegacyTeamEntries(entries, new Set(["a"]), new Set(["b"]))
    expect(picked.map((e) => e.id)).toEqual(["c"])
  })

  it("returns nothing when everything is present", () => {
    expect(pickLegacyTeamEntries([entry("a")], new Set(["a"]), new Set())).toEqual([])
  })
})

describe("mergeLegacySessions", () => {
  it("appends fetched sessions and re-sorts newest-updated first", () => {
    const merged = mergeLegacySessions([session("root", 100)], [session("legacy", 200)])
    expect(merged.map((s) => s.id)).toEqual(["legacy", "root"])
  })

  it("dedups by id (SSE insert raced the fetch) and keeps the original array when nothing to add", () => {
    const current = [session("a", 2), session("b", 1)]
    expect(mergeLegacySessions(current, [session("a", 99)])).toBe(current)
  })
})
