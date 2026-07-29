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
  /**
   * What to do once `maxAttempts` is spent. Without it the transport stops for
   * good: a desktop app that lost its backend for 31 seconds would never speak
   * to it again, even after it came back healthy, until the user restarted.
   *
   * With it, the status still goes to "gave-up" exactly once (so the UI can say
   * "disconnected"), and the transport keeps knocking at this interval in the
   * background — silently, without churning the status between attempts — until
   * it gets back in, at which point the status returns to "open".
   */
  keepRetryingEveryMs?: number
}

/**
 * `T` is the JSON shape carried on `data:`. Defaults to the opencode-derived
 * ConnectorEvent; the knowledge and orchestration streams carry their own shapes.
 */
export interface SseTransportOptions<T = ConnectorEvent> {
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
  /**
   * `eventName` is the frame's `event:` field, absent on unnamed frames. The
   * knowledge stream discriminates on it (`status` vs `indexing`/`complete`/
   * `error`); opencode and the orchestrator put their discriminator inside the
   * payload and ignore it.
   */
  onEvent: (event: T, eventName?: string) => void
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

class FetchSseTransport<T> implements SseTransport {
  private abortController: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatReconnects = 0
  private status: TransportStatus = "idle"
  private shouldReconnect = true
  /**
   * True once the fast retry budget is spent and we are quietly knocking at
   * `keepRetryingEveryMs`. Suppresses the per-attempt status churn so the UI's
   * "disconnected" state stays put instead of flickering through
   * connecting/error on every background attempt.
   */
  private slowRetrying = false

  constructor(private opts: SseTransportOptions<T>) {}

  getStatus(): TransportStatus {
    return this.status
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true
    await this.run()
  }

  close(): void {
    this.shouldReconnect = false
    this.slowRetrying = false
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
    // A deliberate retry (user pressed "reconnect") earns the full status
    // narration again, even if we had settled into quiet background knocking.
    this.slowRetrying = false
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

  private handleEvent(event: T, eventName?: string): void {
    // Any event proves liveness: reset watchdog + budget (sse-context.tsx:28-45 semantics)
    this.heartbeatReconnects = 0
    this.armWatchdog()
    if (this.status === "stalled") this.setStatus("open")
    this.opts.onEvent(event, eventName)
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

    // In slow-retry mode the consumer has already been told the connection is
    // down; announcing every background attempt would only make the UI flicker.
    if (!this.slowRetrying) this.setStatus("connecting")

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
      this.slowRetrying = false
      this.setStatus("open")
      // Arm the watchdog on connect, not only on the first event: a stream that
      // opens and then delivers nothing (half-open TCP right after the
      // handshake) would otherwise never be checked, because the only place
      // that armed it was the event handler.
      this.armWatchdog()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      // The `event:` line precedes its `data:` line and applies until the frame
      // ends (blank line). Streams that never send one see `undefined`.
      let eventName: string | undefined

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          console.log("SSE stream ended")
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
          if (line === "") {
            eventName = undefined // frame boundary
            continue
          }
          if (line.startsWith("event: ")) {
            eventName = line.slice(7)
            continue
          }
          if (!line.startsWith("data: ")) continue
          try {
            const data: T = JSON.parse(line.slice(6))
            this.handleEvent(data, eventName)
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
      if (!this.slowRetrying) this.setStatus("error")
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

    const { baseDelayMs, maxDelayMs, maxAttempts, keepRetryingEveryMs } = this.opts.retry
    const budgetSpent = maxAttempts !== undefined && this.reconnectAttempts >= maxAttempts

    if (budgetSpent) {
      if (!keepRetryingEveryMs) {
        console.error("Max reconnect attempts reached, giving up")
        this.setStatus("gave-up")
        return
      }
      // Fast retries are spent. Tell the consumer once, then keep knocking
      // quietly — a backend that comes back an hour later must still be picked
      // up without the user restarting the app.
      if (!this.slowRetrying) {
        this.slowRetrying = true
        console.warn(`Fast reconnects exhausted; retrying every ${keepRetryingEveryMs}ms in the background`)
        this.setStatus("gave-up")
      }
      this.reconnectTimer = setTimeout(() => {
        void this.run()
      }, keepRetryingEveryMs)
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

export function createSseTransport<T = ConnectorEvent>(opts: SseTransportOptions<T>): SseTransport {
  return new FetchSseTransport<T>(opts)
}
