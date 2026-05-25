import { useEffect, useRef } from "react"
import { getACPSessionEventsURL } from "./agent-router"
import type { SSEEvent } from "./sse-client"

/**
 * Subscribe to ACP Sidecar SSE events for a specific ACP session.
 * Events are rewritten to use the OpenCode sessionID so the existing
 * handleSSEEvent filter (which matches by OpenCode session ID) passes them through.
 *
 * Automatically connects when acpSessionId is set, disconnects on cleanup.
 * On connection loss, retries up to 3 times with exponential backoff.
 */
export function useACPSSE(
  acpSessionId: string | null,
  openCodeSessionId: string | undefined,
  onEvent: (event: SSEEvent) => void,
) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!acpSessionId || !openCodeSessionId) return

    let closed = false
    let retryCount = 0
    let retryTimer: ReturnType<typeof setTimeout>
    let es: EventSource
    const MAX_RETRIES = 3

    const connectSSE = () => {
      const url = getACPSessionEventsURL(acpSessionId)
      es = new EventSource(url)

      es.onopen = () => { retryCount = 0 }

      es.onmessage = (e) => {
        try {
          const event: SSEEvent = JSON.parse(e.data)
          if (event.type === "heartbeat" || event.type === "acp.connected") return

          // Rewrite sessionID in event properties to match OpenCode session ID,
          // so handleSSEEvent's session filter passes these events through.
          const rewriteSessionID = (obj: Record<string, unknown>) => {
            if (obj.sessionID) obj.sessionID = openCodeSessionId
          }

          const props = event.properties as Record<string, unknown>
          rewriteSessionID(props)
          if (props.part && typeof props.part === "object") {
            rewriteSessionID(props.part as Record<string, unknown>)
          }
          if (props.info && typeof props.info === "object") {
            rewriteSessionID(props.info as Record<string, unknown>)
          }

          onEventRef.current(event)
        } catch {
          // Malformed event — skip
        }
      }

      es.onerror = () => {
        if (closed) return
        es.close()
        if (retryCount < MAX_RETRIES) {
          const delay = 1000 * Math.pow(2, retryCount)
          retryCount++
          console.warn(`[ACP SSE] Connection lost, retry ${retryCount}/${MAX_RETRIES} in ${delay}ms`)
          retryTimer = setTimeout(connectSSE, delay)
        } else {
          console.error(`[ACP SSE] Connection lost after ${MAX_RETRIES} retries for session ${acpSessionId}`)
          // Emit a synthetic error event so the UI can surface it
          onEventRef.current({
            type: "session.error",
            properties: {
              sessionID: openCodeSessionId,
              error: "ACP SSE connection lost",
            },
          })
        }
      }
    }

    connectSSE()

    return () => {
      closed = true
      clearTimeout(retryTimer)
      es?.close()
    }
  }, [acpSessionId, openCodeSessionId])
}
