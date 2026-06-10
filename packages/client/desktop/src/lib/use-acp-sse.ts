// SSE subscription for ACP-bound sessions. The sidecar stamps the desktop's
// own session id on every shaped event (clientSessionId), so events flow into
// the same handleSSEEvent as opencode's with no id rewriting.

import { useEffect, useRef } from "react"
import { acpEventsURL } from "./agent-router"
import type { SSEEvent } from "./sse-client"

const MAX_RECONNECTS = 5
const RECONNECT_BASE_DELAY = 1000

export function useACPSSE(sessionId: string | undefined, onEvent: (event: SSEEvent) => void): void {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!sessionId) return

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
          onEventRef.current(event)
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
    return () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
    }
  }, [sessionId])
}
