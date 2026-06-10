// Turn shaper: translates one ACP prompt turn (`session/update` notifications)
// into opencode-shaped SSE events (W1 / ADR-027 D-3).
//
// The hard contract comes from the desktop turn renderer (ADR-029):
// - buildTurnModel treats the LAST message of a turn as the answer only if it
//   has no tool part (assistant-turn.tsx:53). Tool steps must therefore live in
//   earlier "process" messages, and the final text in its own message.
// - message-list.tsx:110 only ends the spinner when the last message's
//   info.finish is set and !== "tool-calls". Intermediate messages are sealed
//   with finish:"tool-calls"; the final one gets the real stop reason.
// - use-session-messages.ts only appends deltas to parts that already exist
//   (and hardcodes type:"text" otherwise), so every part is created via a full
//   `message.part.updated` before any `message.part.delta` is sent.

import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  Usage,
} from "@agentclientprotocol/sdk"
import type { UwMessageInfo, UwPart, UwSSEEvent, UwToolPart, UwToolState } from "./types.js"

const FINISH_BY_STOP_REASON: Record<StopReason, string> = {
  end_turn: "stop",
  max_tokens: "length",
  max_turn_requests: "stop",
  refusal: "error",
  cancelled: "abort",
}

interface OpenMessage {
  id: string
  createdAt: number
  hasTool: boolean
  hasText: boolean
  textPartId?: string
  reasoningPartId?: string
}

interface ToolEntry {
  messageID: string
  part: UwToolPart
  startedAt: number
  // Kept outside UwToolState: the pending state has no title field, so the
  // first frame's title would be lost across pending → running → completed.
  title?: string
}

export class TurnShaper {
  private msgSeq = 0
  private partSeq = 0
  private current: OpenMessage | null = null
  private tools = new Map<string, ToolEntry>()
  private turnCost: number | undefined
  private modelID: string | undefined

  constructor(
    private readonly sessionId: string,
    private readonly agentId: string,
    private readonly emit: (event: UwSSEEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reset per-turn state. Call before each prompt. */
  startTurn(): void {
    this.current = null
    this.tools.clear()
    this.turnCost = undefined
  }

  handleUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.onAgentText(update.content)
        break
      case "agent_thought_chunk":
        this.onThought(update.content)
        break
      case "tool_call":
        this.onToolCall(update)
        break
      case "tool_call_update":
        this.onToolCallUpdate(update)
        break
      case "usage_update":
        if (update.cost) this.turnCost = update.cost.amount
        break
      case "session_info_update":
      case "plan":
      case "plan_update":
      case "plan_removed":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "user_message_chunk":
        // TODO(W1b): plan → ExecutionFlow narration; user_message_chunk matters
        // only for session/load replay. Ignored in the spike.
        break
    }
  }

  /**
   * Seal the turn: close the open message with the real stop reason plus the
   * turn's token/cost stats so the renderer ends the spinner and shows the
   * stats footer.
   */
  endTurn(stopReason: StopReason, usage?: Usage | null): void {
    if (!this.current) return
    const finish = FINISH_BY_STOP_REASON[stopReason] ?? "stop"
    const info = this.messageInfo(this.current, finish)
    if (usage) {
      info.tokens = {
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: usage.thoughtTokens ?? 0,
        cache: { read: usage.cachedReadTokens ?? 0, write: usage.cachedWriteTokens ?? 0 },
      }
    }
    if (this.turnCost !== undefined) info.cost = this.turnCost
    this.emit({ type: "message.updated", properties: { info } })
    this.current = null
  }

  /** Fail the turn: seal the open message (if any) and surface the error. */
  failTurn(error: string): void {
    if (this.current) {
      const info = this.messageInfo(this.current, "error")
      this.emit({ type: "message.updated", properties: { info } })
      this.current = null
    }
    this.emit({ type: "session.error", properties: { sessionID: this.sessionId, error } })
  }

  // --- session/update handlers ---

  private onAgentText(content: ContentBlock): void {
    const text = contentBlockText(content)
    if (!text) return
    // A tool step message can never be the answer; once tools ran, the final
    // text opens a fresh text-only message (the answer candidate).
    if (this.current?.hasTool) this.sealCurrent()
    const msg = this.ensureMessage()
    if (msg.textPartId) {
      this.emitDelta(msg, msg.textPartId, text)
    } else {
      msg.textPartId = this.newPartId()
      msg.hasText = true
      this.emitPart({
        id: msg.textPartId,
        sessionID: this.sessionId,
        messageID: msg.id,
        type: "text",
        text,
      })
    }
  }

  private onThought(content: ContentBlock): void {
    const text = contentBlockText(content)
    if (!text) return
    const msg = this.ensureMessage()
    if (msg.reasoningPartId) {
      this.emitDelta(msg, msg.reasoningPartId, text)
    } else {
      msg.reasoningPartId = this.newPartId()
      this.emitPart({
        id: msg.reasoningPartId,
        sessionID: this.sessionId,
        messageID: msg.id,
        type: "reasoning",
        text,
      })
    }
  }

