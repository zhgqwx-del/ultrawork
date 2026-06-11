import type { ConnectorEvent } from "./events"

// Parameterized fetch-reader SSE transport (ADR-030 D-2). Absorbs the three
// historical implementations:
//   - desktop sse-client.ts   → finite retry (5), heartbeat watchdog via context
//   - gateway bridge.ts       → unlimited retry capped at 30s
//   - desktop use-acp-sse.ts  → EventSource, finite retry (5), silent
// fetch-reader works in both browser and bun; EventSource's auto-reconnect was
// already overridden by manual onerror handling, so nothing is lost.

export type TransportStatus =
  | "idle"
  | "connecting"
  | "open"
  /** Heartbeat watchdog fired: connection looks half-open. */
  | "stalled"
  /** A connection attempt failed (transient; retry may follow). */
  | "error"
  | "reconnecting"
  /** Retry budget exhausted. Consumer decides UX (desktop: toast). */
  | "gave-up"
  | "closed"

export interface SseRetryPolicy {
  baseDelayMs: number
  /** Cap for exponential growth (gateway: 30s). */
  maxDelayMs?: number
  /** undefined = retry forever (gateway). */
  maxAttempts?: number
}

export interface SseTransportOptions {
  /** Absolute URL, or relative path for browser dev mode (Vite proxy). */
  url: string
  /** Lazily evaluated per connection attempt (gateway reads env at call time). */
  headers?: () => Record<string, string>
  retry: SseRetryPolicy
  /**
   * Watchdog: if no event (of any kind, pre-filtering) arrives within this
   * window, force-reconnect up to heartbeatReconnectBudget times (guards
   * against half-open TCP, ADR-008). Budget resets on every event.
   */
  heartbeatTimeoutMs?: number
  heartbeatReconnectBudget?: number
  onEvent: (event: ConnectorEvent) => void
  onStatusChange?: (status: TransportStatus) => void
}

export interface SseTransport {
  /** Resolves when the current stream ends (mirrors legacy SSEClient.connect). */
  connect(): Promise<void>
  close(): void
  /** Reconnect immediately without disabling auto-reconnect; resets retry attempts. */
  forceReconnect(): void
  getStatus(): TransportStatus
}

const DEFAULT_HEARTBEAT_BUDGET = 3

class FetchSseTransport implements SseTransport {
  private abortController: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatReconnects = 0
  private status: TransportStatus = "idle"
  private shouldReconnect = true

  constructor(private opts: SseTransportOptions) {}

  getStatus(): TransportStatus {
    return this.status
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true
    await this.run()
  }

  close(): void {
    this.shouldReconnect = false
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    this.clearTimers()
    this.setStatus("closed")
  }

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
    this.run().catch((err) => {
      console.error("forceReconnect failed:", err)
    })
  }

  private setStatus(status: TransportStatus): void {
    if (this.status === status) return
    this.status = status
    this.opts.onStatusChange?.(status)
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private handleEvent(event: ConnectorEvent): void {
    // Any event proves liveness: reset watchdog + budget (sse-context.tsx:28-45 semantics)
    this.heartbeatReconnects = 0
    this.armWatchdog()
    if (this.status === "stalled") this.setStatus("open")
    this.opts.onEvent(event)
  }

  private armWatchdog(): void {
    const timeout = this.opts.heartbeatTimeoutMs
    if (timeout === undefined) return
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = setTimeout(() => {
      this.setStatus("stalled")
      const budget = this.opts.heartbeatReconnectBudget ?? DEFAULT_HEARTBEAT_BUDGET
      if (this.heartbeatReconnects < budget && this.shouldReconnect) {
        this.heartbeatReconnects++
        console.log(`Heartbeat timeout, forcing reconnect (attempt ${this.heartbeatReconnects}/${budget})`)
        this.forceReconnect()
      }
    }, timeout)
  }

  private async run(): Promise<void> {
    if (this.abortController) {
      console.warn("SSE already connected")
      return
    }

    this.setStatus("connecting")

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(this.opts.headers?.() ?? {}),
    }

    const controller = new AbortController()
    this.abortController = controller

    try {
      const response = await fetch(this.opts.url, { headers, signal: controller.signal })

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`)
      }
      if (!response.body) {
        throw new Error("SSE response has no body")
      }

      this.reconnectAttempts = 0
      this.setStatus("open")

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
          if (!line.startsWith("data: ")) continue
          try {
            const data: ConnectorEvent = JSON.parse(line.slice(6))
            this.handleEvent(data)
          } catch (err) {
            console.error("Failed to parse SSE event:", err, line)
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return
      }
      console.error("SSE error:", err)
      this.setStatus("error")
    } finally {
      // Only clean up if we're still the current connection (guard against forceReconnect race)
      if (this.abortController === controller) {
        this.abortController = null
      }
    }

    if (this.shouldReconnect) {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return

    const { baseDelayMs, maxDelayMs, maxAttempts } = this.opts.retry
    if (maxAttempts !== undefined && this.reconnectAttempts >= maxAttempts) {
      console.error("Max reconnect attempts reached, giving up")
      this.setStatus("gave-up")
      return
    }

    this.reconnectAttempts++
    let delay = baseDelayMs * Math.pow(2, this.reconnectAttempts - 1)
    if (maxDelayMs !== undefined) delay = Math.min(delay, maxDelayMs)

    console.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}${maxAttempts !== undefined ? `/${maxAttempts}` : ""})`,
    )
    this.setStatus("reconnecting")
    this.reconnectTimer = setTimeout(() => {
      void this.run()
    }, delay)
  }
}

export function createSseTransport(opts: SseTransportOptions): SseTransport {
  return new FetchSseTransport(opts)
}
