import { describe, it, expect } from "vitest"
import {
  extractArtifacts,
  classifyArtifacts,
  mergeScannedPaths,
  sessionTurnWindows,
  filterScanByWindows,
} from "@/components/session/artifacts-panel"
import type { Artifact } from "@/components/session/artifact-preview"
import type { SendMessageResponse } from "@agent/api-client"

const WS = "/ws/project"

function assistant(parts: any[]): SendMessageResponse {
  return { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 1 } }, parts } as SendMessageResponse
}

describe("extractArtifacts — delegate child artifacts (018)", () => {
  it("surfaces files from a delegate tool's D-2 artifacts JSON", () => {
    const msgs = [
      assistant([
        {
          type: "tool",
          tool: "orchestrator_delegate",
          state: {
            status: "completed",
            input: { agentId: "acp:claude", task: "build flappy bird" },
            output: JSON.stringify({
              status: "completed",
              sessionId: "child-1",
              deliverable: "做好了 Flappy Bird 游戏", // 交付物文本里没有路径
              artifacts: [`${WS}/flappy-bird.html`],
            }),
          },
        },
      ]),
    ]
    const arts = extractArtifacts(msgs, WS)
    expect(arts.map((a) => a.path)).toContain("flappy-bird.html")
  })

  it("ignores a delegate output that is not JSON / has no artifacts", () => {
    const msgs = [
      assistant([
        {
          type: "tool",
          tool: "orchestrator_delegate",
          state: { status: "completed", input: {}, output: "plain text, no path" },
        },
      ]),
    ]
    expect(extractArtifacts(msgs, WS)).toEqual([])
  })

  it("still catches an absolute path mentioned in delegate deliverable text (regex fallback)", () => {
    const msgs = [
      assistant([
        {
          type: "tool",
          tool: "orchestrator_delegate",
          state: { status: "completed", input: {}, output: JSON.stringify({ deliverable: `文件在 ${WS}/tank-battle.html` }) },
        },
      ]),
    ]
    expect(extractArtifacts(msgs, WS).map((a) => a.path)).toContain("tank-battle.html")
  })
})

const file = (path: string): Artifact => ({ type: "file", path })

describe("mergeScannedPaths — filesystem scan integration", () => {
  it("adds new scanned paths (bash side-effects) and dedupes against existing", () => {
    const base = [file("report.pdf")]
    const merged = mergeScannedPaths(base, [`${WS}/report.pdf`, `${WS}/chart.png`], WS)
    expect(merged.map((a) => a.path)).toEqual(["report.pdf", "chart.png"])
  })

  it("rejects temp/system paths and paths outside the workspace", () => {
    const merged = mergeScannedPaths([], ["/tmp/scratch.txt", "/other/root/x.csv", `${WS}/keep.csv`], WS)
    expect(merged.map((a) => a.path)).toEqual(["keep.csv"])
  })
})

describe("classifyArtifacts — deliverables vs working files", () => {
  it("demotes scripts/config to working, keeps documents/media as deliverables", () => {
    const { deliverables, working } = classifyArtifacts([
      file("report.pdf"),
      file("gen.py"),
      file("data.csv"),
      file("config.json"),
      file("chart.png"),
    ])
    expect(deliverables.map((a) => a.path)).toEqual(["report.pdf", "data.csv", "chart.png"])
    expect(working.map((a) => a.path)).toEqual(["gen.py", "config.json"])
  })

  it("promotes working files when there are no deliverables (pure-code task)", () => {
    const { deliverables, working } = classifyArtifacts([file("main.py"), file("util.ts")])
    expect(deliverables.map((a) => a.path)).toEqual(["main.py", "util.ts"])
    expect(working).toEqual([])
  })
})

const u = (created: number): SendMessageResponse =>
  ({ info: { id: `u${created}`, sessionID: "s", role: "user", time: { created } }, parts: [] }) as SendMessageResponse
const a = (created: number, completed?: number): SendMessageResponse =>
  ({ info: { id: `m${created}`, sessionID: "s", role: "assistant", time: { created, completed } }, parts: [] }) as SendMessageResponse

describe("sessionTurnWindows — per-turn attribution", () => {
  it("opens a window per turn ending at the assistant completion (+grace), idle gaps excluded", () => {
    // turn1 1000..2000, idle gap, turn2 5000..6000
    const w = sessionTurnWindows([u(1000), a(1100, 2000), u(5000), a(5100, 6000)])
    expect(w).toEqual([
      [1000, 2000 + 5000],
      [5000, 6000 + 5000],
    ])
  })

  it("keeps the final turn open while the agent is active", () => {
    const w = sessionTurnWindows([u(1000), a(1100)], true)
    expect(w[0][0]).toBe(1000)
    expect(w[0][1]).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("filterScanByWindows — cross-session isolation", () => {
  const windows: Array<[number, number]> = [
    [1000, 7000],
    [10000, 16000],
  ]
  it("keeps files written during a turn, drops files from the idle gap or another session", () => {
    const kept = filterScanByWindows(
      [
        { path: "mine1.csv", mtimeMs: 1500 }, // turn 1
        { path: "gap.bin", mtimeMs: 8000 }, // idle gap between turns → drop
        { path: "mine2.pdf", mtimeMs: 12000 }, // turn 2
        { path: "other.pdf", mtimeMs: 99999999 }, // another session, long after → drop
      ],
      windows,
    )
    expect(kept).toEqual(["mine1.csv", "mine2.pdf"])
  })

  it("returns nothing when the session has no turns", () => {
    expect(filterScanByWindows([{ path: "x", mtimeMs: 1 }], [])).toEqual([])
  })
})

describe("workspace-root matching (cross-platform)", () => {
  // On Windows the two sides genuinely disagree: the root arrives from Rust as
  // `C:\ws\proj`, while a model writing a `write` call habitually emits forward
  // slashes. A raw `startsWith` calls that "outside the workspace" and the artifact
  // is dropped outright — it reaches neither the sidebar nor the transcript, and
  // nothing says why.
  it("accepts a Windows path whose separators disagree with the root's", () => {
    const WIN = "C:\\ws\\proj"
    const msgs = [
      assistant([
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "C:/ws/proj/out/a.pdf" } } },
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "C:\\ws\\proj\\b.pdf" } } },
      ]),
    ]
    expect(extractArtifacts(msgs, WIN).map((a) => a.path).sort()).toEqual(["b.pdf", "out/a.pdf"])
  })

  // A bare prefix test puts `/ws/proj-old/a.pdf` inside `/ws/proj` and then hands
  // back the nonsense relative path `-old/a.pdf`.
  it("does not treat a sibling directory as being inside the workspace", () => {
    const msgs = [
      assistant([
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "/ws/project-old/a.pdf" } } },
      ]),
    ]
    expect(extractArtifacts(msgs, WS)).toEqual([])
  })

  it("still strips the root from a well-formed path", () => {
    const msgs = [
      assistant([
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: `${WS}/docs/r.pdf` } } },
      ]),
    ]
    expect(extractArtifacts(msgs, WS).map((a) => a.path)).toEqual(["docs/r.pdf"])
  })
})
