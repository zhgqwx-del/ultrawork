// SSE subscription for ACP-bound sessions. The sidecar stamps the desktop's
// own session id on every shaped event (clientSessionId), so events flow into
// the same handlers as opencode's with no id rewriting.
//
// Connections are shared: multiple hooks on the same session (messages +
// permissions) multiplex one EventSource via a refcounted registry.

import { useEffect, useRef } from "react"
import { acpEventsURL } from "./agent-router"
import type { SSEEvent } from "./sse-client"

const MAX_RECONNECTS = 5
const RECONNECT_BASE_DELAY = 1000

type Handler = (event: SSEEvent) => void

interface SharedConnection {
  handlers: Set<Handler>
  close: () => void
}

const connections = new Map<string, SharedConnection>()

function acquire(sessionId: string, handler: Handler): () => void {
  let shared = connections.get(sessionId)
  if (!shared) {
    shared = open(sessionId)
    connections.set(sessionId, shared)
  }
  shared.handlers.add(handler)
  return () => {
    shared.handlers.delete(handler)
    if (shared.handlers.size === 0) {
      shared.close()
      connections.delete(sessionId)
    }
  }
}

function open(sessionId: string): SharedConnection {
  const handlers = new Set<Handler>()
  let es: EventSource | null = null
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const connect = () => {
    if (closed) return
    es = new EventSource(acpEventsURL(sessionId))
    es.onopen = () => {
      attempts = 0
    }
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as SSEEvent
        if (event.type === "heartbeat" || event.type === "acp.connected") return
        for (const handler of handlers) handler(event)
      } catch {
        // malformed frame — skip
      }
    }
    es.onerror = () => {
      es?.close()
      es = null
      if (closed || attempts >= MAX_RECONNECTS) return
      attempts++
      reconnectTimer = setTimeout(connect, RECONNECT_BASE_DELAY * 2 ** (attempts - 1))
    }
  }

  connect()
  return {
    handlers,
    close: () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
    },
  }
}

export function useACPSSE(sessionId: string | undefined, onEvent: Handler): void {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!sessionId) return
    const handler: Handler = (event) => onEventRef.current(event)
    return acquire(sessionId, handler)
  }, [sessionId])
}
