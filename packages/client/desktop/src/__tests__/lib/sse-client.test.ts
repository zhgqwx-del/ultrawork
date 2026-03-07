import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SSEClient, type SSEEvent } from "@/lib/sse-client"

// Mock toast from sonner
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

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

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

describe("SSEClient", () => {
  let sseClient: SSEClient

  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
    sseClient = new SSEClient({
      baseUrl: "http://localhost:4096",
      username: "opencode",
      password: "test123",
    })
  })

  afterEach(() => {
    sseClient.disconnect()
    vi.useRealTimers()
  })

  describe("connect", () => {
    it("sends correct URL and auth headers", async () => {
      const stream = createMockStream([])
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      })

      await sseClient.connect()

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4096/event",
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: "text/event-stream",
            Authorization: `Basic ${btoa("opencode:test123")}`,
          }),
        })
      )
    })

    it("omits auth header when no password", async () => {
      const noAuth = new SSEClient({ baseUrl: "http://localhost:4096" })
      const stream = createMockStream([])
      mockFetch.mockResolvedValueOnce({ ok: true, body: stream })

      await noAuth.connect()

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers.Authorization).toBeUndefined()
      noAuth.disconnect()
    })

    it("parses SSE events and dispatches to handlers", async () => {
      const event1 = JSON.stringify({ type: "server.connected", properties: {} })
      const event2 = JSON.stringify({
        type: "session.created",
        properties: { id: "s1" },
      })
      const stream = createMockStream([
        `data: ${event1}\n\n`,
        `data: ${event2}\n\n`,
      ])

      mockFetch.mockResolvedValueOnce({ ok: true, body: stream })

      const received: SSEEvent[] = []
      sseClient.on((event) => received.push(event))

      await sseClient.connect()

      expect(received).toHaveLength(2)
      expect(received[0].type).toBe("server.connected")
      expect(received[1].type).toBe("session.created")
    })

    it("dispatches to multiple handlers", async () => {
      const event = JSON.stringify({ type: "server.heartbeat", properties: {} })
      const stream = createMockStream([`data: ${event}\n\n`])
      mockFetch.mockResolvedValueOnce({ ok: true, body: stream })

      const handler1 = vi.fn()
      const handler2 = vi.fn()
      sseClient.on(handler1)
      sseClient.on(handler2)

      await sseClient.connect()

      expect(handler1).toHaveBeenCalledTimes(1)
      expect(handler2).toHaveBeenCalledTimes(1)
    })

    it("warns when already connected", async () => {
      const stream1 = createMockStream([])
      const stream2 = createMockStream([])
      mockFetch
        .mockResolvedValueOnce({ ok: true, body: stream1 })

      // Start connecting (don't await - it reads stream)
      const connectPromise = sseClient.connect()

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      // Try connecting again while first is in progress
      await sseClient.connect()
      expect(consoleSpy).toHaveBeenCalledWith("SSE already connected")
      consoleSpy.mockRestore()

      // Let first connection finish
      await connectPromise
    })

    it("handles non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      })

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      await sseClient.connect()
      consoleSpy.mockRestore()
      // Should not throw, just log error
    })

    it("handles response without body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: null,
      })

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      await sseClient.connect()
      consoleSpy.mockRestore()
    })

    it("handles invalid JSON in SSE data gracefully", async () => {
      const stream = createMockStream([`data: not-valid-json\n\n`])
      mockFetch.mockResolvedValueOnce({ ok: true, body: stream })

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const handler = vi.fn()
      sseClient.on(handler)

      await sseClient.connect()

      expect(handler).not.toHaveBeenCalled()
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to parse SSE event:",
        expect.any(Error),
        expect.any(String)
      )
      consoleSpy.mockRestore()
    })
  })

  describe("disconnect", () => {
    it("sets shouldReconnect to false", () => {
      sseClient.disconnect()
      expect(sseClient.getConnectionState()).toBe(false)
    })
  })

  describe("on / unsubscribe", () => {
    it("returns unsubscribe function", async () => {
      const handler = vi.fn()
      const unsubscribe = sseClient.on(handler)

      const event = JSON.stringify({ type: "server.connected", properties: {} })
      const stream = createMockStream([`data: ${event}\n\n`])
      mockFetch.mockResolvedValueOnce({ ok: true, body: stream })

      // Unsubscribe before connect
      unsubscribe()

      await sseClient.connect()
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe("getConnectionState", () => {
    it("returns false initially", () => {
      expect(sseClient.getConnectionState()).toBe(false)
    })
  })

  describe("reconnection", () => {
    it("schedules reconnect after stream ends", async () => {
      const stream = createMockStream([]) // empty stream = immediate end
      mockFetch.mockResolvedValueOnce({ ok: true, body: stream })

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

      await sseClient.connect()

      // After stream ends, reconnect should be scheduled
      expect(consoleSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Reconnecting in")
      )).toBe(true)

      consoleSpy.mockRestore()
    })

    it("does not reconnect after manual disconnect", async () => {
      const stream = createMockStream([])
      mockFetch.mockResolvedValueOnce({ ok: true, body: stream })

      sseClient.disconnect()

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      // Should not see reconnection messages
      expect(consoleSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Reconnecting")
      )).toBe(false)
      consoleSpy.mockRestore()
    })
  })
})
