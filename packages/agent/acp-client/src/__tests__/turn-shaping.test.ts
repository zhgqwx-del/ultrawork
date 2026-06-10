// Offline e2e for W1 turn shaping: real ACPConnection ↔ mock ACP agent
// subprocess (real JSON-RPC over stdio), asserting the emitted opencode-shaped
// SSE sequence satisfies the ADR-029 renderer contract.

import { describe, it, expect } from "bun:test"
import { join } from "node:path"
import { ACPConnection } from "../acp-connection.js"
import type { UwMessageInfo, UwPart, UwSSEEvent, UwToolPart } from "../types.js"

const MOCK_AGENT = join(import.meta.dir, "..", "..", "scripts", "mock-acp-agent.ts")

interface ReplayMessage {
  info: UwMessageInfo | { id: string }
  parts: UwPart[]
}

/**
 * Minimal mirror of the desktop reducer (use-session-messages.ts):
 * part.updated upserts (creating the message if absent), delta appends only to
 * existing parts, message.updated merges info into existing messages only.
 */
function replay(events: UwSSEEvent[]): ReplayMessage[] {
  const messages: ReplayMessage[] = []
  const byId = (id: string) => messages.find((m) => m.info.id === id)
  for (const event of events) {
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      let msg = byId(part.messageID)
      if (!msg) {
        msg = { info: { id: part.messageID }, parts: [] }
        messages.push(msg)
      }
      const idx = msg.parts.findIndex((p) => p.id === part.id)
      if (idx >= 0) msg.parts[idx] = part
      else msg.parts.push(part)
    } else if (event.type === "message.part.delta") {
      const { messageID, partID, field, delta } = event.properties
      const msg = byId(messageID)
      const part = msg?.parts.find((p) => p.id === partID) as Record<string, unknown> | undefined
      // Mirrors the frontend defect: delta without an existing part is dropped.
      if (part) part[field] = ((part[field] as string) || "") + delta
    } else if (event.type === "message.updated") {
      const info = event.properties.info
      const msg = byId(info.id)
      if (msg) msg.info = { ...msg.info, ...info }
    }
  }
  return messages
}

describe("W1 turn shaping (mock agent, stdio e2e)", () => {
  it("shapes reasoning + tool + answer into opencode N-message form", async () => {
    const events: UwSSEEvent[] = []
    const conn = new ACPConnection(
      { id: "mock", label: "Mock Agent", command: process.execPath, args: ["run", MOCK_AGENT] },
      (_sessionId, event) => events.push(event),
    )
    try {
      await conn.connect()
      const sessionId = await conn.newSession("/tmp")
      const stopReason = await conn.prompt(sessionId, "list the files")
      expect(stopReason).toBe("end_turn")
    } finally {
      conn.disconnect()
    }

    // Contract 1: every delta is preceded by a part.updated creating its part
    // (the frontend drops deltas for unknown parts / hardcodes type "text").
    const seenParts = new Set<string>()
    for (const event of events) {
      if (event.type === "message.part.updated") seenParts.add(event.properties.part.id)
      if (event.type === "message.part.delta") {
        expect(seenParts.has(event.properties.partID)).toBe(true)
      }
    }

    const messages = replay(events)
    expect(messages.length).toBe(3)
    const [narration, toolStep, answer] = messages as Array<{
      info: UwMessageInfo
      parts: UwPart[]
    }>

    // Contract 2: intermediate messages sealed with finish:"tool-calls".
    expect(narration.info.finish).toBe("tool-calls")
    expect(narration.parts.map((p) => p.type).sort()).toEqual(["reasoning", "text"])
    const reasoningPart = narration.parts.find((p) => p.type === "reasoning")!
    expect((reasoningPart as { text: string }).text).toBe("I should list the directory first.")

    // Contract 3: tool step lives in its own message, never in the answer;
    // a re-sent tool_call for the same id must upsert, not duplicate.
    expect(toolStep.info.finish).toBe("tool-calls")
    expect(toolStep.parts.filter((p) => p.type === "tool").length).toBe(1)
    const toolPart = toolStep.parts.find((p): p is UwToolPart => p.type === "tool")!
    expect(toolPart.callID).toBe("call_1")
    expect(toolPart.state.status).toBe("completed")
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("a.txt\nb.txt")
      expect(toolPart.state.title).toBe("List directory")
    }

    // Contract 4: the answer is a text-only final message with a terminal
    // finish (isTerminal: finish set && !== "tool-calls") and usage stats.
    expect(answer.parts.length).toBe(1)
    expect(answer.parts[0].type).toBe("text")
    expect((answer.parts[0] as { text: string }).text).toBe("There are two files.")
    expect(answer.info.finish).toBe("stop")
    expect(answer.info.tokens?.input).toBe(100)
    expect(answer.info.tokens?.output).toBe(42)
    expect(answer.info.time.completed).toBeGreaterThan(0)

    // Contract 5: the finish event is the last thing subscribers see.
    const last = events[events.length - 1]
    expect(last.type).toBe("message.updated")
    if (last.type === "message.updated") expect(last.properties.info.finish).toBe("stop")
  }, 20_000)
})
