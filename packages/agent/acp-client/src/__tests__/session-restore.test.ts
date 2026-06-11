// W4b offline e2e: persisted history + session/load restore with replay
// suppression, against the mock ACP agent (real JSON-RPC over stdio).

import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACPConnection } from "../acp-connection.js"
import { ACPManager } from "../acp-manager.js"
import type { ACPAgentConfig, UwSSEEvent } from "../types.js"

const MOCK_AGENT = join(import.meta.dir, "..", "..", "scripts", "mock-acp-agent.ts")

const MOCK_CONFIG: ACPAgentConfig = {
  id: "mock",
  label: "Mock Agent",
  command: process.execPath,
  args: ["run", MOCK_AGENT],
}

async function withTmpDataDir(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acp-restore-"))
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

describe("W4b session/load replay suppression (connection)", () => {
  it("emits nothing during load, then shapes the next prompt normally", async () => {
    const events: UwSSEEvent[] = []
    const conn = new ACPConnection(MOCK_CONFIG, (_sid, event) => {
      events.push(event)
      if (event.type === "permission.asked") {
        setTimeout(() => conn.replyPermission(event.properties.id, "once"), 10)
      }
    })
    try {
      await conn.connect()
      expect(conn.agentCapabilities?.loadSession).toBe(true)

      // The mock replays a full prior turn inside loadSession — all of it
      // must be suppressed (history renders from the sidecar store instead).
      await conn.loadSession("mock-session-1", "/tmp", "ses_pub")
      expect(events).toHaveLength(0)
      expect(conn.hasSession("mock-session-1")).toBe(true)

      // After the load, a fresh prompt shapes end-to-end as usual.
      const stopReason = await conn.prompt("mock-session-1", "list the files")
      expect(stopReason).toBe("end_turn")
      const last = events[events.length - 1]
      expect(last.type).toBe("message.updated")
      if (last.type === "message.updated") expect(last.properties.info.finish).toBe("stop")
      // Replayed tool calls never leak: the only tool part is the live one.
      const toolParts = events.filter(
        (e) => e.type === "message.part.updated" && e.properties.part.type === "tool",
      )
      for (const e of toolParts) {
        if (e.type === "message.part.updated" && e.properties.part.type === "tool") {
          expect(e.properties.part.callID).toBe("call_1")
        }
      }
    } finally {
      await conn.disconnect()
    }
  }, 20_000)
})

describe("W4b manager persistence + restore", () => {
  it("survives a manager restart: history served from disk, prompt restores via session/load", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_restart"

      // --- First life: create a session and run one turn. ---
      const first = new ACPManager([MOCK_CONFIG])
      const firstEvents: UwSSEEvent[] = []
      first.subscribe(SID, (event) => {
        firstEvents.push(event)
        if (event.type === "permission.asked") {
          setTimeout(() => first.replyPermission(SID, event.properties.id, "once"), 10)
        }
      })
      await first.createSession("mock", "/tmp", SID)
      await first.prompt(SID, "list the files")
      const historyLen = first.getMessages(SID)!.length
      expect(historyLen).toBeGreaterThanOrEqual(4) // echo + narration + tool + answer
      await first.shutdown()

      // --- Second life: a fresh manager (sidecar restart). ---
      const second = new ACPManager([MOCK_CONFIG])
      try {
        // Mapping + shaped history restored from disk without touching the agent.
        const restored = second.getMessages(SID)
        expect(restored).toBeDefined()
        expect(restored!.length).toBe(historyLen)
        expect(restored![restored!.length - 1].info.finish).toBe("stop")
        expect(second.getSession(SID)?.agentId).toBe("mock")

        // Prompting reconnects + session/load (replay suppressed): subscribers
        // see only the new turn, never the replayed history.
        const events: UwSSEEvent[] = []
        second.subscribe(SID, (event) => {
          events.push(event)
          if (event.type === "permission.asked") {
            setTimeout(() => second.replyPermission(SID, event.properties.id, "once"), 10)
          }
        })
        await second.prompt(SID, "list the files")
        const replayedTool = events.find(
          (e) =>
            e.type === "message.part.updated" &&
            e.properties.part.type === "tool" &&
            e.properties.part.callID === "replayed_call_1",
        )
        expect(replayedTool).toBeUndefined()
        const last = events[events.length - 1]
        if (last.type === "message.updated") expect(last.properties.info.finish).toBe("stop")

        // The new turn extended the same stored history.
        expect(second.getMessages(SID)!.length).toBeGreaterThan(historyLen)
      } finally {
        await second.shutdown()
      }
    })
  }, 30_000)

  it("deleteSession drops the persisted file", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_delete"
      const first = new ACPManager([MOCK_CONFIG])
      first.subscribe(SID, (event) => {
        if (event.type === "permission.asked") {
          setTimeout(() => first.replyPermission(SID, event.properties.id, "once"), 10)
        }
      })
      await first.createSession("mock", "/tmp", SID)
      await first.prompt(SID, "list the files")
      expect(first.deleteSession(SID)).toBe(true)
      await first.shutdown()

      const second = new ACPManager([MOCK_CONFIG])
      expect(second.getMessages(SID)).toBeUndefined()
      await second.shutdown()
    })
  }, 20_000)

  it("listSessions exposes agent bindings, surviving a restart (ADR-030 hydration)", async () => {
    await withTmpDataDir(async () => {
      const SID = "ses_bindings"
      const first = new ACPManager([MOCK_CONFIG])
      await first.createSession("mock", "/tmp", SID)
      const live = first.listSessions()
      expect(live.length).toBe(1)
      expect(live[0]).toMatchObject({ sessionId: SID, agentId: "mock", cwd: "/tmp" })
      await first.shutdown()

      // A fresh manager (sidecar restart) still lists the binding from disk.
      const second = new ACPManager([MOCK_CONFIG])
      const restored = second.listSessions()
      expect(restored.length).toBe(1)
      expect(restored[0].sessionId).toBe(SID)
      expect(restored[0].agentId).toBe("mock")
      await second.shutdown()
    })
  }, 20_000)
})
