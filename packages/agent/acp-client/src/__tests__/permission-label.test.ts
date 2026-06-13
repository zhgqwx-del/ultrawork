// Permission label inference (W3 refinement): claude-code-acp drops kind in
// request_permission, so the label is recovered layer by layer — explicit
// kind, then the shaper's tool_call frame, then rawInput shape, then title.

import { describe, it, expect } from "bun:test"
import type { ToolCallUpdate } from "@agentclientprotocol/sdk"
import { permissionPattern, resolvePermission } from "../permission-label.js"
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
