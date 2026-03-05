import type { ApiClientConfig } from "@agent/api-client"

// SSE Event types from OpenCode
export interface SSEEvent {
  directory: string
  payload: EventPayload
}

export type EventPayload =
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
  private eventSource: EventSource | null = null
  private handlers: Set<SSEEventHandler> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000 // Start with 1s

  constructor(private config: ApiClientConfig) {}

  connect(): void {
    if (this.eventSource) {
      console.warn("SSE already connected")
      return
    }

    const url = new URL("/event", this.config.baseUrl)

    // Add Basic Auth to URL if credentials provided
    if (this.config.username && this.config.password) {
      url.username = this.config.username
      url.password = this.config.password
    }

    console.log("Connecting to SSE:", url.toString().replace(/:[^:@]+@/, ":***@"))

    this.eventSource = new EventSource(url.toString())

    this.eventSource.onopen = () => {
      console.log("SSE connected")
      this.reconnectAttempts = 0
      this.reconnectDelay = 1000
    }

    this.eventSource.onmessage = (event) => {
      try {
        const data: SSEEvent = JSON.parse(event.data)
        this.handlers.forEach((handler) => handler(data))
      } catch (err) {
        console.error("Failed to parse SSE event:", err, event.data)
      }
    }

    this.eventSource.onerror = (error) => {
      console.error("SSE error:", error)
      this.disconnect()
      this.scheduleReconnect()
    }
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnect attempts reached, giving up")
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

  isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN
  }
}
