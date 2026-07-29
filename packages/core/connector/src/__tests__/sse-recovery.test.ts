// Verified against a REAL http server. The bug being fixed was measured this
// way — a probe showed the transport never knocked again after its retry budget
// ran out, even once the server was healthy — so the fix is held to the same
// standard. A mocked fetch cannot tell you whether a socket was actually opened.
import { describe, it, expect, afterEach } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createSseTransport, type TransportStatus } from "../sse-transport"

interface Harness {
  url: string
  accepts(): number
  emit(obj: object): void
  dropAll(): void
  setDown(down: boolean): void
  close(): Promise<void>
}

async function startServer(): Promise<Harness> {
  let open: http.ServerResponse[] = []
  let accepted = 0
  let down = false
  const server = http.createServer((_req, res) => {
    accepted++
    if (down) {
      res.writeHead(503)
      res.end()
      return
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
    open.push(res)
    res.on("close", () => { open = open.filter((r) => r !== res) })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/event`,
    accepts: () => accepted,
    emit: (obj) => open.forEach((r) => r.write(`data: ${JSON.stringify(obj)}\n\n`)),
    dropAll: () => { open.forEach((r) => r.destroy()); open = [] },
    setDown: (d) => { down = d },
    close: async () => {
      open.forEach((r) => r.destroy())
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Poll until a condition holds. These cases assert real timing against a real
 * socket, so fixed sleeps make them hostage to machine load — they passed alone
 * and flaked when the whole monorepo's suites ran in parallel. The BOUNDS still
 * matter (a status must be reached, and reaching it must not need a nudge), so
 * poll for the outcome instead of guessing how long the machine will take.
 */
async function until(label: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(25)
  }
  throw new Error(`timed out waiting for: ${label}`)
}
let harness: Harness | null = null
afterEach(async () => { await harness?.close(); harness = null })

describe("SSE recovery after the fast retry budget is spent", () => {
  it("keeps knocking in the background and reconnects when the server returns", async () => {
    const h = (harness = await startServer())
    const statuses: TransportStatus[] = []
    const seen: string[] = []
    const t = createSseTransport({
      url: h.url,
      retry: { baseDelayMs: 10, maxAttempts: 3, keepRetryingEveryMs: 120 },
      onEvent: (e: any) => seen.push(e.type),
      onStatusChange: (s) => statuses.push(s),
    })
    void t.connect()
    await until("open", () => t.getStatus() === "open")

    // Backend dies and stays dead well past the fast budget (10+20+40 = 70ms).
    h.setDown(true)
    h.dropAll()
    await until("gave-up", () => t.getStatus() === "gave-up")
    const knocksWhileDown = h.accepts()

    // ...and it is STILL trying, which is the whole point.
    await until("a background knock", () => h.accepts() > knocksWhileDown)

    // Backend comes back — no user action, no app restart.
    h.setDown(false)
    await until("recovered", () => t.getStatus() === "open")
    expect(seen.filter((x) => x === "server.connected").length).toBeGreaterThan(1)
    t.close()
  }, 15_000)

  it("announces 'gave-up' once, not on every background attempt", async () => {
    // Otherwise the UI's disconnected state flickers, and a toast wired to the
    // transition would fire every few seconds for as long as the outage lasts.
    const h = (harness = await startServer())
    const statuses: TransportStatus[] = []
    const t = createSseTransport({
      url: h.url,
      retry: { baseDelayMs: 10, maxAttempts: 2, keepRetryingEveryMs: 60 },
      onEvent: () => {},
      onStatusChange: (s) => statuses.push(s),
    })
    void t.connect()
    await until("open", () => t.getStatus() === "open")

    h.setDown(true)
    h.dropAll()
    await until("gave-up", () => t.getStatus() === "gave-up")
    const knocks = h.accepts()
    // Several more background attempts must go by without re-announcing.
    await until("3 more background knocks", () => h.accepts() >= knocks + 3)

    expect(statuses.filter((s) => s === "gave-up")).toHaveLength(1)
    t.close()
  }, 15_000)

  it("stops for good on close(), even while background-retrying", async () => {
    const h = (harness = await startServer())
    const t = createSseTransport({
      url: h.url,
      retry: { baseDelayMs: 10, maxAttempts: 2, keepRetryingEveryMs: 60 },
      onEvent: () => {},
    })
    void t.connect()
    await until("open", () => t.getStatus() === "open")
    h.setDown(true)
    h.dropAll()
    await until("gave-up", () => t.getStatus() === "gave-up")

    t.close()
    const afterClose = h.accepts()
    // Long enough to cover several background intervals (60ms) with margin.
    await sleep(600)
    expect(h.accepts()).toBe(afterClose)
  }, 15_000)

  it("without keepRetryingEveryMs the old terminal behaviour is unchanged", async () => {
    const h = (harness = await startServer())
    const t = createSseTransport({
      url: h.url,
      retry: { baseDelayMs: 10, maxAttempts: 3 },
      onEvent: () => {},
    })
    void t.connect()
    await until("open", () => t.getStatus() === "open")
    h.setDown(true)
    h.dropAll()
    await until("gave-up", () => t.getStatus() === "gave-up")

    const atGiveUp = h.accepts()
    h.setDown(false)
    await sleep(600) // no interval to wait out — it must simply never knock again
    expect(h.accepts()).toBe(atGiveUp)
    t.close()
  }, 15_000)

  it("forceReconnect() recovers immediately instead of waiting out the interval", async () => {
    const h = (harness = await startServer())
    const t = createSseTransport({
      url: h.url,
      // Interval long enough that a passing test cannot be the timer firing.
      retry: { baseDelayMs: 10, maxAttempts: 2, keepRetryingEveryMs: 30_000 },
      onEvent: () => {},
    })
    void t.connect()
    await until("open", () => t.getStatus() === "open")
    h.setDown(true)
    h.dropAll()
    await until("gave-up", () => t.getStatus() === "gave-up")

    h.setDown(false)
    t.forceReconnect()
    await until("recovered without waiting out the interval", () => t.getStatus() === "open", 5_000)
    t.close()
  }, 15_000)
})
