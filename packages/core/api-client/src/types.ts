// OpenCode API Types — aligned with upstream packages/sdk/js/src/gen/types.gen.ts

export interface ApiClientConfig {
  baseUrl: string
  username?: string
  password?: string
  workingDirectory?: string
}

export interface SessionCreateRequest {
  agent?: string
  /** Parent session id — child sessions are excluded from `roots:true` listings. */
  parentID?: string
  title?: string
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

// --- Plan / task-plan step (ADR-038) ---

/**
 * One task-plan step. The unified model for the right-sidebar plan panel,
 * fed by OpenCode's `todowrite` (REST `GET /session/{id}/todo` + `todo.updated`
 * SSE) and ACP's `session/update:plan`. Both backends emit the WHOLE list each
 * time (整表替换 semantics), so "latest array" is always complete.
 *
 * `status`/`priority` mirror opencode's loose `z.string()` schema; the listed
 * unions are the documented set. ACP only ever produces the first three
 * statuses (no `cancelled`).
 */
export interface PlanStep {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority?: "high" | "medium" | "low"
}

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
  // Set when the assistant turn ends in an error (e.g. provider APIError,
  // content moderation). The opencode wire carries this even though `finish`
  // stays undefined for errored turns — so error IS a terminal state. Shape is
  // loose: opencode uses `{ name, data: { message, ... } }`, others may use a
  // plain string. (Data already passes through getMessages untouched; this just
  // types it so the renderer can treat an errored turn as terminal.)
  error?: { name?: string; data?: { message?: string }; message?: string } | string
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

/**
 * A single model entry inside a config provider's `models` map. Mirrors the
 * fields opencode accepts (models.dev `Model`, applied as `partial()`): the
 * capability booleans, `cost`/`limit`, plus `modalities`/`headers`/`options`
 * (model-level `options` is merged into the AI SDK `providerOptions` at call
 * time — vendor `session/llm.ts`). The "advanced JSON" escape hatch passes any
 * OTHER valid field through `deepMergePlain` (typed loosely there, not here) —
 * opencode's schema is non-strict, so unknown keys are silently stripped rather
 * than rejected. Kept as a closed interface so typos in literals are caught.
 */
export interface ProviderConfigModel {
  id?: string
  name?: string
  tool_call?: boolean
  reasoning?: boolean
  attachment?: boolean
  temperature?: boolean
  cost?: { input?: number; output?: number }
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
  headers?: Record<string, string>
  options?: Record<string, unknown>
}

/**
 * Config-level provider definition (opencode.json `provider.<id>`). A superset
 * of the legacy `{ options }` shape — supports defining a brand-new custom
 * provider (name/npm/api/models) beyond just overriding an existing one.
 */
export interface ProviderConfig {
  name?: string
  npm?: string
  api?: string
  env?: string[]
  models?: Record<string, ProviderConfigModel>
  /** Restrict exposed models to these ids — hides stale models that linger in
   *  `models` after a delete→re-add (PATCH can't remove config keys). */
  whitelist?: string[]
  options?: Record<string, unknown>
}

// --- BYOK web search (ADR-042) ---

export type WebsearchProviderId = "tavily" | "aliyun-iqs" | "exa"

/** `experimental.websearch` in the global opencode.json. API keys are NOT here —
 *  they live in auth.json under the `search-tavily` / `search-aliyun-iqs` ids. */
export interface WebsearchConfig {
  /** Master toggle; only `false` disables (unset = on when a provider is configured). */
  enabled?: boolean
  /** Preferred provider. "auto" = no explicit preference (PATCH merge can't
   *  delete keys, so "auto" exists to clear a previous explicit choice). */
  provider?: WebsearchProviderId | "auto"
  /** Opt in to Exa's keyless public MCP endpoint (off by default). */
  exa?: boolean
  tavily?: { searchDepth?: "basic" | "advanced" }
  aliyunIqs?: { engineType?: "Generic" | "GenericAdvanced" | "LiteAdvanced" | "Deep" }
}

/** auth.json ids for BYOK search keys (safe: unknown ids are skipped by
 *  provider enumeration — they never become phantom model providers). */
export const SEARCH_AUTH_IDS = {
  tavily: "search-tavily",
  "aliyun-iqs": "search-aliyun-iqs",
} as const

/** Response of `GET /global/auth/:authId/status` — presence only, never the key. */
export interface AuthStatus {
  configured: boolean
  type?: "api" | "oauth" | "wellknown"
}

export interface OpenCodeConfig {
  model?: string
  provider?: Record<string, ProviderConfig>
  /** Provider IDs hidden from `GET /provider` (used to "delete" custom providers). */
  disabled_providers?: string[]
  experimental?: {
    websearch?: WebsearchConfig
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** Supported protocols for a user-defined custom provider. */
export type CustomProviderProtocol = "openai" | "anthropic"

/** A single model row collected by the "add custom provider" form. */
export interface CustomProviderModelDef {
  id: string
  name: string
  context?: number
  output?: number
  /** Capability flags. `toolCall` defaults to true when omitted. */
  toolCall?: boolean
  reasoning?: boolean
  attachment?: boolean
  /** Image input → emitted as `modalities: { input: ["text","image"], output: ["text"] }`. */
  vision?: boolean
  /** Model-native web search (Aliyun DashScope `enable_search`) → emitted as
   *  `options: { enable_search: true }`. Reuses the provider's API key. */
  builtinSearch?: boolean
  /**
   * Raw extra fields (parsed JSON object), deep-merged into the model config
   * LAST so it can override anything above (e.g. `options`, `headers`, a custom
   * `modalities`/`cost`/`limit`). The form is responsible for parsing/validating.
   */
  advanced?: Record<string, unknown>
}

/** Input collected by the "add custom provider" form. */
export interface CustomProviderDef {
  id: string
  name: string
  protocol: CustomProviderProtocol
  baseURL: string
  apiKey?: string
  models: CustomProviderModelDef[]
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
  /**
   * Per-tool enable/disable, applied by the server as a session-level
   * permission ruleset (wildcard keys like "orchestrator_*" supported).
   */
  tools?: Record<string, boolean>
  /**
   * Extra system prompt, appended after the agent's base prompt for THIS
   * message only (not sticky on the session).
   */
  system?: string
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

// --- Channel QR login types (mirrors gateway qr-registry.ts) ---

export type ChannelQRState =
  | "pending"    // waiting for scan
  | "scanned"    // scanned, awaiting in-app confirmation
  | "authorized" // credentials delivered, channel created
  | "expired"
  | "denied"
  | "error"

export interface ChannelQRStartResponse {
  token: string
  qrContent: string
}

export interface ChannelQRStatusResponse {
  status: ChannelQRState
  channelId?: string
  error?: string
}

// --- Pagination ---

export interface PaginatedMessagesResponse {
  messages: SendMessageResponse[]
  cursor: string | undefined
  hasMore: boolean
}
