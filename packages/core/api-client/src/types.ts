// OpenCode API Types — aligned with upstream packages/sdk/js/src/gen/types.gen.ts

export interface ApiClientConfig {
  baseUrl: string
  username?: string
  password?: string
  workingDirectory?: string
}

export interface SessionCreateRequest {
  agent?: string
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

// --- Provider / Model types ---

export interface ProviderModel {
  id: string
  name: string
  capabilities?: {
    input?: string[]
    output?: string[]
  }
  limit?: {
    context?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
  }
  attached?: boolean
}

export interface Provider {
  id: string
  name: string
  source?: string
  models: ProviderModel[]
  connected: string[] // model IDs that are connected/available
  env?: string[]
  options?: Record<string, unknown>
}

/** Raw response from GET /provider */
export interface ProviderResponse {
  all: RawProvider[]
  default: Record<string, string>
  connected: string[] // connected provider IDs
}

/** Raw provider shape from the API (models as object map) */
export interface RawProvider {
  id: string
  name: string
  source?: string
  env?: string[]
  options?: Record<string, unknown>
  models: Record<string, ProviderModel>
}

export interface ProviderAuthInfo {
  id: string
  name: string
  type: string
  env?: string[]
  set?: boolean
}

/** Raw response from GET /provider/auth — map of providerId to auth methods */
export type ProviderAuthResponse = Record<string, ProviderAuthMethod[]>

export interface ProviderAuthMethod {
  type: string
  label: string
}

// --- Config types ---

export interface OpenCodeConfig {
  model?: string
  provider?: Record<string, { options?: Record<string, unknown> }>
  [key: string]: unknown
}

// --- Agent types ---

export interface Agent {
  id: string
  name: string
  description?: string
  model?: string
  system?: string
}

// --- Model override for per-message model selection ---

export interface ModelOverride {
  providerID: string
  modelID: string
}

// --- Prompt async request ---

export interface PromptAsyncRequest {
  parts: Array<{ type: string; text?: string; [key: string]: any }>
  agent?: string
  model?: ModelOverride
}

// --- MCP types ---

export interface MCPConfigLocal {
  type: "local"
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export interface MCPConfigRemote {
  type: "remote"
  url: string
  enabled?: boolean
  headers?: Record<string, string>
  timeout?: number
}

export type MCPConfig = MCPConfigLocal | MCPConfigRemote

export type MCPStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

export type MCPStatusMap = Record<string, MCPStatus>

// --- Command / Skill types ---

export interface Command {
  name: string
  description: string
  source: string
  template: string
  hints?: string[]
}

export interface Skill {
  name: string
  description: string
  location?: string   // SKILL.md file path
  content?: string    // SKILL.md content
  [key: string]: unknown
}

// --- File browsing types ---

export interface FileEntry {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

export interface FileStatusEntry {
  path: string
  added: number
  removed: number
  status: string
}

export interface FileContentResponse {
  type: string
  content: string
  diff?: string
  encoding?: string
  mimeType?: string
}

// --- Channel types (channel-gateway :4097) ---

export type ChannelState = "disconnected" | "connecting" | "connected" | "error"

export interface ChannelStatus {
  id: string
  type: string
  name: string
  state: ChannelState
  error?: string
  connectedAt?: string
}

interface ChannelConfigBase {
  id: string
  name: string
  workspaceDir: string
  autoConnect: boolean
}

export interface DingTalkChannelConfig extends ChannelConfigBase {
  type: "dingtalk"
  clientId: string
  clientSecret: string
}

export interface WeChatChannelConfig extends ChannelConfigBase {
  type: "wechat"
  botToken: string
  ilinkBotId: string
  ilinkUserId: string
  baseUrl: string
}

export type ChannelConfig = DingTalkChannelConfig | WeChatChannelConfig

export interface ChannelListResponse {
  channels: ChannelStatus[]
  configs: ChannelConfig[]
}

// --- WeChat QR login types ---

export interface WeChatQRCodeResponse {
  qrcodeUrl: string
  qrcodeImgContent: string
  token: string
}

export interface WeChatQRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired"
  channelId?: string
  error?: string
}

// --- Pagination ---

export interface PaginatedMessagesResponse {
  messages: SendMessageResponse[]
  cursor: string | undefined
  hasMore: boolean
}
