import { toast } from "sonner"
import type { ApiClientConfig, MessagePart, MessageInfo, PermissionRequest, QuestionRequest } from "@agent/api-client"

// SSE Event types aligned with OpenCode upstream
export type SSEEvent =
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "server.heartbeat"; properties: Record<string, never> }
  // Part-level events (OpenCode primary streaming mechanism)
  | { type: "message.part.updated"; properties: { part: MessagePart } }
  | { type: "message.part.delta"; properties: PartDeltaProperties }
  | { type: "message.part.removed"; properties: { sessionID: string; messageID: string; partID: string } }
  // Message-level events
  | { type: "message.updated"; properties: { info: MessageInfo } }
  | { type: "message.removed"; properties: { sessionID: string; messageID: string } }
  // Session events
  | { type: "session.updated"; properties: SessionUpdatedProperties }
  | { type: "session.created"; properties: { id: string; [key: string]: any } }
  | { type: "session.deleted"; properties: { id: string } }
  | { type: "session.status"; properties: SessionStatusProperties }
  // Permission / Question blocking-interaction events
  | { type: "permission.asked"; properties: PermissionRequest }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string; reply: string } }
  | { type: "question.asked"; properties: QuestionRequest }
  | { type: "question.replied"; properties: { sessionID: string; requestID: string; answers: string[][] } }
  | { type: "question.rejected"; properties: { sessionID: string; requestID: string } }
  // Legacy events (kept for backward compatibility if server sends them)
  | { type: "message.delta"; properties: LegacyDeltaProperties }
  | { type: "message.completed"; properties: LegacyCompletedProperties }
  // Catch-all for unknown event types
  | { type: string; properties: Record<string, any> }

export interface PartDeltaProperties {
  sessionID: string
  messageID: string
  partID: string
  field: string
  delta: string
}

export interface SessionUpdatedProperties {
  sessionID?: string
  id?: string
  title?: string
  [key: string]: any
}

export interface SessionStatusProperties {
  sessionID: string
  status: { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number }
}

// Legacy types kept for backward compat
export interface LegacyDeltaProperties {
  sessionID: string
  messageID: string
  delta: string
}

export interface LegacyCompletedProperties {
  sessionID: string
  messageID: string
}

export type SSEEventHandler = (event: SSEEvent) => void

export class SSEClient {
  private abortController: AbortController | null = null
  private handlers: Set<SSEEventHandler> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private isConnected = false
  private shouldReconnect = true

  constructor(private config: ApiClientConfig) {}

  async connect(): Promise<void> {
    if (this.abortController) {
      console.warn("SSE already connected")
      return
    }

    this.shouldReconnect = true

    // Build URL with optional directory query parameter
    const baseEventUrl = this.config.baseUrl
      ? new URL("/event", this.config.baseUrl).toString()
      : "/event"
    const params = new URLSearchParams()
    if (this.config.workingDirectory) params.set("directory", this.config.workingDirectory)
    const query = params.toString()
    const url = query ? `${baseEventUrl}?${query}` : baseEventUrl

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
    }

    if (this.config.password) {
      const username = this.config.username || "opencode"
      const credentials = btoa(`${username}:${this.config.password}`)
      headers["Authorization"] = `Basic ${credentials}`
    }

    if (this.config.workingDirectory) {
      headers["x-opencode-directory"] = encodeURIComponent(this.config.workingDirectory)
    }

    console.log("Connecting to SSE:", url)

    const controller = new AbortController()
    this.abortController = controller

    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
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

        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

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
      // Only clean up if we're still the current connection (guard against forceReconnect race)
      if (this.abortController === controller) {
        this.isConnected = false
        this.abortController = null
      }
    }

    if (this.shouldReconnect) {
      this.scheduleReconnect()
    }
  }

  disconnect(): void {
    this.shouldReconnect = false

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

  /** Force-reconnect without disabling shouldReconnect (used by heartbeat timeout). */
  forceReconnect(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.reconnectAttempts = 0
    this.isConnected = false
    this.connect().catch((err) => {
      console.error("forceReconnect failed:", err)
    })
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
