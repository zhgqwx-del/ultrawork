import { toast } from "sonner"
import type { ApiClientConfig } from "@agent/api-client"

// SSE Event types from OpenCode
export type SSEEvent =
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "server.heartbeat"; properties: Record<string, never> }
  | { type: "message.delta"; properties: MessageDeltaProperties }
  | { type: "message.completed"; properties: MessageCompletedProperties }
  | { type: "session.updated"; properties: SessionUpdatedProperties }

export interface MessageDeltaProperties {
  sessionID: string
  messageID: string
  delta: string
}

export interface MessageCompletedProperties {
  sessionID: string
  messageID: string
}

export interface SessionUpdatedProperties {
  sessionID: string
  title?: string
}

export type SSEEventHandler = (event: SSEEvent) => void

export class SSEClient {
  private abortController: AbortController | null = null
  private handlers: Set<SSEEventHandler> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000 // Start with 1s
  private isConnected = false
  private shouldReconnect = true // Track if we should reconnect

  constructor(private config: ApiClientConfig) {}

  async connect(): Promise<void> {
    if (this.abortController) {
      console.warn("SSE already connected")
      return
    }

    this.shouldReconnect = true // Enable reconnection when connecting

    const url = this.config.baseUrl
      ? new URL("/event", this.config.baseUrl).toString()
      : "/event"

    // Prepare headers for Basic Auth
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
    }

    if (this.config.password) {
      const username = this.config.username || "opencode"
      const credentials = btoa(`${username}:${this.config.password}`)
      headers["Authorization"] = `Basic ${credentials}`
    }

    console.log("Connecting to SSE:", url)

    this.abortController = new AbortController()

    try {
      const response = await fetch(url, {
        headers,
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`)
      }

      if (!response.body) {
        throw new Error("SSE response has no body")
      }

      console.log("SSE connected")
      this.isConnected = true
      this.reconnectAttempts = 0

      // Read the stream
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          console.log("SSE stream ended")
          break
        }

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE format: "data: {...}\n\n"
        const lines = buffer.split("\n")
        buffer = lines.pop() || "" // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data: SSEEvent = JSON.parse(line.slice(6))
              this.handlers.forEach((handler) => handler(data))
            } catch (err) {
              console.error("Failed to parse SSE event:", err, line)
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("SSE connection aborted")
        return
      }
      console.error("SSE error:", err)
    } finally {
      this.isConnected = false
      this.abortController = null
    }

    // Reconnect if we should reconnect (not manually disconnected)
    if (this.shouldReconnect) {
      this.scheduleReconnect()
    }
  }

  disconnect(): void {
    this.shouldReconnect = false // Disable reconnection on manual disconnect

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.isConnected = false
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      console.log("Reconnection disabled, not reconnecting")
      return
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnect attempts reached, giving up")
      toast.error("Connection lost. Please check the server and refresh.")
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }

  on(handler: SSEEventHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  getConnectionState(): boolean {
    return this.isConnected
  }
}
