import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react"
import { toast } from "sonner"
import {
  Connector,
  OpenCodeBackend,
  OPENCODE_BACKEND_KIND,
  ACPBackend,
  BindingStore,
  FINITE_SSE_RETRY,
  type BindingCache,
  type SSEEvent,
  type SSEEventHandler,
} from "@agent/connector"
import { useConfig } from "./config-context"
import { useWorkspace } from "./workspace-context"
import { resolveApiBaseUrl } from "./config"
import { acpBaseUrl } from "./sidecar-ports"

const BINDINGS_STORAGE_KEY = "uw.acp.sessionAgents"

// localStorage is a warm cache; the sidecar's persisted sessions are the
// source of truth after hydration (AgentProvider, ADR-030).
const localStorageBindingCache: BindingCache = {
  load: () => JSON.parse(localStorage.getItem(BINDINGS_STORAGE_KEY) ?? "{}") as Record<string, string>,
  save: (bindings) => localStorage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(bindings)),
}

interface ConnectorContextValue {
  /** Backend-agnostic control plane (ADR-030). */
  connector: Connector
  /** Subscribe a handler that receives all global SSE events. Returns unsubscribe fn. */
  subscribe: (handler: SSEEventHandler) => () => void
  /** Whether the SSE connection is alive (open + heartbeat within 30s) */
  connected: boolean
}

const ConnectorContext = createContext<ConnectorContextValue | null>(null)

const HEARTBEAT_TIMEOUT = 30_000
const MAX_HEARTBEAT_RECONNECTS = 3

/**
 * Owns the Connector for the current config/workspace. Historically named
 * SSEProvider (kept to minimize churn); since ADR-030 it provides the whole
 * control plane, with the global opencode /event stream as one part.
 */
export function SSEProvider({ children }: { children: ReactNode }) {
  const { config } = useConfig()
  const { workspacePath } = useWorkspace()
  const handlersRef = useRef<Set<SSEEventHandler>>(new Set())
  const [connected, setConnected] = useState(false)

  // Same dependency set as the legacy useApi()/SSEClient pair: a new connector
  // (and thus a new ApiClient reference) appears exactly when those did.
  const connector = useMemo(() => {
    const c = new Connector({ bindings: new BindingStore({ cache: localStorageBindingCache }) })
    c.registerBackend(
      new OpenCodeBackend({
        baseUrl: resolveApiBaseUrl(config.apiBaseUrl),
        username: config.apiUsername,
        password: config.apiPassword,
        workingDirectory: workspacePath || undefined,
        sse: {
          retry: FINITE_SSE_RETRY,
          heartbeatTimeoutMs: HEARTBEAT_TIMEOUT,
          heartbeatReconnectBudget: MAX_HEARTBEAT_RECONNECTS,
        },
      }),
    )
    c.registerBackend(new ACPBackend({ baseUrl: acpBaseUrl() }))
    return c
  }, [config.apiBaseUrl, config.apiUsername, config.apiPassword, workspacePath])

  // Dispose the previous connector (closes its SSE) when a new one replaces it.
  useEffect(() => {
    return () => connector.dispose()
  }, [connector])

  // Master handler dispatches to all subscribers (stable across connector swaps)
  const masterHandler = useCallback((event: SSEEvent) => {
    handlersRef.current.forEach((h) => h(event))
  }, [])

  // Connect the global event stream when a workspace is selected
  useEffect(() => {
    // Don't connect when no workspace is selected (workspace selector page)
    if (workspacePath === null) {
      setConnected(false)
      return
    }

    const opencode = connector.getBackend<OpenCodeBackend>(OPENCODE_BACKEND_KIND)
    if (!opencode) return

    const unsubscribeEvents = connector.subscribeGlobal(masterHandler)
    const unsubscribeStatus = opencode.onTransportStatusChange((status) => {
      setConnected(status === "open")
      if (status === "gave-up") {
        toast.error("Connection lost. Please check the server and refresh.")
      }
    })
    opencode.connectGlobal()

    return () => {
      unsubscribeEvents()
      unsubscribeStatus()
      setConnected(false)
    }
  }, [connector, workspacePath, masterHandler])

  const subscribe = useCallback((handler: SSEEventHandler) => {
    handlersRef.current.add(handler)
    return () => { handlersRef.current.delete(handler) }
  }, [])

  const value = useMemo<ConnectorContextValue>(
    () => ({ connector, subscribe, connected }),
    [connector, subscribe, connected],
  )

  return (
    <ConnectorContext.Provider value={value}>
      {children}
    </ConnectorContext.Provider>
  )
}

/** The backend-agnostic control plane for the current config/workspace. */
export function useConnector(): Connector {
  const ctx = useContext(ConnectorContext)
  if (!ctx) throw new Error("useConnector must be used within SSEProvider")
  return ctx.connector
}

/** Subscribe to all global SSE events. Handler is kept up-to-date via ref. */
export function useSSESubscribe(handler: SSEEventHandler) {
  const ctx = useContext(ConnectorContext)
  if (!ctx) throw new Error("useSSESubscribe must be used within SSEProvider")

  // Destructure subscribe so we depend on the stable useCallback ref,
  // NOT the full context value (which changes when `connected` toggles).
  const { subscribe } = ctx
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const wrappedHandler: SSEEventHandler = (event) => handlerRef.current(event)
    return subscribe(wrappedHandler)
  }, [subscribe])
}

/** Read global SSE connection status (heartbeat-based). */
export function useSSEConnected(): boolean {
  const ctx = useContext(ConnectorContext)
  if (!ctx) throw new Error("useSSEConnected must be used within SSEProvider")
  return ctx.connected
}

/**
 * Per-session events, dispatched by the session's backend binding: opencode
 * sessions filter the global stream; ACP sessions merge the sidecar stream
 * with the global stream (canonical title/delete events live there).
 * Re-subscribes when the binding changes.
 */
export function useSessionSubscribe(sessionId: string | undefined, handler: SSEEventHandler) {
  const connector = useConnector()
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const binding = useSyncExternalStore(
    useCallback((cb) => connector.bindings.onChange(cb), [connector]),
    () => (sessionId ? connector.bindings.get(sessionId) : ""),
  )

  useEffect(() => {
    if (!sessionId) return
    return connector.subscribeSession(sessionId, (event) => handlerRef.current(event))
  }, [connector, sessionId, binding])
}
