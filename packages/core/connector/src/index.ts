// @agent/connector — backend-agnostic control + event unification layer (ADR-030).
// Wraps (does not replace) @agent/api-client; pluggable AgentBackend adapters.

export {
  sessionIdOf,
  type ConnectorEvent,
  type SSEEvent,
  type ConnectorEventHandler,
  type SSEEventHandler,
  type PartDeltaProperties,
  type SessionUpdatedProperties,
  type SessionStatusProperties,
  type LegacyDeltaProperties,
  type LegacyCompletedProperties,
} from "./events"

export {
  OPENCODE_DEFAULT_AGENT_ID,
  makeAgentId,
  parseAgentId,
  isACPAgentId,
  type AgentBackend,
  type AgentSource,
  type BackendCapabilities,
  type BackendKind,
  type ConnectionStatus,
  type CreateSessionOptions,
  type FetchHistoryOptions,
  type FetchHistoryResult,
  type PermissionReply,
  type PromptOptions,
  type SessionRef,
  type TransportFamily,
  type UnifiedAgent,
  type UnifiedAgentStatus,
  type Unsubscribe,
} from "./types"

export {
  createSseTransport,
  type SseRetryPolicy,
  type SseTransport,
  type SseTransportOptions,
  type TransportStatus,
} from "./sse-transport"

export { BindingStore, type BindingCache, type BindingStoreOptions } from "./binding-store"

export {
  OpenCodeBackend,
  OPENCODE_BACKEND_KIND,
  FINITE_SSE_RETRY,
  UNLIMITED_SSE_RETRY,
  type OpenCodeBackendOptions,
} from "./backends/opencode"

export { Connector, type ConnectorOptions } from "./connector"
