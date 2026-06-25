// Global lifecycle stream (discussions/022 §8): the manager brackets every
// prompt with session.status busy/idle on the GLOBAL subscriber channel so the
// desktop's app-level activeSessionIds survives switching away mid-turn. These
// must stay OFF the per-session stream (they're lifecycle metadata, not messages).
// Offline e2e against the mock ACP agent (real JSON-RPC over stdio).

import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACPManager } from "../acp-manager.js"
import type { ACPAgentConfig, UwSSEEvent } from "../types.js"

const MOCK_AGENT = join(import.meta.dir, "..", "..", "scripts", "mock-acp-agent.ts")

const CONFIG: ACPAgentConfig = {
  id: "mock",
  label: "Mock Agent",
  command: process.execPath,
  args: ["run", MOCK_AGENT],
}

async function withTmpDataDir(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acp-status-"))
  const prev = process.env.ACP_DATA_DIR
  process.env.ACP_DATA_DIR = dir
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.ACP_DATA_DIR
    else process.env.ACP_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("global session.status stream (discussions/022 §8)", () => {
  it("emits busy then idle around a prompt on the global stream, not the per-session stream", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_status"
      const manager = new ACPManager([CONFIG])
      try {
        const globalEvents: UwSSEEvent[] = []
        const sessionEvents: UwSSEEvent[] = []
        manager.subscribeGlobal((e) => globalEvents.push(e))
        manager.subscribe(SID, (e) => {
          sessionEvents.push(e)
          // Answer the mock's bash permission so the turn can complete.
          if (e.type === "permission.asked") {
            setTimeout(() => manager.replyPermission(SID, e.properties.id, "once"), 10)
          }
        })

        await manager.createSession("mock", "/tmp", SID)
        await manager.prompt(SID, "list the files")

        // The global channel carries ONLY the busy→idle bracket for this turn.
        const statuses = globalEvents.filter((e) => e.type === "session.status")
        expect(statuses).toHaveLength(2)
        expect(statuses[0]).toMatchObject({
          type: "session.status",
          properties: { sessionID: SID, status: { type: "busy" } },
        })
        expect(statuses[1]).toMatchObject({
          type: "session.status",
          properties: { sessionID: SID, status: { type: "idle" } },
        })
        // busy is the very first global frame (emitted before restore/prompt work).
        expect(globalEvents[0].type).toBe("session.status")

        // Lifecycle status must NOT leak onto the per-session message stream.
        expect(sessionEvents.some((e) => e.type === "session.status")).toBe(false)
        // Sanity: the per-session stream did carry the real turn (message events).
        expect(sessionEvents.some((e) => e.type.startsWith("message."))).toBe(true)
      } finally {
        await manager.shutdown()
      }
    })
  }, 20_000)

  it("snapshot-on-subscribe replays busy for an in-flight session (reconnect / reload resilience)", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_snap"
      const manager = new ACPManager([CONFIG])
      try {
        // The mock blocks the turn on a permission request; capture its id but
        // DON'T reply yet, so the session stays mid-flight (in `running`).
        let permId: string | null = null
        manager.subscribe(SID, (e) => {
          if (e.type === "permission.asked") permId = e.properties.id
        })
        await manager.createSession("mock", "/tmp", SID)
        const turn = manager.prompt(SID, "list the files")

        // Wait until the turn is mid-flight (permission asked ⇒ busy emitted).
        const start = Date.now()
        while (permId === null) {
          if (Date.now() - start > 5000) throw new Error("permission.asked never arrived")
          await new Promise((r) => setTimeout(r, 10))
        }

        // A late / reconnecting global subscriber must immediately learn the
        // session is busy via the snapshot — even though the busy transition
        // predated this subscription.
        const late: UwSSEEvent[] = []
        const unsub = manager.subscribeGlobal((e) => late.push(e))
        expect(late).toHaveLength(1)
        expect(late[0]).toMatchObject({
          type: "session.status",
          properties: { sessionID: SID, status: { type: "busy" } },
        })
        unsub()

        // Let the turn finish; the snapshot subscriber is gone so no idle there.
        manager.replyPermission(SID, permId!, "once")
        await turn
      } finally {
        await manager.shutdown()
      }
    })
  }, 20_000)

  it("unsubscribeGlobal stops further status delivery", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_unsub"
      const manager = new ACPManager([CONFIG])
      try {
        const seen: UwSSEEvent[] = []
        const unsub = manager.subscribeGlobal((e) => seen.push(e))
        manager.subscribe(SID, (e) => {
          if (e.type === "permission.asked") {
            setTimeout(() => manager.replyPermission(SID, e.properties.id, "once"), 10)
          }
        })
        await manager.createSession("mock", "/tmp", SID)
        unsub()
        await manager.prompt(SID, "list the files")
        expect(seen.filter((e) => e.type === "session.status")).toHaveLength(0)
      } finally {
        await manager.shutdown()
      }
    })
  }, 20_000)
})
