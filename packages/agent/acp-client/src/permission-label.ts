// Permission label inference for the permission-dock (W3 refinement).
//
// claude-code-acp computes a ToolKind internally but drops it when calling
// session/request_permission (only toolCallId/rawInput/title survive), so
// `toolCall.kind` is always absent on the claude path. Recover the label from
// the layered signals below instead of defaulting to "bash".

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
    fromKind(toolCall.kind) ??
    fromKind(shaperKind) ??
    fromRawInput(toolCall.rawInput) ??
    (toolCall.title && isBacktickWrapped(toolCall.title) ? "bash" : undefined) ??
    "tool"
  )
}

/** Pattern shown in the dock's <code> block — strip claude's backtick wrapping. */
export function permissionPattern(toolCall: ToolCallUpdate): string {
  const raw = toolCall.title ?? toolCall.toolCallId
  return isBacktickWrapped(raw) ? raw.slice(1, -1) : raw
}
