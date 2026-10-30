// Permission label inference (W3 refinement): claude-code-acp drops kind in
// request_permission, so the label is recovered layer by layer — explicit
// kind, then the shaper's tool_call frame, then rawInput shape, then title.

import { describe, it, expect } from "bun:test"
import type { ToolCallUpdate } from "@agentclientprotocol/sdk"
import { permissionDisplay, permissionPattern, permissionToolCall, resolvePermission } from "../permission-label.js"
import { TurnShaper } from "../turn-shaper.js"

const call = (fields: Partial<ToolCallUpdate>): ToolCallUpdate => ({
  toolCallId: "call_1",
  ...fields,
})

describe("resolvePermission", () => {
  it("maps an explicit kind through PERMISSION_BY_KIND", () => {
    expect(resolvePermission(call({ kind: "execute" }))).toBe("bash")
    expect(resolvePermission(call({ kind: "delete" }))).toBe("edit")
    expect(resolvePermission(call({ kind: "search" }))).toBe("read")
    expect(resolvePermission(call({ kind: "fetch" }))).toBe("webfetch")
  })

  it("falls back to the shaper's kind when the request has none (claude path)", () => {
    expect(resolvePermission(call({ title: "List directory" }), "execute")).toBe("bash")
    expect(resolvePermission(call({}), "edit")).toBe("edit")
  })

  it('ignores a shaper kind of "other"', () => {
    expect(resolvePermission(call({}), "other")).toBe("tool")
  })

  it("infers from rawInput shape (claude tool inputs)", () => {
    expect(resolvePermission(call({ rawInput: { command: "ls -la" } }))).toBe("bash")
    expect(resolvePermission(call({ rawInput: { file_path: "/tmp/x", old_string: "a", new_string: "b" } }))).toBe("edit")
    expect(resolvePermission(call({ rawInput: { file_path: "/tmp/x", content: "hi" } }))).toBe("edit")
    expect(resolvePermission(call({ rawInput: { file_path: "/tmp/x" } }))).toBe("read")
    expect(resolvePermission(call({ rawInput: { pattern: "**/*.ts" } }))).toBe("read")
    expect(resolvePermission(call({ rawInput: { url: "https://example.com" } }))).toBe("webfetch")
    expect(resolvePermission(call({ rawInput: { query: "bun test" } }))).toBe("webfetch")
  })

  it("treats a backtick-wrapped title as a command", () => {
    expect(resolvePermission(call({ title: "`rm -rf /tmp/x`" }))).toBe("bash")
  })

  it("returns the neutral label when nothing is inferable", () => {
    expect(resolvePermission(call({ title: "Do something" }))).toBe("tool")
    expect(resolvePermission(call({}))).toBe("tool")
  })

  it("prefers explicit kind over weaker signals", () => {
    expect(resolvePermission(call({ kind: "read", rawInput: { command: "ls" } }), "execute")).toBe("read")
  })
})

describe("permissionPattern", () => {
  it("strips claude's backtick wrapping and falls back to the id", () => {
    expect(permissionPattern(call({ title: "`ls -la`" }))).toBe("ls -la")
    expect(permissionPattern(call({ title: "Write /tmp/x" }))).toBe("Write /tmp/x")
    expect(permissionPattern(call({}))).toBe("call_1")
  })
})

describe("TurnShaper.toolKind", () => {
  it("returns the kind carried by the tool_call frame", () => {
    const shaper = new TurnShaper("ses_x", "claude", () => {})
    shaper.startTurn()
    shaper.handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_9",
      title: "Write /tmp/x",
      kind: "edit",
      status: "pending",
    })
    expect(shaper.toolKind("call_9")).toBe("edit")
    expect(shaper.toolKind("missing")).toBeUndefined()
    // End-to-end of the claude path: frame had the kind, the request does not.
    expect(resolvePermission(call({ toolCallId: "call_9" }), shaper.toolKind("call_9"))).toBe("edit")
  })
})

