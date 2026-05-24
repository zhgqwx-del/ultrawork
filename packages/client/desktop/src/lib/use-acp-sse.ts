import { useEffect, useRef } from "react"
import { getACPSessionEventsURL } from "./agent-router"
import type { SSEEvent } from "./sse-client"

/**
 * Subscribe to ACP Sidecar SSE events for a specific ACP session.
 * Events are rewritten to use the OpenCode sessionID so the existing
 * handleSSEEvent filter (which matches by OpenCode session ID) passes them through.
 *
 * Automatically connects when acpSessionId is set, disconnects on cleanup.
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

    const url = getACPSessionEventsURL(acpSessionId)
    const eventSource = new EventSource(url)

    eventSource.onmessage = (e) => {
      try {
        const event: SSEEvent = JSON.parse(e.data)
        if (event.type === "heartbeat" || event.type === "acp.connected") return

        // Rewrite sessionID in event properties to match OpenCode session ID,
        // so handleSSEEvent's session filter passes these events through.
        const props = event.properties as Record<string, unknown>
        if (props.sessionID) props.sessionID = openCodeSessionId
        if (props.messageID && typeof props.messageID === "string" && props.messageID.startsWith("acp-")) {
          // Keep ACP message IDs unique but make them findable
          props.messageID = `acp-${openCodeSessionId}-msg`
        }
        if (props.part && typeof props.part === "object") {
          const part = props.part as Record<string, unknown>
          if (part.sessionID) part.sessionID = openCodeSessionId
          if (part.messageID && typeof part.messageID === "string" && part.messageID.startsWith("acp-")) {
            part.messageID = `acp-${openCodeSessionId}-msg`
          }
        }
        if (props.info && typeof props.info === "object") {
          const info = props.info as Record<string, unknown>
          if (info.sessionID) info.sessionID = openCodeSessionId
          if (info.id && typeof info.id === "string" && info.id.startsWith("acp-")) {
            info.id = `acp-${openCodeSessionId}-msg`
          }
        }

        onEventRef.current(event)
      } catch {
        // Malformed event — skip
      }
    }

    eventSource.onerror = () => {
      console.warn(`[ACP SSE] Connection error for session ${acpSessionId}`)
    }

    return () => {
      eventSource.close()
    }
  }, [acpSessionId, openCodeSessionId])
}
