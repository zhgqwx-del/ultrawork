// Plan snapshot + persistence (ADR-038): the manager folds plan.updated into a
// per-session snapshot served at GET /acp/session/:id/plan, and persists it so
// switch-back after a sidecar restart still shows the plan. Offline e2e against
// the mock ACP agent (which emits two `plan` updates per turn).

import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACPManager } from "../acp-manager.js"
import { createServer } from "../acp-server.js"
import type { ACPAgentConfig, UwPlanStep } from "../types.js"

const MOCK_AGENT = join(import.meta.dir, "..", "..", "scripts", "mock-acp-agent.ts")

const CONFIG: ACPAgentConfig = {
  id: "mock",
  label: "Mock Agent",
  command: process.execPath,
  args: ["run", MOCK_AGENT],
}

async function withTmpDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acp-plan-"))
  const prev = process.env.ACP_DATA_DIR
  process.env.ACP_DATA_DIR = dir
  try {
    await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.ACP_DATA_DIR
    else process.env.ACP_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

const FINAL_PLAN: UwPlanStep[] = [
  { content: "List directory", status: "completed", priority: "high" },
  { content: "Summarize", status: "in_progress", priority: "medium" },
]

describe("ACP plan snapshot (ADR-038)", () => {
  it("getPlan returns [] for an unknown session", () => {
    const manager = new ACPManager([CONFIG])
    expect(manager.getPlan("nope")).toEqual([])
  })

  it("folds plan.updated into a per-session snapshot (last update wins)", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_plan"
      const manager = new ACPManager([CONFIG])
      try {
        manager.subscribe(SID, (e) => {
          if (e.type === "permission.asked") {
            setTimeout(() => manager.replyPermission(SID, e.properties.id, "once"), 10)
          }
        })
        await manager.createSession("mock", "/tmp", SID)
        await manager.prompt(SID, "list the files")

        expect(manager.getPlan(SID)).toEqual(FINAL_PLAN)
      } finally {
        await manager.shutdown()
      }
    })
  })

  it("persists the plan so a fresh manager restores it (switch-back after restart)", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_plan_persist"
      const manager = new ACPManager([CONFIG])
      try {
        manager.subscribe(SID, (e) => {
          if (e.type === "permission.asked") {
            setTimeout(() => manager.replyPermission(SID, e.properties.id, "once"), 10)
          }
        })
        await manager.createSession("mock", "/tmp", SID)
        await manager.prompt(SID, "list the files")
      } finally {
        await manager.shutdown()
      }

      // A brand-new manager reads the persisted session files at construction.
      const reloaded = new ACPManager([CONFIG])
      expect(reloaded.getPlan(SID)).toEqual(FINAL_PLAN)
    })
  })

  it("serves the plan over HTTP at GET /acp/session/:id/plan", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_plan_http"
      const manager = new ACPManager([CONFIG])
      const app = createServer(manager, null)
      try {
        manager.subscribe(SID, (e) => {
          if (e.type === "permission.asked") {
            setTimeout(() => manager.replyPermission(SID, e.properties.id, "once"), 10)
          }
        })
        await manager.createSession("mock", "/tmp", SID)
        await manager.prompt(SID, "list the files")

        const res = await app.request(`/acp/session/${SID}/plan`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ entries: FINAL_PLAN })

        // Unknown session → empty plan (not 404), matching the panel's "no plan".
        const empty = await app.request("/acp/session/does-not-exist/plan")
        expect(empty.status).toBe(200)
        expect(await empty.json()).toEqual({ entries: [] })
      } finally {
        await manager.shutdown()
      }
    })
  })
})
