import type { MessagePart, MessageInfo, PermissionRequest, QuestionRequest, PlanStep } from "@agent/api-client"

// Unified event model (ADR-030 C3): the opencode SSE shape is the common
// event model for ALL backends. ACP events are already normalized into this
// shape by the ACP Client Sidecar (ADR-027 D-3).
export type ConnectorEvent =
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "server.heartbeat"; properties: Record<string, never> }
  // Part-level events (OpenCode primary streaming mechanism)
  | { type: "message.part.updated"; properties: { part: MessagePart } }
  | { type: "message.part.delta"; properties: PartDeltaProperties }
  | { type: "message.part.removed"; properties: { sessionID: string; messageID: string; partID: string } }
  // Message-level events
  | { type: "message.updated"; properties: { info: MessageInfo } }
  | { type: "message.removed"; properties: { sessionID: string; messageID: string } }
  // Session events
  | { type: "session.updated"; properties: SessionUpdatedProperties }
  | { type: "session.created"; properties: { id: string; [key: string]: any } }
  | { type: "session.deleted"; properties: { id: string } }
  | { type: "session.status"; properties: SessionStatusProperties }
  // Task-plan events (ADR-038): normalized from opencode `todo.updated` and
  // ACP `session/update:plan`. WHOLE list each time (整表替换).
  | { type: "plan.updated"; properties: PlanUpdatedProperties }
  // Permission / Question blocking-interaction events
  | { type: "permission.asked"; properties: PermissionRequest }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string; reply: string } }
  | { type: "question.asked"; properties: QuestionRequest }
  | { type: "question.replied"; properties: { sessionID: string; requestID: string; answers: string[][] } }
  | { type: "question.rejected"; properties: { sessionID: string; requestID: string } }
  // Legacy events (kept for backward compatibility if server sends them)
  | { type: "message.delta"; properties: LegacyDeltaProperties }
  | { type: "message.completed"; properties: LegacyCompletedProperties }
  // Catch-all for unknown event types
  | { type: string; properties: Record<string, any> }

/** Back-compat alias: desktop code historically called this SSEEvent. */
export type SSEEvent = ConnectorEvent

export type ConnectorEventHandler = (event: ConnectorEvent) => void
/** Back-compat alias. */
export type SSEEventHandler = ConnectorEventHandler

export interface PartDeltaProperties {
  sessionID: string
  messageID: string
  partID: string
  field: string
  delta: string
}

export interface SessionUpdatedProperties {
  sessionID?: string
  id?: string
  title?: string
  [key: string]: any
}

export interface PlanUpdatedProperties {
  sessionID: string
  entries: PlanStep[]
}

export interface SessionStatusProperties {
  sessionID: string
  status: { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number }
}

// Legacy types kept for backward compat
export interface LegacyDeltaProperties {
  sessionID: string
  messageID: string
  delta: string
}

export interface LegacyCompletedProperties {
  sessionID: string
  messageID: string
}

/**
 * Extract the session id an event belongs to, or undefined for global events
 * (server.*, heartbeat, unknown shapes). Used by per-session subscriptions:
 * events with no session id pass through to every subscriber (e.g.
 * server.instance.disposed must reach session views).
 */
export function sessionIdOf(event: ConnectorEvent): string | undefined {
  const props = event.properties as Record<string, any> | undefined
  if (!props) return undefined
  switch (event.type) {
    case "message.part.updated":
      return props.part?.sessionID
    case "message.updated":
      return props.info?.sessionID
    case "session.created":
    case "session.deleted":
      return props.id
    case "session.updated":
      return props.sessionID ?? props.id
    default:
      // part.delta / part.removed / message.removed / session.status /
      // plan.updated / permission.* / question.* / legacy events all carry a
      // flat sessionID.
      return typeof props.sessionID === "string" ? props.sessionID : undefined
  }
}
