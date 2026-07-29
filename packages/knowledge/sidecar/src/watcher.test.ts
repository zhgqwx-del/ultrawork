// A watched folder does not only receive edits. A checkout, a build, or an agent
// writing a tree lands thousands of changes in one window — and the watcher used
// to answer that with one timer and one Set entry per file, then fire that many
// concurrent re-index calls at flush. These tests pin the escalation that
// replaces it: past a threshold, one sequential folder pass instead.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileWatcher } from "./watcher"

let root: string
let watcher: FileWatcher

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uw-watch-"))
  watcher = new FileWatcher()
})
afterEach(() => {
  watcher.unwatchAll()
  rmSync(root, { recursive: true, force: true })
})

type Seen = { folder: string; file: string; type: string }

/**
 * Drive the watcher's private event path directly. fs.watch delivery is
 * OS-scheduled and coalesces unpredictably, so a test that wrote real files
 * would be measuring the platform, not the batching policy.
 */
function feed(w: FileWatcher, folder: string, names: string[]) {
  for (const n of names) (w as any).handleEvent(folder, n, "change")
}
function flush(w: FileWatcher, folder: string) {
  ;(w as any).flushBatch(folder)
}


describe("FileWatcher burst handling", () => {
  it("reports an ordinary edit batch file by file", () => {
    const seen: Seen[] = []
    watcher.onChange((folder, file, type) => seen.push({ folder, file, type }))

    feed(watcher, root, ["a.md", "b.md", "c.md"])
    // Per-file debounce hasn't elapsed, so nothing is batched yet.
    flush(watcher, root)
    expect(seen).toEqual([])

    // Simulate the debounce firing for each file.
    for (const n of ["a.md", "b.md", "c.md"]) (watcher as any).addToBatch(root, join(root, n))
    flush(watcher, root)

    expect(seen.map((s) => s.type)).toEqual(["change", "change", "change"])
    expect(seen.map((s) => s.file)).toEqual([
      join(root, "a.md"),
      join(root, "b.md"),
      join(root, "c.md"),
    ])
  })

  it("escalates a huge burst to ONE folder-level rescan", () => {
    const seen: Seen[] = []
    watcher.onChange((folder, file, type) => seen.push({ folder, file, type }))

    for (let i = 0; i < 5000; i++) {
      ;(watcher as any).addToBatch(root, join(root, `f${i}.md`))
    }
    flush(watcher, root)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ folder: root, file: root, type: "rescan" })
  })

  it("stops accumulating per-file state once escalated", () => {
    watcher.onChange(() => {})
    for (let i = 0; i < 5000; i++) {
      ;(watcher as any).addToBatch(root, join(root, `f${i}.md`))
    }

    // The per-file Set is dropped, not merely ignored — that Set was the
    // unbounded memory.
    expect((watcher as any).folderBatches.has(root)).toBe(false)

    // And further events for this folder create no new timers.
    feed(watcher, root, ["late1.md", "late2.md", "late3.md"])
    expect((watcher as any).fileTimers.size).toBe(0)
  })

  it("returns to per-file reporting after the rescan is flushed", () => {
    const seen: Seen[] = []
    watcher.onChange((folder, file, type) => seen.push({ folder, file, type }))

    for (let i = 0; i < 5000; i++) {
      ;(watcher as any).addToBatch(root, join(root, `f${i}.md`))
    }
    flush(watcher, root)
    expect(seen).toHaveLength(1)

    // A later ordinary edit is an ordinary edit again.
    ;(watcher as any).addToBatch(root, join(root, "after.md"))
    flush(watcher, root)
    expect(seen[1]).toEqual({ folder: root, file: join(root, "after.md"), type: "change" })
  })

  it("unwatching clears an escalation so a re-watch starts clean", () => {
    mkdirSync(join(root, "sub"), { recursive: true })
    writeFileSync(join(root, "sub", "x.md"), "x")
    watcher.onChange(() => {})
    watcher.watchFolder(root)

    for (let i = 0; i < 5000; i++) {
      ;(watcher as any).addToBatch(root, join(root, `f${i}.md`))
    }
    expect((watcher as any).folderRescan.has(root)).toBe(true)

    watcher.unwatchFolder(root)
    expect((watcher as any).folderRescan.has(root)).toBe(false)
  })
})
