// Permission label inference for the permission-dock (W3 refinement).
//
// The old claude adapter (claude-code-acp ≤0.16.2) computed a ToolKind
// internally but dropped it when calling session/request_permission (only
// toolCallId/rawInput/title survived). Its successor claude-agent-acp ≥0.44
// does send kind, so the explicit-kind tier now hits on the claude path; the
// remaining layers stay as the fallback for other agents and old configs.
// Recover the label from the layered signals instead of defaulting to "bash".

import type { ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk"

// ACP ToolKind → opencode permission label shown by the permission-dock.
const PERMISSION_BY_KIND: Partial<Record<ToolKind, string>> = {
  execute: "bash",
  edit: "edit",
  delete: "edit",
  move: "edit",
  read: "read",
  search: "read",
  fetch: "webfetch",
}

const isBacktickWrapped = (title: string) => title.length > 2 && title.startsWith("`") && title.endsWith("`")

function fromKind(kind: string | null | undefined): string | undefined {
  if (!kind || kind === "other") return undefined
  return PERMISSION_BY_KIND[kind as ToolKind] ?? kind
}

/** Infer from claude tool input shapes (Bash/Edit/Write/Read/Glob/Grep/WebFetch/WebSearch). */
function fromRawInput(rawInput: unknown): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null) return undefined
  const input = rawInput as Record<string, unknown>
  if (typeof input.command === "string") return "bash"
  const path = input.file_path ?? input.path ?? input.notebook_path
  if (path !== undefined) {
    const writes = input.content !== undefined || input.old_string !== undefined ||
      input.new_string !== undefined || input.edits !== undefined || input.new_source !== undefined
    return writes ? "edit" : "read"
  }
  if (input.pattern !== undefined) return "read"
  if (input.url !== undefined || input.query !== undefined) return "webfetch"
  return undefined
}

interface McpCall {
  server: string
  tool: string
  arguments: Record<string, unknown>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Codex exposes MCP through an execute call. Require its structured envelope;
 * a title such as mcp.foo.bar is never enough to relabel an actual shell call. */
function mcpCall(toolCall: ToolCallUpdate): McpCall | undefined {
  const input = toolCall.rawInput
  if (!object(input) || ["command", "cmd", "shell_command"].some((key) => key in input) ||
      (toolCall.title && isBacktickWrapped(toolCall.title))) return undefined
  const validName = (value: unknown): value is string => typeof value === "string" &&
    value.length > 0 && value.length <= 200 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
  if (!validName(input.server) || !validName(input.tool) ||
      (input.arguments !== undefined && !object(input.arguments))) return undefined
  return { server: input.server, tool: input.tool, arguments: input.arguments ?? {} }
}

/** Recover only same-call information already received in session/update.
 * A permission request's explicit input is authoritative; never spread the old
 * envelope into new shell input. Null/missing fields are ACP sparse updates. */
export function permissionToolCall(toolCall: ToolCallUpdate, known?: ToolCallUpdate): ToolCallUpdate {
  if (!known || known.toolCallId !== toolCall.toolCallId) return toolCall
  if (known.kind && toolCall.kind && known.kind !== "other" && toolCall.kind !== "other" && known.kind !== toolCall.kind) return toolCall
  // A different meaningful title is new evidence, not a sparse placeholder.
  // Do not make its approval display borrow a previous operation's envelope.
  if (toolCall.title && toolCall.title !== toolCall.toolCallId && toolCall.title !== known.title) return toolCall
  const title = toolCall.title && toolCall.title !== toolCall.toolCallId ? toolCall.title : known.title ?? toolCall.title
  const isExplicitCommand = !!toolCall.title && isBacktickWrapped(toolCall.title)
  return {
    ...known,
    ...toolCall,
    kind: toolCall.kind && toolCall.kind !== "other" ? toolCall.kind : known.kind ?? toolCall.kind,
    title,
    rawInput: toolCall.rawInput ?? (isExplicitCommand ? undefined : known.rawInput),
  }
}

/**
 * Resolve the permission label for a request_permission tool call.
 * Layers, most reliable first; "tool" is the neutral fallback (never guess bash):
 * 1. explicit `toolCall.kind` (spec-compliant agents)
 * 2. `shaperKind` — the kind the earlier tool_call frame carried (claude path)
 * 3. rawInput shape
 * 4. backtick-wrapped title (claude formats Bash titles as `cmd`)
 */
export function resolvePermission(toolCall: ToolCallUpdate, shaperKind?: string): string {
  return (
    (mcpCall(toolCall) ? "mcp" : undefined) ??
    fromKind(toolCall.kind) ??
    fromKind(shaperKind) ??
    fromRawInput(toolCall.rawInput) ??
    (toolCall.title && isBacktickWrapped(toolCall.title) ? "bash" : undefined) ??
    "tool"
  )
}

/** Pattern shown in the dock's <code> block — strip claude's backtick wrapping. */
export function permissionPattern(toolCall: ToolCallUpdate): string {
  const mcp = mcpCall(toolCall)
  if (mcp) return `mcp.${mcp.server}.${mcp.tool}\n${JSON.stringify(mcp.arguments, null, 2)}`
  if (object(toolCall.rawInput) && typeof toolCall.rawInput.command === "string" &&
      (!toolCall.title || toolCall.title === toolCall.toolCallId || toolCall.title.startsWith("mcp."))) {
    return toolCall.rawInput.command
  }
  const raw = toolCall.title ?? toolCall.toolCallId
  return isBacktickWrapped(raw) ? raw.slice(1, -1) : raw
}

/** Presentation only: does not select, infer or change permission options. */
export function permissionDisplay(toolCall: ToolCallUpdate, known?: ToolCallUpdate) {
  const resolved = permissionToolCall(toolCall, known)
  const mcp = mcpCall(resolved)
  const opaqueExecute = resolved.kind === "execute" && (!resolved.title || resolved.title === resolved.toolCallId) &&
    (resolved.rawInput == null || (object(resolved.rawInput) && Object.keys(resolved.rawInput).length === 0))
  return {
    // ACP execute also wraps MCP. Without any details, don't invent a shell
    // command; the option IDs and authorization round trip remain unchanged.
    permission: opaqueExecute ? "tool" : resolvePermission(resolved),
    pattern: permissionPattern(resolved),
    metadata: mcp ? { toolCallId: toolCall.toolCallId, mcp: { server: mcp.server, tool: mcp.tool, arguments: mcp.arguments } } : {},
  }
}
