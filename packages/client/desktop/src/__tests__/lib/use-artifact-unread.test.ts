/**
 * Unread-artifact accounting (ADR-048 D1).
 *
 * Both of the interesting cases here are regressions that adversarial review found
 * in the first draft, which used a per-mount `seenCount: number`:
 *   - "returning to a session" — the count reset on every mount, so re-entering a
 *     session you had already read re-announced the same artifacts as new;
 *   - "list gets shorter" — a high-water count means a shrinking list drives
 *     `length - seen` negative, silently swallowing a genuinely new artifact.
 * A badge that cries wolf, and a badge that stays dark when it shouldn't. Both are
 * invisible to typechecking and to any test that only ever grows the list.
 */
import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useArtifactUnread } from "@/lib/use-artifact-unread"
import type { Artifact } from "@/components/session/artifact-preview"

const art = (path: string): Artifact => ({ type: "file", path })
/** An existing session, fully loaded and scanned. */
const READY = { loading: false, settled: true, hasHistory: true }

describe("useArtifactUnread", () => {
  it("seeds the artifacts that already existed as seen — history is not news", () => {
    const { result } = renderHook(() => useArtifactUnread("s1", [art("old.pdf"), art("older.md")], READY))
    expect(result.current.unread).toBe(0)
  })

  it("counts artifacts that appear after the session was opened", () => {
    const { result, rerender } = renderHook(
      ({ list }) => useArtifactUnread("s1", list, READY),
      { initialProps: { list: [art("old.pdf")] } },
    )
    expect(result.current.unread).toBe(0)

    rerender({ list: [art("old.pdf"), art("fresh.csv")] })
    expect(result.current.unread).toBe(1)

    rerender({ list: [art("old.pdf"), art("fresh.csv"), art("chart.png")] })
    expect(result.current.unread).toBe(2)
  })

  it("markSeen clears the badge", () => {
    const list = [art("old.pdf"), art("fresh.csv")]
    const { result, rerender } = renderHook(
      ({ l }) => useArtifactUnread("s1", l, READY),
      { initialProps: { l: [art("old.pdf")] } },
    )
    rerender({ l: list })
    expect(result.current.unread).toBe(1)

    act(() => result.current.markSeen())
    expect(result.current.unread).toBe(0)
  })

  it("does not seed until the workspace scan has settled", () => {
    // Seeding off a half-built list would mark the scan's late arrivals as new —
    // a badge for files that were sitting there the whole time.
    const { result, rerender } = renderHook(
      ({ settled, list }) => useArtifactUnread("s1", list, { loading: false, settled, hasHistory: true }),
      { initialProps: { settled: false, list: [art("tool-derived.md")] } },
    )
    expect(result.current.unread).toBe(0) // not seeded → no badge for history

    // The scan lands and brings a file no tool call ever named.
    rerender({ settled: true, list: [art("tool-derived.md"), art("scanned.pdf")] })
    expect(result.current.unread).toBe(0) // both are pre-existing → still silent

    rerender({ settled: true, list: [art("tool-derived.md"), art("scanned.pdf"), art("new.csv")] })
    expect(result.current.unread).toBe(1) // only the genuinely new one
  })

  it("remembers what was seen across a session switch — no crying wolf on return", () => {
    const { result, rerender } = renderHook(
      ({ sid, list }) => useArtifactUnread(sid, list, READY),
      { initialProps: { sid: "A", list: [art("a1.pdf")] } },
    )
    // A gains an artifact; the user opens the panel and reads it.
    rerender({ sid: "A", list: [art("a1.pdf"), art("a2.pdf")] })
    expect(result.current.unread).toBe(1)
    act(() => result.current.markSeen())
    expect(result.current.unread).toBe(0)

    // Off to another session…
    rerender({ sid: "B", list: [art("b1.pdf")] })
    expect(result.current.unread).toBe(0)

    // …and back. A's artifacts are the same two the user already read.
    rerender({ sid: "A", list: [art("a1.pdf"), art("a2.pdf")] })
    expect(result.current.unread).toBe(0) // a count-based impl would say 2 here
  })

  it("a shrinking list does not swallow a new artifact", () => {
    // The agent writes draft.html, then renames it to report.html: the list length
    // is unchanged or smaller, but report.html is genuinely new. A high-water count
    // would compute max(0, 2 - 2) = 0 and show nothing.
    const { result, rerender } = renderHook(
      ({ list }) => useArtifactUnread("s1", list, READY),
      { initialProps: { list: [art("draft.html"), art("notes.md")] } },
    )
    expect(result.current.unread).toBe(0) // both seeded as seen

    rerender({ list: [art("report.html"), art("notes.md")] }) // draft → report
    expect(result.current.unread).toBe(1) // report.html is new, and we say so
  })

  it("lights the badge on a BRAND-NEW session's very first turn", () => {
    // The flagship case, and it was broken: a fresh session has no history, so it
    // must not wait for the workspace scan before seeding. The scan is idle-only,
    // so `settled` stays false for the whole first turn — waiting for it meant the
    // seed happened only AFTER the turn finished, by which point the artifacts the
    // turn had just produced were already in the list and got seeded away as
    // "already seen". The badge never lit on the one turn users care most about.
    const fresh = { loading: false, settled: false, hasHistory: false }
    const { result, rerender } = renderHook(
      ({ list, o }) => useArtifactUnread("new1", list, o),
      { initialProps: { list: [] as Artifact[], o: fresh } },
    )
    expect(result.current.unread).toBe(0) // nothing produced yet

    // The agent writes two files during the (still-running) first turn.
    rerender({ list: [art("report.pptx"), art("data.csv")], o: fresh })
    expect(result.current.unread).toBe(2)

    // The turn ends and the scan settles — the count must not be wiped by a late seed.
    rerender({ list: [art("report.pptx"), art("data.csv")], o: { loading: false, settled: true, hasHistory: true } })
    expect(result.current.unread).toBe(2)
  })

  it("is inert without a session id", () => {
    const { result } = renderHook(() => useArtifactUnread(undefined, [art("x.pdf")], READY))
    expect(result.current.unread).toBe(0)
    act(() => result.current.markSeen()) // must not throw
    expect(result.current.unread).toBe(0)
  })
})
