import { describe, it, expect } from "vitest"
import type { SendMessageResponse } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { attributeArtifactsToTurns, buildTurnWindows, samePath } from "@/lib/turn-artifacts"
import { classifyArtifacts, extractArtifacts, mergeScannedPaths } from "@/components/session/artifacts-panel"

const WS = "/ws/project"

function user(id: string, created: number): SendMessageResponse {
  return { info: { id, sessionID: "s", role: "user", time: { created } }, parts: [] } as unknown as SendMessageResponse
}

function assistant(id: string, created: number, completed: number, parts: any[] = []): SendMessageResponse {
  return {
    info: { id, sessionID: "s", role: "assistant", time: { created, completed } },
    parts,
  } as unknown as SendMessageResponse
}

/** A `write` tool call naming `path` — the commonest way an artifact is derived. */
function write(path: string) {
  return { type: "tool", tool: "write", state: { status: "completed", input: { filePath: `${WS}/${path}` } } }
}

/** Rebuild the session-level list exactly as `useSessionArtifacts` does. */
function ordered(messages: SendMessageResponse[], scanPaths: string[] = []): Artifact[] {
  const merged = mergeScannedPaths(extractArtifacts(messages, WS), scanPaths, WS)
  const { deliverables, working } = classifyArtifacts(merged)
  return [...deliverables, ...working]
}

function attribute(messages: SendMessageResponse[], scanHits: Array<{ path: string; mtimeMs: number }> = []) {
  return attributeArtifactsToTurns({
    messages,
    ordered: ordered(messages, scanHits.map((h) => h.path)),
    scanHits,
    directory: WS,
  })
}

function paths(map: Map<string, Artifact[]>, anchorId: string): string[] {
  return (map.get(anchorId) ?? []).map((a) => a.path)
}

describe("buildTurnWindows", () => {
  it("anchors each window on the turn's first assistant message (== groupIntoTurns' render key)", () => {
    const msgs = [user("u1", 1000), assistant("a1", 1100, 2000), assistant("a2", 2100, 3000), user("u2", 4000), assistant("a3", 4100, 5000)]
    const windows = buildTurnWindows(msgs)
    expect(windows.map((w) => w.anchorId)).toEqual(["a1", "a3"])
    // The turn's messages travel with the window, so per-turn extraction can't
    // drift out of sync with the grouping.
    expect(windows[0].messages.map((m) => m.info.id)).toEqual(["a1", "a2"])
    expect(windows[1].messages.map((m) => m.info.id)).toEqual(["a3"])
  })

  // The killer: sessionTurnWindows emits a window per USER message, groupIntoTurns
  // emits a turn per RUN of assistant messages. Send two messages in a row and the
  // counts diverge — any index-based pairing is off by one from there on, and the
  // extra window would happily claim files written during it.
  it("marks a user message that produced no assistant reply as a ghost window", () => {
    const msgs = [user("u1", 1000), user("u2", 1200), assistant("a1", 1300, 5000)]
    const windows = buildTurnWindows(msgs)
    expect(windows.length).toBe(2)
    expect(windows[0].anchorId).toBeNull() // ghost — no assistant turn renders for it
    expect(windows[1].anchorId).toBe("a1")
  })

  it("a ghost window never owns an artifact", () => {
    const msgs = [user("u1", 1000), user("u2", 1200), assistant("a1", 1300, 5000)]
    // mtime 1500 sits inside the ghost window's span as well as the real turn's.
    const byTurn = attribute(msgs, [{ path: `${WS}/report.pdf`, mtimeMs: 1500 }])
    expect([...byTurn.keys()]).toEqual(["a1"])
    expect(paths(byTurn, "a1")).toEqual(["report.pdf"])
  })

  // The case the ghost guard actually exists for, and the one that is easy to get
  // wrong: the file belongs to an EARLIER real turn, but a ghost window sits above
  // it and also spans the mtime. Scanning back from the end, the ghost is hit first —
  // and since a ghost has no turn to render under, the file is not misattributed but
  // silently DROPPED: present in the sidebar, absent from the transcript.
  it("looks past a ghost window to the real turn underneath it", () => {
    const msgs = [
      user("u1", 1000),
      assistant("a1", 1100, 10000), // turn A's window: [1000, 15000]
      user("u2", 5000), //            ghost window:    [5000, 10000]
      user("u3", 6000),
      assistant("a2", 12000, 13000), // turn B's window: [6000, 18000]
    ]
    const windows = buildTurnWindows(msgs)
    expect(windows.map((w) => w.anchorId)).toEqual(["a1", null, "a2"])

    // 5500: inside turn A and inside the ghost, but before turn B started.
    const byTurn = attribute(msgs, [{ path: `${WS}/early.pdf`, mtimeMs: 5500 }])
    expect(paths(byTurn, "a1")).toEqual(["early.pdf"])
  })

  it("leaves the final window open while the agent is active", () => {
    const msgs = [user("u1", 1000), assistant("a1", 1100, 2000)]
    expect(buildTurnWindows(msgs, true).at(-1)!.end).toBe(Number.POSITIVE_INFINITY)
    expect(buildTurnWindows(msgs, false).at(-1)!.end).toBeLessThan(Number.POSITIVE_INFINITY)
  })
})

