import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createSseTransport, type SseTransport, type TransportStatus } from "../sse-transport"
import type { ConnectorEvent } from "../events"

function createMockStream(events: string[]) {
  let index = 0
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < events.length) {
        controller.enqueue(encoder.encode(events[index]))
        index++
      } else {
        controller.close()
      }
    },
  })
}

/** Stream that stays open; events are pushed manually. */
function createPushStream() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    push(event: object) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    },
    end() {
      controller.close()
    },
  }
}

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function makeTransport(overrides: Partial<Parameters<typeof createSseTransport>[0]> = {}) {
  const events: ConnectorEvent[] = []
  const statuses: TransportStatus[] = []
  const transport = createSseTransport({
    url: "http://localhost:4096/event",
    retry: { baseDelayMs: 1000, maxAttempts: 5 },
    onEvent: (e) => events.push(e),
    onStatusChange: (s) => statuses.push(s),
    ...overrides,
  })
  return { transport, events, statuses }
}

let active: SseTransport[] = []
function track(t: SseTransport): SseTransport {
  active.push(t)
  return t
}

describe("SseTransport", () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>

  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
    consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ]
  })

  afterEach(() => {
    active.forEach((t) => t.close())
    active = []
    consoleSpies.forEach((s) => s.mockRestore())
    vi.useRealTimers()
  })

  describe("connect", () => {
    it("sends the configured URL with Accept and lazy headers", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: createMockStream([]) })

      const { transport } = makeTransport({
        headers: () => ({ Authorization: `Basic ${btoa("opencode:test123")}` }),
      })
      await track(transport).connect()

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4096/event",
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: "text/event-stream",
            Authorization: `Basic ${btoa("opencode:test123")}`,
          }),
        }),
      )
    })

    it("supports relative URLs (desktop dev mode)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: createMockStream([]) })

      const { transport } = makeTransport({ url: "/event" })
      await track(transport).connect()

      expect(mockFetch.mock.calls[0][0]).toBe("/event")
    })

    it("re-evaluates lazy headers on each attempt", async () => {
      mockFetch.mockResolvedValue({ ok: true, body: createMockStream([]) })

      let counter = 0
      const { transport } = makeTransport({
        headers: () => ({ "x-attempt": String(++counter) }),
        retry: { baseDelayMs: 1000, maxAttempts: 1 },
      })
      await track(transport).connect()
      mockFetch.mockResolvedValueOnce({ ok: true, body: createMockStream([]) })
      await vi.advanceTimersByTimeAsync(1000)

      expect(mockFetch.mock.calls[0][1].headers["x-attempt"]).toBe("1")
      expect(mockFetch.mock.calls[1][1].headers["x-attempt"]).toBe("2")
    })

    it("parses SSE events and dispatches to onEvent", async () => {
      const event1 = JSON.stringify({ type: "server.connected", properties: {} })
      const event2 = JSON.stringify({ type: "session.created", properties: { id: "s1" } })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: createMockStream([`data: ${event1}\n\n`, `data: ${event2}\n\n`]),
      })

      const { transport, events } = makeTransport()
      await track(transport).connect()

      expect(events).toHaveLength(2)
      expect(events[0].type).toBe("server.connected")
      expect(events[1].type).toBe("session.created")
    })

    it("warns when already connected", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: createMockStream([]) })

      const { transport } = makeTransport()
      track(transport)
      const connectPromise = transport.connect()
      await transport.connect()
      expect(console.warn).toHaveBeenCalledWith("SSE already connected")
      await connectPromise
    })

    it("handles non-ok response without throwing", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" })

      const { transport, statuses } = makeTransport()
      await track(transport).connect()

      expect(statuses).toContain("error")
    })

    it("handles response without body", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: null })

      const { transport, statuses } = makeTransport()
      await track(transport).connect()

      expect(statuses).toContain("error")
    })

    it("handles invalid JSON in SSE data gracefully", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: createMockStream([`data: not-valid-json\n\n`]) })

      const { transport, events } = makeTransport()
      await track(transport).connect()

      expect(events).toHaveLength(0)
      expect(console.error).toHaveBeenCalledWith("Failed to parse SSE event:", expect.any(Error), expect.any(String))
    })
  })

  describe("status transitions", () => {
    it("reports connecting then open on success", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: createMockStream([]) })

      const { transport, statuses } = makeTransport()
      await track(transport).connect()

      expect(statuses[0]).toBe("connecting")
      expect(statuses[1]).toBe("open")
    })

    it("close() reports closed and aborts without reconnecting", async () => {
      const push = createPushStream()
      mockFetch.mockResolvedValueOnce({ ok: true, body: push.stream })

      const { transport, statuses } = makeTransport()
      void transport.connect()
      await vi.advanceTimersByTimeAsync(0)
      transport.close()

      expect(statuses).toContain("closed")
      expect(transport.getStatus()).toBe("closed")
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe("reconnection", () => {
    it("schedules reconnect with exponential backoff while attempts fail", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "boom" })

      const { transport } = makeTransport({ retry: { baseDelayMs: 1000, maxAttempts: 3 } })
      await track(transport).connect()
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // attempt 1 after 1000ms
      await vi.advanceTimersByTimeAsync(999)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // attempt 2 after 2000ms
      await vi.advanceTimersByTimeAsync(2000)
      expect(mockFetch).toHaveBeenCalledTimes(3)

      // attempt 3 after 4000ms
      await vi.advanceTimersByTimeAsync(4000)
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })

    it("caps the delay at maxDelayMs (gateway policy)", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "boom" })

      const { transport } = makeTransport({ retry: { baseDelayMs: 1000, maxDelayMs: 1500 } })
      await track(transport).connect()

      await vi.advanceTimersByTimeAsync(1000) // attempt 1: 1000ms
      expect(mockFetch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1500) // attempt 2: capped at 1500 (not 2000)
      expect(mockFetch).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1500) // attempt 3: still 1500 (not 4000)
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })

    it("gives up after maxAttempts and reports gave-up", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "boom" })

      const { transport, statuses } = makeTransport({ retry: { baseDelayMs: 100, maxAttempts: 2 } })
      await track(transport).connect()
      await vi.advanceTimersByTimeAsync(100) // attempt 1
      await vi.advanceTimersByTimeAsync(200) // attempt 2

      expect(mockFetch).toHaveBeenCalledTimes(3)
      expect(statuses).toContain("gave-up")
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it("retries forever when maxAttempts is undefined", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "boom" })

      const { transport, statuses } = makeTransport({ retry: { baseDelayMs: 100, maxDelayMs: 100 } })
      await track(transport).connect()
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(100)
      }

      expect(mockFetch.mock.calls.length).toBeGreaterThan(15)
      expect(statuses).not.toContain("gave-up")
    })

    it("resets attempt counter after a successful connection", async () => {
      // fail twice, succeed, then stream ends -> next delay restarts at base
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: "boom" })
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: "boom" })
        .mockResolvedValueOnce({ ok: true, body: createMockStream([]) })
        .mockResolvedValue({ ok: true, body: createMockStream([]) })

      const { transport } = makeTransport({ retry: { baseDelayMs: 1000, maxAttempts: 5 } })
      await track(transport).connect()
      await vi.advanceTimersByTimeAsync(1000) // attempt 1 (fail)
      await vi.advanceTimersByTimeAsync(2000) // attempt 2 (success, stream ends)
      expect(mockFetch).toHaveBeenCalledTimes(3)

      // counter was reset on success -> next reconnect after base delay again
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })

    it("does not reconnect after manual close", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: createMockStream([]) })

      const { transport } = makeTransport()
      await track(transport).connect()
      transport.close()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe("forceReconnect", () => {
    it("resets attempts and reconnects immediately even after gave-up", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "boom" })

      const { transport, statuses } = makeTransport({ retry: { baseDelayMs: 100, maxAttempts: 0 } })
      await track(transport).connect()
      expect(statuses).toContain("gave-up")
      expect(mockFetch).toHaveBeenCalledTimes(1)

      mockFetch.mockResolvedValueOnce({ ok: true, body: createMockStream([]) })
      transport.forceReconnect()
      await vi.advanceTimersByTimeAsync(0)

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(statuses).toContain("open")
    })
  })

  describe("heartbeat watchdog", () => {
    it("forces reconnect when no event arrives within the timeout", async () => {
      const push = createPushStream()
      mockFetch.mockResolvedValueOnce({ ok: true, body: push.stream })

      const { transport, statuses } = makeTransport({ heartbeatTimeoutMs: 30_000 })
      track(transport)
      void transport.connect()
      await vi.advanceTimersByTimeAsync(0)

      push.push({ type: "server.connected", properties: {} })
      await vi.advanceTimersByTimeAsync(0)

      mockFetch.mockResolvedValueOnce({ ok: true, body: createPushStream().stream })
      await vi.advanceTimersByTimeAsync(30_000)

      expect(statuses).toContain("stalled")
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it("any event resets the watchdog timer", async () => {
      const push = createPushStream()
      mockFetch.mockResolvedValueOnce({ ok: true, body: push.stream })

      const { transport } = makeTransport({ heartbeatTimeoutMs: 30_000 })
      track(transport)
      void transport.connect()
      await vi.advanceTimersByTimeAsync(0)

      push.push({ type: "server.connected", properties: {} })
      await vi.advanceTimersByTimeAsync(20_000)
      push.push({ type: "server.heartbeat", properties: {} })
      await vi.advanceTimersByTimeAsync(20_000) // 40s since first event, 20s since second

      expect(mockFetch).toHaveBeenCalledTimes(1) // no forced reconnect

      mockFetch.mockResolvedValueOnce({ ok: true, body: createPushStream().stream })
      await vi.advanceTimersByTimeAsync(10_000) // 30s since second event
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it("recovers to open when an event arrives after stall", async () => {
      const push = createPushStream()
      mockFetch.mockResolvedValueOnce({ ok: true, body: push.stream })

      const { transport, statuses } = makeTransport({ heartbeatTimeoutMs: 30_000, heartbeatReconnectBudget: 0 })
      track(transport)
      void transport.connect()
      await vi.advanceTimersByTimeAsync(0)

      push.push({ type: "server.connected", properties: {} })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(transport.getStatus()).toBe("stalled")

      push.push({ type: "server.heartbeat", properties: {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.getStatus()).toBe("open")
      expect(statuses.filter((s) => s === "open")).toHaveLength(2)
    })
  })
})
