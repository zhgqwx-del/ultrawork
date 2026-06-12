import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunStore } from "../run-store"
import type { OrchestrationRun } from "../types"

function sampleRun(id: string): OrchestrationRun {
  return {
    version: 1,
    id,
    recipe: { name: "n", workspace: "/tmp", steps: [{ id: "a", agentId: "opencode:default", taskPrompt: "t", inputs: [] }] },
    status: "completed",
    steps: [{ id: "a", agentId: "opencode:default", status: "completed" }],
    createdAt: 1,
    updatedAt: 2,
  }
}

describe("RunStore", () => {
  let dir: string
  let store: RunStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-store-"))
    store = new RunStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("round-trips runs", () => {
    store.save(sampleRun("run_a"))
    store.save(sampleRun("run_b"))
    expect(store.load().map((r) => r.id).sort()).toEqual(["run_a", "run_b"])
  })

  it("overwrites on re-save", () => {
    const run = sampleRun("run_a")
    store.save(run)
    store.save({ ...run, status: "failed" })
    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].status).toBe("failed")
  })

  it("deletes run files", () => {
    store.save(sampleRun("run_a"))
    store.delete("run_a")
    store.delete("run_never_existed") // no throw
    expect(store.load()).toEqual([])
  })

  it("skips unreadable or foreign files", () => {
    store.save(sampleRun("run_a"))
    writeFileSync(join(dir, "garbage.json"), "{not json")
    writeFileSync(join(dir, "wrong-shape.json"), JSON.stringify({ hello: 1 }))
    writeFileSync(join(dir, "notes.txt"), "ignore me")
    expect(store.load().map((r) => r.id)).toEqual(["run_a"])
  })

  it("loads nothing from a missing directory", () => {
    expect(new RunStore(join(dir, "nope")).load()).toEqual([])
  })
})
