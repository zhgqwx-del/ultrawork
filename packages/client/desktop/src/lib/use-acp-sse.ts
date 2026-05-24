import { useEffect, useRef } from "react"
import { getACPSessionEventsURL } from "./agent-router"
import type { SSEEvent } from "./sse-client"

/**
 * Subscribe to ACP Sidecar SSE events for a specific ACP session.
 * Events are converted to the same SSEEvent format as OpenCode SSE
 * and forwarded to the provided handler.
 *
 * Automatically connects when acpSessionId is set, disconnects on cleanup.
 */
export function useACPSSE(
  acpSessionId: string | null,
  onEvent: (event: SSEEvent) => void,
) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!acpSessionId) return

    const url = getACPSessionEventsURL(acpSessionId)
    const eventSource = new EventSource(url)

    eventSource.onmessage = (e) => {
      try {
        const event: SSEEvent = JSON.parse(e.data)
        if (event.type === "heartbeat" || event.type === "acp.connected") return
        onEventRef.current(event)
      } catch {
        // Malformed event — skip
      }
    }

    eventSource.onerror = () => {
      // EventSource auto-reconnects, just log
      console.warn(`[ACP SSE] Connection error for session ${acpSessionId}`)
    }

    return () => {
      eventSource.close()
    }
  }, [acpSessionId])
}
