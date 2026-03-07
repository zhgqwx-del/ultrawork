// OpenCode API Types — aligned with upstream packages/sdk/js/src/gen/types.gen.ts

export interface ApiClientConfig {
  baseUrl: string
  username?: string
  password?: string
}

export interface SessionCreateRequest {
  agent?: string
  workingDirectory?: string
}

// --- PartBase: identity fields present on every part ---

export interface PartBase {
  id: string
  sessionID: string
  messageID: string
}

// --- ToolState: discriminated union (nested object, NOT a string) ---

export interface ToolStatePending {
  status: "pending"
  input: Record<string, unknown>
  raw?: string
}

export interface ToolStateRunning {
  status: "running"
  input: Record<string, unknown>
  title?: string
  metadata?: Record<string, unknown>
  time: { start: number }
}

export interface ToolStateCompleted {
  status: "completed"
  input: Record<string, unknown>
  output: string
  title: string
  metadata: Record<string, unknown>
  time: { start: number; end: number; compacted?: number }
  attachments?: FilePart[]
}

export interface ToolStateError {
  status: "error"
  input: Record<string, unknown>
  error: string
  metadata?: Record<string, unknown>
  time: { start: number; end: number }
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

// --- Specific MessagePart types ---

export interface TextPart extends PartBase {
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: Record<string, unknown>
}

export interface ReasoningPart extends PartBase {
  type: "reasoning"
  text: string
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
}

export interface ToolPart extends PartBase {
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  metadata?: Record<string, unknown>
}

export interface StepStartPart extends PartBase {
  type: "step-start"
  snapshot?: string
}

export interface StepFinishPart extends PartBase {
  type: "step-finish"
  reason: string
  snapshot?: string
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export interface FilePart extends PartBase {
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: Record<string, unknown>
}

export interface PatchPart extends PartBase {
  type: "patch"
  hash: string
  files: string[]
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | FilePart
  | PatchPart
  | { type: string; [key: string]: any } // fallback for unknown/partial types

// --- Message types ---

// Request parts don't have PartBase identity fields (server assigns them)
export interface SendMessageRequest {
  parts: Array<{ type: string; text?: string; [key: string]: any }>
}

export interface MessageInfo {
  role: "user" | "assistant"
  time: {
    created: number
    completed?: number
  }
  parentID?: string
  modelID?: string
  providerID?: string
  mode?: string
  agent?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  finish?: string
  id: string
  sessionID: string
}

export interface SendMessageResponse {
  info: MessageInfo
  parts: MessagePart[]
}

export interface Message {
  role: "user" | "assistant"
  content: string
}

export interface Session {
  id: string
  slug: string
  version: string
  projectID: string
  directory: string
  title: string
  time: {
    created: number
    updated: number
  }
  messages?: Message[]
}

// --- Permission / Question: blocking interaction types ---

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID: string; callID: string }
}
