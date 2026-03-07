import { useEffect, useRef } from "react"
import { SSEClient, type SSEEvent, type SSEEventHandler } from "./sse-client"
import { useApi } from "./use-api"
import { useWorkspace } from "./workspace-context"

export function useSSE(handler: SSEEventHandler) {
  const api = useApi()
  const { workspacePath } = useWorkspace()
  const clientRef = useRef<SSEClient | null>(null)
  const handlerRef = useRef(handler)

  // Keep handler ref up to date
  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => {
    // Create SSE client with workspace directory
    const credentials = api.getCredentials()
    const client = new SSEClient({
      baseUrl: api.getBaseUrl(),
      username: credentials.username || "user",
      password: credentials.password || "password",
      workingDirectory: workspacePath || undefined,
    })

    clientRef.current = client

    // Subscribe to events
    const unsubscribe = client.on((event: SSEEvent) => {
      handlerRef.current(event)
    })

    // Connect
    client.connect()

    // Cleanup
    return () => {
      unsubscribe()
      client.disconnect()
      clientRef.current = null
    }
  }, [api, workspacePath])

  return clientRef.current
}