describe("structured MCP permission display", () => {
  const callId = "exec-9befe7af-fcd7-4be5-b78d-09706e68d060"
  // Sanitized codex-acp 2.5.0 shape observed on the real Team delegate chain.
  const args = { agentId: "acp:codex-member", cwd: "客户 workspace", task: '回答“你是谁？”\nquotes: " and \\; <script>noop</script>' }
  const known = call({ toolCallId: callId, kind: "execute", title: "mcp.orchestrator.delegate", rawInput: { server: "orchestrator", tool: "delegate", arguments: args } })
  const sparse = call({ toolCallId: callId, kind: "execute", title: callId })

  it("recovers the same call's MCP server/tool and exact readable arguments", () => {
    const display = permissionDisplay(sparse, known)
    expect(display.permission).toBe("mcp")
    const [name, ...json] = display.pattern.split("\n")
    expect(name).toBe("mcp.orchestrator.delegate")
    expect(JSON.parse(json.join("\n"))).toEqual(args)
    expect(display.metadata).toEqual({ toolCallId: callId, mcp: { server: "orchestrator", tool: "delegate", arguments: args } })
    expect(sparse.title).toBe(callId)
    expect(sparse.rawInput).toBeUndefined()
  })

  it("also recognizes an authoritative MCP envelope without an earlier frame", () => {
    expect(permissionDisplay(known).permission).toBe("mcp")
    expect(resolvePermission(known)).toBe("mcp")
  })

  it("supports MCP's omitted arguments for no-argument tools without accepting non-object values", () => {
    const noArgs = call({ kind: "execute", rawInput: { server: "calendar", tool: "list" } })
    expect(permissionDisplay(noArgs).permission).toBe("mcp")
    expect(permissionDisplay(noArgs).pattern).toBe("mcp.calendar.list\n{}")
    for (const argumentsValue of [null, [], "{}", 7]) {
      expect(permissionDisplay(call({ kind: "execute", rawInput: { server: "calendar", tool: "list", arguments: argumentsValue } })).permission).not.toBe("mcp")
    }
  })

  it("uses only same-ID history; unknown/late opaque execute remains neutral", () => {
    expect(permissionDisplay(sparse).permission).toBe("tool")
    expect(permissionDisplay(sparse, { ...known, toolCallId: "another-call" })).toEqual(permissionDisplay(sparse))
    expect(permissionDisplay(sparse).pattern).toBe(callId)
  })

  it("never identifies MCP from a title alone or from malformed/partial envelopes", () => {
    for (const rawInput of [undefined, {}, { server: "orchestrator" },
      { server: "orchestrator", tool: "delegate", arguments: [] }, { server: "bad\nname", tool: "delegate", arguments: {} }]) {
      expect(permissionDisplay(call({ kind: "execute", title: "mcp.orchestrator.delegate", rawInput })).permission).not.toBe("mcp")
    }
  })

  it("does not inherit metadata across conflicting explicit kinds", () => {
    const changedKind = { ...sparse, kind: "read" as const }
    expect(permissionToolCall(changedKind, known)).toEqual(changedKind)
    expect(permissionDisplay(changedKind, known).permission).toBe("read")
    expect(permissionDisplay(changedKind, known).metadata).toEqual({})
    expect(permissionDisplay(call({ kind: "other" }), call({ kind: "edit", title: "Update file" })).permission).toBe("edit")
  })

  it("does not relabel a shell even when its title and extra fields imitate MCP", () => {
    const shell = call({ kind: "execute", title: "mcp.orchestrator.delegate", rawInput: { ...known.rawInput as object, command: "echo real-shell" } })
    expect(permissionDisplay(shell).permission).toBe("bash")
    expect(permissionDisplay(shell).pattern).toBe("echo real-shell")
    expect(permissionDisplay(shell).metadata).toEqual({})
  })

  it("does not blend old MCP input into the request's new explicit shell input", () => {
    const shell = { ...sparse, rawInput: { command: "echo updated-shell" } }
    expect(permissionToolCall(shell, known).rawInput).toEqual(shell.rawInput)
    expect(permissionDisplay(shell, known).permission).toBe("bash")
    expect(permissionDisplay(shell, known).pattern).toBe("echo updated-shell")
    expect(permissionDisplay(shell, known).metadata).toEqual({})
  })

  it("treats a backtick command as shell rather than inheriting prior MCP input", () => {
    const shell = { ...sparse, title: "`echo updated-shell`" }
    expect(permissionDisplay(shell, known).permission).toBe("bash")
    expect(permissionDisplay(shell, known).pattern).toBe("echo updated-shell")
  })

  it("does not borrow a previous operation's input when the request has a new meaningful title", () => {
    const current = { ...sparse, title: "Run echo actual shell" }
    expect(permissionToolCall(current, known)).toEqual(current)
    const display = permissionDisplay(current, known)
    expect(display.permission).toBe("bash")
    expect(display.pattern).toBe("Run echo actual shell")
    expect(display.metadata).toEqual({})
    const currentMcp = { ...current, rawInput: { server: "calendar", tool: "list" } }
    expect(permissionDisplay(currentMcp, known).pattern).toBe("mcp.calendar.list\n{}")
    for (const title of [undefined, callId, known.title]) {
      expect(permissionDisplay({ ...sparse, title }, known).permission).toBe("mcp")
    }
  })

  it("does not expose completed or failed turn context to a late permission request", () => {
    for (const finish of ["end", "fail"] as const) {
      const shaper = new TurnShaper(`ses_${finish}`, "codex", () => {})
      shaper.startTurn()
      shaper.handleUpdate({ toolCallId: callId, title: known.title!, kind: "execute", rawInput: known.rawInput, sessionUpdate: "tool_call", status: "pending" })
      expect(permissionDisplay(sparse, shaper.toolCall(callId)).permission).toBe("mcp")
      if (finish === "end") shaper.endTurn("end_turn")
      else shaper.failTurn("fixture failure")
      expect(shaper.toolCall(callId)).toBeUndefined()
      expect(permissionDisplay(sparse, shaper.toolCall(callId)).permission).toBe("tool")
      shaper.handleUpdate({ toolCallId: callId, title: known.title!, kind: "execute", rawInput: known.rawInput, sessionUpdate: "tool_call", status: "pending" })
      expect(shaper.toolCall(callId)).toBeUndefined()
      shaper.startTurn()
      shaper.handleUpdate({ toolCallId: callId, title: known.title!, kind: "execute", rawInput: known.rawInput, sessionUpdate: "tool_call", status: "pending" })
      expect(permissionDisplay(sparse, shaper.toolCall(callId)).permission).toBe("mcp")
    }
  })

  it("preserves sparse updates and returns snapshots without exposing mutable shaper state", () => {
    const shaper = new TurnShaper("ses_x", "codex", () => {})
    shaper.startTurn()
    shaper.handleUpdate({ toolCallId: callId, kind: "execute", title: known.title!, rawInput: known.rawInput, sessionUpdate: "tool_call", status: "pending" })
    shaper.handleUpdate({ toolCallId: callId, sessionUpdate: "tool_call_update", status: "in_progress" })
    const snapshot = shaper.toolCall(callId)!
    expect(permissionDisplay(sparse, snapshot).permission).toBe("mcp")
    ;(snapshot.rawInput as { arguments: { task: string } }).arguments.task = "changed"
    expect(permissionDisplay(sparse, shaper.toolCall(callId)).pattern).toContain("回答")
    expect(shaper.toolCall("missing")).toBeUndefined()
    const otherSession = new TurnShaper("ses_other", "codex", () => {})
    otherSession.startTurn()
    expect(otherSession.toolCall(callId)).toBeUndefined()
    expect(permissionDisplay(sparse, otherSession.toolCall(callId)).permission).toBe("tool")
    shaper.startTurn()
    expect(shaper.toolCall(callId)).toBeUndefined()
    shaper.handleUpdate({ toolCallId: callId, title: "`echo new-turn`", rawInput: { command: "echo new-turn" }, kind: "execute", sessionUpdate: "tool_call", status: "pending" })
    expect(permissionDisplay(sparse, shaper.toolCall(callId)).permission).toBe("bash")
    expect(permissionDisplay(sparse, shaper.toolCall(callId)).pattern).toBe("echo new-turn")
  })
})
