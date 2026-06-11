import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react"
import { toast } from "sonner"
import {
  Connector,
  OpenCodeBackend,
  OPENCODE_BACKEND_KIND,
  FINITE_SSE_RETRY,
  type SSEEvent,
  type SSEEventHandler,
} from "@agent/connector"
import { useConfig } from "./config-context"
import { useWorkspace } from "./workspace-context"

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
    const c = new Connector()
    c.registerBackend(
      new OpenCodeBackend({
        baseUrl: import.meta.env.DEV ? "" : config.apiBaseUrl,
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
