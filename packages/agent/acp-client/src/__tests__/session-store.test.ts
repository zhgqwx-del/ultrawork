// W4b session store: event-fold reducer + on-disk roundtrip.

import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyEvent,
  deleteSessionFile,
  isPersistencePoint,
  loadAllSessions,
  saveSession,
} from "../session-store.js"
import type { PersistedACPSession, UwSSEEvent, UwStoredMessage } from "../types.js"

const SID = "ses_store_test"

/** The canonical shaped sequence of one mock turn (echo → tool step → answer). */
function turnEvents(): UwSSEEvent[] {
  return [
    {
      type: "message.part.updated",
      properties: {
        part: { id: "p0", sessionID: SID, messageID: "u0", type: "text", text: "hi" },
      },
    },
    {
      type: "message.updated",
      properties: {
        info: { id: "u0", sessionID: SID, role: "user", time: { created: 1, completed: 1 } },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          sessionID: SID,
          messageID: "m0",
          type: "tool",
          callID: "c1",
          tool: "execute",
          state: { status: "pending", input: {} },
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          sessionID: SID,
          messageID: "m0",
          type: "tool",
          callID: "c1",
          tool: "execute",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "a.txt",
            title: "ls",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      },
    },
    {
      type: "message.updated",
      properties: {
        info: {
          id: "m0",
          sessionID: SID,
          role: "assistant",
          time: { created: 1, completed: 2 },
          finish: "tool-calls",
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { id: "p2", sessionID: SID, messageID: "m1", type: "text", text: "One " },
      },
    },
    {
      type: "message.part.delta",
      properties: { sessionID: SID, messageID: "m1", partID: "p2", field: "text", delta: "file." },
    },
    {
      type: "message.updated",
      properties: {
        info: {
          id: "m1",
          sessionID: SID,
          role: "assistant",
          time: { created: 2, completed: 3 },
          finish: "stop",
        },
      },
    },
  ]
}

describe("session store reducer", () => {
  it("folds a turn into the desktop's message shape", () => {
    const messages: UwStoredMessage[] = []
    for (const event of turnEvents()) applyEvent(messages, event)

    expect(messages.map((m) => m.info.id)).toEqual(["u0", "m0", "m1"])
    const [echo, toolStep, answer] = messages
    expect(echo.info.role).toBe("user")
    expect((echo.parts[0] as { text: string }).text).toBe("hi")
    // tool part upserted by id, not duplicated
    expect(toolStep.parts).toHaveLength(1)
    expect(toolStep.info.finish).toBe("tool-calls")
    const tool = toolStep.parts[0] as { state: { status: string; output?: string } }
    expect(tool.state.status).toBe("completed")
    expect(tool.state.output).toBe("a.txt")
    // delta appended to the existing text part
    expect((answer.parts[0] as { text: string }).text).toBe("One file.")
    expect(answer.info.finish).toBe("stop")
  })

  it("ignores non-message events", () => {
    const messages: UwStoredMessage[] = []
    applyEvent(messages, {
      type: "permission.asked",
      properties: { id: "x", sessionID: SID, permission: "bash", patterns: [], metadata: {}, always: [] },
    })
    applyEvent(messages, { type: "session.error", properties: { sessionID: SID, error: "boom" } })
    expect(messages).toHaveLength(0)
  })

  it("flags persistence points: user echo completion and terminal finishes only", () => {
    const events = turnEvents()
    expect(events.map(isPersistencePoint)).toEqual([
      false, // user part
      true, // user echo completed
      false,
      false, // tool parts
      false, // intermediate seal (tool-calls)
      false,
      false, // answer text + delta
      true, // terminal finish
    ])
  })
})

describe("session store persistence", () => {
  it("roundtrips sessions and skips unreadable files", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-store-"))
    const prev = process.env.ACP_DATA_DIR
    process.env.ACP_DATA_DIR = dir
    try {
      const messages: UwStoredMessage[] = []
      for (const event of turnEvents()) applyEvent(messages, event)
      const entry: PersistedACPSession = {
        version: 1,
        sessionId: SID,
        acpSessionId: "acp-1",
        agentId: "mock",
        cwd: "/tmp",
        createdAt: 1,
        updatedAt: 2,
        messages,
      }
      saveSession(entry)
      // A corrupt file must not break loading the rest.
      writeFileSync(join(dir, "broken.json"), "{nope")

      const loaded = loadAllSessions()
      expect(loaded).toHaveLength(1)
      expect(loaded[0].acpSessionId).toBe("acp-1")
      expect(loaded[0].messages).toHaveLength(3)
      expect(loaded[0].messages[2].info.finish).toBe("stop")

      deleteSessionFile(SID)
      expect(loadAllSessions()).toHaveLength(0)
      // Deleting a missing file is a no-op.
      deleteSessionFile(SID)
    } finally {
      if (prev === undefined) delete process.env.ACP_DATA_DIR
      else process.env.ACP_DATA_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("roundtrips the orchestrate flag and tolerates pre-flag files", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-store-"))
    const prev = process.env.ACP_DATA_DIR
    process.env.ACP_DATA_DIR = dir
    try {
      saveSession({
        version: 1,
        sessionId: "ses_orch",
        acpSessionId: "acp-orch",
        agentId: "mock",
        cwd: "/tmp",
        createdAt: 1,
        updatedAt: 2,
        orchestrate: true,
        messages: [],
      })
      // A file written before the orchestrate flag existed (no field at all).
      writeFileSync(
        join(dir, "ses_legacy.json"),
        JSON.stringify({
          version: 1,
          sessionId: "ses_legacy",
          acpSessionId: "acp-legacy",
          agentId: "mock",
          cwd: "/tmp",
          createdAt: 1,
          updatedAt: 2,
          messages: [],
        }),
      )

      const loaded = loadAllSessions()
      const orch = loaded.find((s) => s.sessionId === "ses_orch")
      const legacy = loaded.find((s) => s.sessionId === "ses_legacy")
      expect(orch?.orchestrate).toBe(true)
      expect(legacy?.orchestrate).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.ACP_DATA_DIR
      else process.env.ACP_DATA_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