  private onToolCall(update: ToolCallUpdate & { title?: string | null }): void {
    // Agents may re-send tool_call for an id they already announced (the
    // claude adapter does, with progressively richer rawInput) — upsert into
    // the existing part instead of creating a duplicate stuck at "pending".
    if (this.tools.has(update.toolCallId)) {
      this.onToolCallUpdate(update)
      return
    }
    // Narration text emitted before a tool call is process output, not the
    // answer — seal it so the tool step starts a new message.
    if (this.current?.hasText) this.sealCurrent()
    const msg = this.ensureMessage()
    msg.hasTool = true

    const entry: ToolEntry = {
      messageID: msg.id,
      part: undefined as unknown as UwToolPart,
      startedAt: this.now(),
      title: update.title ?? undefined,
    }
    const part: UwToolPart = {
      id: this.newPartId(),
      sessionID: this.sessionId,
      messageID: msg.id,
      type: "tool",
      callID: update.toolCallId,
      tool: update.kind ?? "other",
      state: this.toolState(update, entry),
    }
    entry.part = part
    this.tools.set(update.toolCallId, entry)
    this.emitPart(part)
  }

  private onToolCallUpdate(update: ToolCallUpdate): void {
    const entry = this.tools.get(update.toolCallId)
    if (!entry) {
      // Update for an unseen call (e.g. permission-gated first frame): treat
      // it as a fresh tool_call so nothing is dropped (acpx upsert semantics).
      this.onToolCall(update)
      return
    }
    if (update.title) entry.title = update.title
    const prev = entry.part
    const part: UwToolPart = {
      ...prev,
      tool: update.kind ?? prev.tool,
      state: this.toolState(update, entry),
    }
    entry.part = part
    this.emitPart(part)
  }

  // --- helpers ---

  /** Map ACP tool call fields onto opencode's nested ToolState union. */
  private toolState(update: ToolCallUpdate, entry: ToolEntry): UwToolState {
    const { startedAt, title } = entry
    const prevState: UwToolState | undefined = entry.part?.state
    const input =
      (update.rawInput as Record<string, unknown> | undefined) ??
      prevState?.input ??
      {}
    const prevOutput = prevState && prevState.status === "completed" ? prevState.output : ""
    const output = toolContentText(update.content) || prevOutput
    const status: ToolCallStatus = update.status ?? "pending"

    switch (status) {
      case "pending":
        return { status: "pending", input }
      case "in_progress":
        return { status: "running", input, title, time: { start: startedAt } }
      case "completed":
        return {
          status: "completed",
          input,
          output,
          title: title ?? "",
          metadata: {},
          time: { start: startedAt, end: this.now() },
        }
      case "failed":
        return {
          status: "error",
          input,
          error: output || "Tool call failed",
          time: { start: startedAt, end: this.now() },
        }
    }
  }

  private ensureMessage(): OpenMessage {
    if (this.current) return this.current
    this.current = {
      id: `acp_msg_${this.sessionId}_${this.msgSeq++}`,
      createdAt: this.now(),
      hasTool: false,
      hasText: false,
    }
    return this.current
  }

  /** Close the open message as an intermediate process step. */
  private sealCurrent(): void {
    if (!this.current) return
    const info = this.messageInfo(this.current, "tool-calls")
    this.emit({ type: "message.updated", properties: { info } })
    this.current = null
  }

  private messageInfo(msg: OpenMessage, finish: string): UwMessageInfo {
    return {
      id: msg.id,
      sessionID: this.sessionId,
      role: "assistant",
      time: { created: msg.createdAt, completed: this.now() },
      // TODO(W1b): surface the real model from session_info_update when available.
      modelID: this.modelID ?? this.agentId,
      providerID: "acp",
      agent: this.agentId,
      finish,
    }
  }

  private newPartId(): string {
    return `acp_prt_${this.sessionId}_${this.partSeq++}`
  }

  private emitPart(part: UwPart): void {
    this.emit({ type: "message.part.updated", properties: { part } })
  }

  private emitDelta(msg: OpenMessage, partID: string, delta: string): void {
    this.emit({
      type: "message.part.delta",
      properties: { sessionID: this.sessionId, messageID: msg.id, partID, field: "text", delta },
    })
  }
}

function contentBlockText(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text
    // TODO(W1b): proper file/image rendering; degrade to placeholders for now.
    case "resource_link":
      return `[resource] ${content.uri}`
    case "image":
      return "[image]"
    case "audio":
      return "[audio]"
    case "resource":
      return typeof content.resource === "object" && "text" in content.resource
        ? String(content.resource.text)
        : "[resource]"
  }
}

function toolContentText(content: Array<ToolCallContent> | null | undefined): string {
  if (!content) return ""
  const chunks: string[] = []
  for (const item of content) {
    if (item.type === "content") {
      const text = contentBlockText(item.content)
      if (text) chunks.push(text)
    } else if (item.type === "diff") {
      chunks.push(`[diff] ${item.path}`)
    } else if (item.type === "terminal") {
      chunks.push(`[terminal]`)
    }
  }
  return chunks.join("\n")
}
