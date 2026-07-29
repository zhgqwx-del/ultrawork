// Timeouts are verified against a REAL http server, not a mocked fetch: the whole
// question is whether an abort actually tears down a live socket, and a mock that
// resolves whenever we tell it to cannot answer that.
import { describe, it, expect, afterEach } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { ApiClient, ApiTimeoutError } from "../client"

type Mode = "silent" | "headers-then-stall" | "ok"

interface Harness {
  baseUrl: string
  setMode(mode: Mode): void
  close(): Promise<void>
}

async function startServer(initial: Mode): Promise<Harness> {
  let mode = initial
  let open: http.ServerResponse[] = []
  const server = http.createServer((_req, res) => {
    if (mode === "ok") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify([{ id: "ses_1" }]))
      return
    }
    if (mode === "headers-then-stall") {
      // Status line + headers land, so fetch() resolves — then nothing. This is
      // what a wedged single-threaded server looks like from the client side.
      res.writeHead(200, { "Content-Type": "application/json" })
      res.write("[")
      open.push(res)
      return
    }
    // "silent": hold the socket without answering at all.
    open.push(res)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setMode: (m) => { mode = m },
    close: async () => {
      open.forEach((r) => r.destroy())
      open = []
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

let harness: Harness | null = null
afterEach(async () => { await harness?.close(); harness = null })

describe("ApiClient request timeout", () => {
  it("rejects with ApiTimeoutError when the server never answers", async () => {
    const h = (harness = await startServer("silent"))
    const client = new ApiClient({ baseUrl: h.baseUrl, timeoutMs: 250 })

    const started = Date.now()
    await expect(client.listSessions()).rejects.toBeInstanceOf(ApiTimeoutError)
    // Bounded by the ceiling, not by the server deciding to reply.
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("rejects when headers arrive but the body stalls", async () => {
    // The regression that matters: clearing the timer once fetch() resolves
    // leaves the body read unbounded, and this is exactly that shape.
    const h = (harness = await startServer("headers-then-stall"))
    const client = new ApiClient({ baseUrl: h.baseUrl, timeoutMs: 250 })

    await expect(client.listSessions()).rejects.toBeInstanceOf(ApiTimeoutError)
  })

  it("carries the url and the ceiling on the error", async () => {
    const h = (harness = await startServer("silent"))
    const client = new ApiClient({ baseUrl: h.baseUrl, timeoutMs: 200 })
    const err = await client.listSessions().catch((e) => e)
    expect(err).toBeInstanceOf(ApiTimeoutError)
    expect(err.timeoutMs).toBe(200)
    expect(err.url).toContain("/session")
  })

  it("does not interfere with a normal response", async () => {
    const h = (harness = await startServer("ok"))
    const client = new ApiClient({ baseUrl: h.baseUrl, timeoutMs: 5000 })
    await expect(client.listSessions()).resolves.toEqual([{ id: "ses_1" }])
  })

  it("timeoutMs: 0 disables the ceiling", async () => {
    const h = (harness = await startServer("silent"))
    const client = new ApiClient({ baseUrl: h.baseUrl, timeoutMs: 0 })
    const settled = await Promise.race([
      client.listSessions().then(() => "settled").catch(() => "settled"),
      new Promise((r) => setTimeout(() => r("still-pending"), 600)),
    ])
    expect(settled).toBe("still-pending")
  })

  it("defaults to a ceiling when the caller sets none", async () => {
    const h = (harness = await startServer("ok"))
    const client = new ApiClient({ baseUrl: h.baseUrl })
    // Proves the default path is wired (a thrown TypeError here would mean
    // fetchWithTimeout got `undefined`), not that 30s elapsed.
    await expect(client.listSessions()).resolves.toEqual([{ id: "ses_1" }])
  })
})

describe("session status scoping", () => {
  it("sends x-opencode-directory, because opencode keeps ONE bus and status map per directory", async () => {
    // Learned the hard way against a real sidecar: a request without this header
    // is answered by a DIFFERENT instance, which reports every session idle. The
    // reconnect reconciliation reads "idle" as "clear the busy marker", so an
    // unscoped call would silently unfreeze sessions whose turns are still
    // running — worse than the stuck spinner it exists to fix.
    let seenDir: string | undefined
    const server = http.createServer((req, res) => {
      seenDir = req.headers["x-opencode-directory"] as string | undefined
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port

    const client = new ApiClient({
      baseUrl: `http://127.0.0.1:${port}`,
      workingDirectory: "/some/work space",
    })
    await client.getSessionStatuses()
    await new Promise<void>((r) => server.close(() => r()))

    expect(seenDir).toBe(encodeURIComponent("/some/work space"))
  })
})