describe("attributeArtifactsToTurns — overlapping windows", () => {
  // Windows overlap as a matter of course: a turn's window ends at its last
  // message's `completed`, the next starts at the next user message's `created`,
  // and typing while the answer streams is normal. The session-level filter asks
  // "any window?" and doesn't care; per-turn has to pick one.
  it("gives a file caught in an overlap to the later turn", () => {
    const msgs = [
      user("u1", 1000),
      assistant("a1", 1100, 35000), // still completing…
      user("u2", 5000), //             …while the user already typed the next message
      assistant("a2", 5100, 45000),
    ]
    const windows = buildTurnWindows(msgs)
    expect(windows[0].end).toBeGreaterThan(windows[1].start) // overlap is real, not hypothetical

    const byTurn = attribute(msgs, [{ path: `${WS}/out.csv`, mtimeMs: 20000 }]) // inside BOTH
    expect(paths(byTurn, "a2")).toEqual(["out.csv"])
    expect(byTurn.has("a1")).toBe(false)
  })
})

describe("attributeArtifactsToTurns — last-wins", () => {
  it("moves a rewritten file to the turn that last wrote it", () => {
    const msgs = [
      user("u1", 1000),
      assistant("a1", 1100, 2000, [write("report.md")]),
      user("u2", 3000),
      assistant("a2", 3100, 4000, [write("notes.txt")]),
      user("u3", 5000),
      assistant("a3", 5100, 6000, [write("report.md")]), // rewritten
    ]
    const byTurn = attribute(msgs)
    // The preview always shows what is on disk NOW, so the card has to sit next to
    // the answer that produced that content — not the one that produced version 1.
    expect(byTurn.has("a1")).toBe(false)
    expect(paths(byTurn, "a2")).toEqual(["notes.txt"])
    expect(paths(byTurn, "a3")).toEqual(["report.md"])
  })

  it("lets a later scan mtime move a file past the tool call that created it", () => {
    // Written by a tool in turn 1, then rewritten by a bash side-effect in turn 2
    // that no tool call names — only the scan sees it.
    const msgs = [
      user("u1", 1000),
      assistant("a1", 1100, 2000, [write("data.csv")]),
      user("u2", 3000),
      assistant("a2", 3100, 4000),
    ]
    const byTurn = attribute(msgs, [{ path: `${WS}/data.csv`, mtimeMs: 3500 }])
    expect(byTurn.has("a1")).toBe(false)
    expect(paths(byTurn, "a2")).toEqual(["data.csv"])
  })
})

describe("attributeArtifactsToTurns — the SSOT stays untouched", () => {
  // The whole point of the derived table. A naive last-wins inside extractArtifacts
  // flips the retained entry's metadata to the LAST occurrence: `mime` is lost (a
  // `file` part carries it, the `write` tool that rewrites the file does not) and
  // `patch` becomes `file` (dropping a diff-tagged deliverable into the collapsed
  // working-files group, where it reads as "gone").
  it("hands back the rich first-wins Artifact, not whatever the last write carried", () => {
    const msgs = [
      user("u1", 1000),
      assistant("a1", 1100, 2000, [
        { type: "file", filename: `${WS}/chart.png`, mime: "image/png", url: "" },
        { type: "patch", files: [`${WS}/app.ts`] },
      ]),
      user("u2", 3000),
      assistant("a2", 3100, 4000, [write("chart.png"), write("app.ts")]),
    ]
    const list = ordered(msgs)
    const byTurn = attribute(msgs)

    const chart = byTurn.get("a2")!.find((a) => a.path === "chart.png")!
    expect(chart.mime).toBe("image/png") // survived the rewrite
    const app = byTurn.get("a2")!.find((a) => a.path === "app.ts")!
    expect(app.type).toBe("patch") // did NOT decay into a working file

    // …and the session-level order is byte-for-byte what it was before this feature.
    expect(list.map((a) => a.path)).toEqual(["chart.png", "app.ts"])
  })

  it("shows nothing the session-level pipeline rejected", () => {
    const msgs = [user("u1", 1000), assistant("a1", 1100, 2000)]
    // A temp path: `isValidArtifactPath` rejects it, so it is absent from `ordered`.
    const byTurn = attribute(msgs, [{ path: "/tmp/scratch.png", mtimeMs: 1500 }])
    expect(byTurn.size).toBe(0)
  })
})

