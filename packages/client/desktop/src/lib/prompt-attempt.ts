import type { PromptOptions, SSEEvent } from "@agent/connector"
import type { MessagePart, SendMessageResponse } from "@agent/api-client"

/** Only in-flight desktop sends: Home hands the exact materialised request to Session. */
export interface PromptAttempt {
  token: string
  text: string
  options: PromptOptions
  attemptedModels: string[]
  hasOutput: boolean
  resolving: boolean
  startedAt: number
  roles: Map<string, string>
  excludedIds: Set<string>
  userMessageId?: string
  userCreatedAt: number
  seenUserIds: Set<string>
}

const attempts = new Map<string, PromptAttempt>()

export function beginPromptAttempt(sessionId: string, text: string, options: PromptOptions): PromptAttempt {
  const attempt: PromptAttempt = {
    token: crypto.randomUUID(),
    text,
    options: {
      ...options,
      attachments: options.attachments?.map((a) => ({ ...a })),
      tools: options.tools ? { ...options.tools } : undefined,
    },
    attemptedModels: options.model ? [options.model] : [],
    hasOutput: false,
    resolving: false,
    startedAt: Date.now(),
    roles: new Map(),
    excludedIds: new Set(),
    userCreatedAt: 0,
    seenUserIds: new Set(),
  }
  attempts.delete(sessionId)
  attempts.set(sessionId, attempt)
  // Bound abandoned Home sends / background sessions, including their attachment bytes.
  if (attempts.size > 20) attempts.delete(attempts.keys().next().value!)
  return attempt
}

export function getPromptAttempt(sessionId: string | undefined): PromptAttempt | undefined {
  return sessionId ? attempts.get(sessionId) : undefined
}

export function forgetPromptAttempt(sessionId: string, attempt?: PromptAttempt): void {
  if (!attempt || attempts.get(sessionId) === attempt) attempts.delete(sessionId)
}

function observePart(attempt: PromptAttempt, part: MessagePart, messageID: string): void {
  if (attempt.excludedIds.has(messageID) || attempt.roles.get(messageID) === "user") return
  if (part.type === "tool" || part.type === "file" || part.type === "patch" ||
    ((part.type === "text" || part.type === "reasoning") && "text" in part && !!part.text)) {
    attempt.hasOutput = true
  }
}

/** Global and mounted subscriptions share the same output barrier. */
export function observePromptAttemptEvent(event: SSEEvent): void {
  const props = event.properties as Record<string, any>
  const sid = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID
  const attempt = getPromptAttempt(sid)
  if (!attempt) return
  if (event.type === "message.updated") {
    const info = props.info
    if (!info?.id) return
    attempt.roles.set(info.id, info.role)
    if (typeof info.time?.created === "number" && info.time.created < attempt.startedAt) {
      attempt.excludedIds.add(info.id)
      return
    }
    if (info.role === "user") {
      const created = info.time?.created ?? attempt.startedAt
      if (info.id === attempt.userMessageId) return
      const seen = attempt.seenUserIds.has(info.id)
      attempt.seenUserIds.add(info.id)
      // Earlier attempts can repeat metadata after the next user message.
      if (seen || created < attempt.userCreatedAt ||
        (attempt.userMessageId && created === attempt.userCreatedAt)) return
      attempt.userMessageId = info.id
      attempt.userCreatedAt = created
    }
    if (info.role === "assistant") {
      if ((typeof info.time?.created === "number" && info.time.created < attempt.userCreatedAt) ||
        (attempt.userMessageId && info.parentID && info.parentID !== attempt.userMessageId && attempt.seenUserIds.has(info.parentID))) {
        attempt.excludedIds.add(info.id)
        return
      }
      // Explicit dispatch options are authoritative. A failed previous model's
      // cleanup metadata can arrive after the next candidate has been selected.
      if (!attempt.options.model && info.providerID && info.modelID) {
        const model = `${info.providerID}/${info.modelID}`
        attempt.options.model = model
        if (!attempt.attemptedModels.includes(model)) attempt.attemptedModels.push(model)
      }
    }
  } else if (event.type === "message.part.updated" && props.part?.messageID) {
    observePart(attempt, props.part, props.part.messageID)
  } else if ((event.type === "message.part.delta" || event.type === "message.delta") && props.delta &&
    !attempt.excludedIds.has(props.messageID) && attempt.roles.get(props.messageID) !== "user") {
    attempt.hasOutput = true
  }
}

/** Restore the current turn's barrier after missed SSE; older turns are excluded. */
export function observePromptAttemptSnapshot(sessionId: string, messages: SendMessageResponse[]): void {
  const attempt = getPromptAttempt(sessionId)
  if (!attempt) return
  const user = messages.find((message) => message.info.role === "user" && message.info.id === attempt.userMessageId) ??
    [...messages].reverse().find((message) => message.info.role === "user" &&
      !attempt.seenUserIds.has(message.info.id) && message.info.time.created >= attempt.startedAt &&
      message.info.time.created >= attempt.userCreatedAt && (!attempt.userMessageId || message.info.time.created > attempt.userCreatedAt) &&
      message.parts.filter((part) => part.type === "text").map((part) => "text" in part ? part.text : "").join("").trim() === attempt.text.trim())
  if (!user) return
  observePromptAttemptEvent({ type: "message.updated", properties: { info: user.info } })
  for (const message of messages) {
    if (message.info.id !== user.info.id && message.info.role !== "assistant") continue
    if (message.info.role === "assistant" && (message.info.parentID
      ? message.info.parentID !== user.info.id
      : message.info.time.created < user.info.time.created)) continue
    observePromptAttemptEvent({ type: "message.updated", properties: { info: message.info } })
    if (message.info.role === "assistant") {
      for (const part of message.parts) observePart(attempt, part, message.info.id)
    }
  }
}
