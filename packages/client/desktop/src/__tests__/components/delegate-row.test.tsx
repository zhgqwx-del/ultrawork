// Delegate card detection + contract parsing (pure predicates, ADR-031 D-7).

import { describe, it, expect } from "vitest"
import type { ToolPart } from "@agent/api-client"
import { isDelegatePart, parseDelegateResult } from "@/components/chat/delegate-row"

function toolPart(tool: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    id: "p1",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    callID: "c1",
    tool,
    state: { status: "pending", input },
  } as ToolPart
}

describe("isDelegatePart", () => {
  it("matches the opencode MCP tool key exactly", () => {
    expect(isDelegatePart(toolPart("orchestrator_delegate"))).toBe(true)
    // list_agents is a plain tool row, not a delegate card
    expect(isDelegatePart(toolPart("orchestrator_list_agents"))).toBe(false)
  })

  it("matches the ACP rawInput shape (tool field is the kind, not the name)", () => {
    expect(isDelegatePart(toolPart("other", { agentId: "opencode:default", task: "do it" }))).toBe(true)
    expect(isDelegatePart(toolPart("other", { agentId: "x" }))).toBe(false)
    expect(isDelegatePart(toolPart("bash", { command: "ls" }))).toBe(false)
  })
})

describe("parseDelegateResult", () => {
  it("parses the raw contract JSON", () => {
    const parsed = parseDelegateResult(
      JSON.stringify({ status: "completed", sessionId: "child-1", deliverable: "done" }),
    )
    expect(parsed?.sessionId).toBe("child-1")
    expect(parsed?.deliverable).toBe("done")
  })

  it("recovers the contract from a wrapped/host-decorated output", () => {
    const wrapped = `Tool result:\n{"status":"timeout","sessionId":"s9","error":"turn timed out"}\n(end)`
    expect(parseDelegateResult(wrapped)?.status).toBe("timeout")
  })

  it("returns null for non-contract output", () => {
    expect(parseDelegateResult("plain text")).toBeNull()
    expect(parseDelegateResult('{"foo": 1}')).toBeNull()
    expect(parseDelegateResult(undefined)).toBeNull()
  })
})
