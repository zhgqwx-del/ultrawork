import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react"
import { SSEClient, type SSEEvent, type SSEEventHandler } from "./sse-client"
import { useApi } from "./use-api"
import { useWorkspace } from "./workspace-context"

interface SSEContextValue {
  /** Subscribe a handler that receives all SSE events. Returns unsubscribe fn. */
  subscribe: (handler: SSEEventHandler) => () => void
  /** Whether the SSE connection is alive (heartbeat received within 30s) */
  connected: boolean
}

const SSEContext = createContext<SSEContextValue | null>(null)

const HEARTBEAT_TIMEOUT = 30_000

export function SSEProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const { workspacePath } = useWorkspace()
  const clientRef = useRef<SSEClient | null>(null)
  const handlersRef = useRef<Set<SSEEventHandler>>(new Set())
  const [connected, setConnected] = useState(false)
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Master handler dispatches to all subscribers + tracks heartbeat
  const masterHandler = useCallback((event: SSEEvent) => {
    // Reset heartbeat timer on any event
    setConnected(true)
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current)
    heartbeatTimerRef.current = setTimeout(() => setConnected(false), HEARTBEAT_TIMEOUT)

    // Dispatch to all subscribers
    handlersRef.current.forEach((h) => h(event))
  }, [])

  // Create/destroy SSE client when workspace changes
  useEffect(() => {
    // Don't connect when no workspace is selected (workspace selector page)
    if (workspacePath === null) {
      setConnected(false)
      return
    }

    const credentials = api.getCredentials()
    const client = new SSEClient({
      baseUrl: api.getBaseUrl(),
      username: credentials.username || "user",
      password: credentials.password || "password",
      workingDirectory: workspacePath || undefined,
    })

    clientRef.current = client

    const unsubscribe = client.on(masterHandler)
    client.connect()

    return () => {
      unsubscribe()
      client.disconnect()
      clientRef.current = null
      if (heartbeatTimerRef.current) {
        clearTimeout(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }
      setConnected(false)
    }
  }, [api, workspacePath, masterHandler])

  const subscribe = useCallback((handler: SSEEventHandler) => {
    handlersRef.current.add(handler)
    return () => { handlersRef.current.delete(handler) }
  }, [])

  const value = useMemo<SSEContextValue>(() => ({ subscribe, connected }), [subscribe, connected])

  return (
    <SSEContext.Provider value={value}>
      {children}
    </SSEContext.Provider>
  )
}

/** Subscribe to all SSE events. Handler is kept up-to-date via ref. */
export function useSSESubscribe(handler: SSEEventHandler) {
  const ctx = useContext(SSEContext)
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
  const ctx = useContext(SSEContext)
  if (!ctx) throw new Error("useSSEConnected must be used within SSEProvider")
  return ctx.connected
}