describe("attributeArtifactsToTurns — ordering", () => {
  it("puts deliverables before working files without reclassifying them", () => {
    const msgs = [user("u1", 1000), assistant("a1", 1100, 2000, [write("gen.py"), write("report.pdf")])]
    // `classifyArtifacts` would call a lone `gen.py` a deliverable in one turn and a
    // working file in another (its "promote when there are no deliverables" rule is
    // a property of the set, not of the file). Ordering says the same thing without
    // contradicting itself across turns.
    expect(paths(attribute(msgs), "a1")).toEqual(["report.pdf", "gen.py"])
  })
})

describe("samePath", () => {
  it("matches a raw absolute path against its workspace-relative form", () => {
    expect(samePath(`${WS}/docs/report.md`, "docs/report.md", WS)).toBe(true)
    expect(samePath("C:\\ws\\project\\report.md", "report.md", "C:\\ws\\project")).toBe(true)
    expect(samePath("report.md", "report.md", WS)).toBe(true)
  })

  it("does not match a different file that merely ends similarly", () => {
    expect(samePath(`${WS}/final-report.md`, "report.md", WS)).toBe(false)
  })

  // The suffix match this used to do looked right and quietly conflated two real,
  // different files — suppressing a card that should have been there, with nothing
  // to show for it.
  it("does not conflate a nested file with a same-named one at the workspace root", () => {
    expect(samePath(`${WS}/sub/report.md`, "report.md", WS)).toBe(false)
    expect(samePath(`${WS}/a/b/report.md`, "b/report.md", WS)).toBe(false)
  })

  it("does not treat a file outside the workspace as one inside it", () => {
    expect(samePath("/elsewhere/report.md", "report.md", WS)).toBe(false)
  })
})

describe("regressions the adversarial review found", () => {
  // D3: groupIntoTurns groups by ROLE and never looks at the clock. If a message
  // with a missing/zero `time.created` were skipped when building windows, the
  // anchor could become the turn's SECOND assistant message while the transcript
  // still keys the turn on its first — and every card in that turn would vanish.
  it("anchors on the first assistant message even when its timestamp is missing", () => {
    const noTime = {
      info: { id: "a1", sessionID: "s", role: "assistant", time: {} },
      parts: [write("early.pdf")],
    } as unknown as SendMessageResponse
    const msgs = [user("u1", 1000), noTime, assistant("a2", 1100, 2000, [write("late.pdf")])]

    const windows = buildTurnWindows(msgs)
    expect(windows).toHaveLength(1)
    expect(windows[0].anchorId).toBe("a1") // == groupIntoTurns' turnKey
    expect(windows[0].messages.map((m) => m.info.id)).toEqual(["a1", "a2"])

    // …and the untimed message's artifact is still attributed, not silently dropped.
    expect(paths(attribute(msgs), "a1").sort()).toEqual(["early.pdf", "late.pdf"])
  })

  it("claims no scanned file when a turn has no usable timestamp at all", () => {
    const noTime = { info: { id: "a1", sessionID: "s", role: "assistant", time: {} }, parts: [] } as unknown as SendMessageResponse
    const windows = buildTurnWindows([noTime])
    // An empty interval — it must not swallow every file in the workspace.
    expect(windows[0].start).toBe(Number.POSITIVE_INFINITY)
    expect(windows[0].end).toBe(Number.NEGATIVE_INFINITY)
  })

  // D2: the session-level filter counts ghost windows (it asks "any window?"), so a
  // file only a ghost contains reaches the sidebar. Dropping it here would show it in
  // one view and not the other — one dataset, two views, silently disagreeing.
  it("does not lose a file that only a ghost window contains", () => {
    const msgs = [
      user("u1", 1000),
      assistant("a1", 1100, 2000), // turn A: [1000, 7000]
      user("u2", 10000), //           ghost:  [10000, 15000]
      user("u3", 20000),
      assistant("a3", 20100, 21000), // turn B: [20000, 26000]
    ]
    // 12000 is inside the ghost and inside no real turn.
    const byTurn = attribute(msgs, [{ path: `${WS}/ghost.pdf`, mtimeMs: 12000 }])
    expect(paths(byTurn, "a1")).toEqual(["ghost.pdf"]) // the most recent real turn
  })
})
