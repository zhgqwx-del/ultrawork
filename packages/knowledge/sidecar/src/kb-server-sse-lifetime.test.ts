// `Bun.serve`'s default 10s idleTimeout kills the /kb/sources/events stream.
//
// The stream only writes when indexing progresses, and its keep-alive sleeps 30s —
// three times the default — so an idle knowledge panel dropped its connection every
// 10 seconds and reconnected forever. Silent under the old `EventSource` (it retries
// on its own); surfaced once the stream moved onto the connector's fetch-reader.
//
// Both directions are asserted in one wall-clock window: with the timeout disabled
// the stream survives past 10s, and a control server that omits it does not.

import { describe, it, expect } from "bun:test"
import { createApp, KB_SERVE_IDLE_TIMEOUT, type AppDeps } from "./kb-server"

function deps(): AppDeps {
  return {
    addProgressListener: () => {},
    indexer: {
      addProgressListener: () => {},
      // One folder, so the handler writes an initial `status` frame. Without any
      // output hono never flushes the response head and `fetch` would block on it.
      listFolders: () => [
        { folderPath: "/w/docs", status: "complete", totalFiles: 1, indexedFiles: 1, skippedFiles: 0 },
      ],
      getStatus: () => undefined,
    } as unknown as AppDeps["indexer"],
    search: () => [],
    store: { listKnowledgeSources: () => [] } as unknown as AppDeps["store"],
  } as unknown as AppDeps
}

/** Resolves to how long the SSE stream stayed open, in ms (capped at `capMs`). */
async function streamLifetimeMs(port: number, capMs: number): Promise<number> {
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}/kb/sources/events`, { headers: { accept: "text/event-stream" } })
  } catch {
    return Date.now() - started // reset before the head even arrived
  }
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const cap = new Promise<number>((r) => setTimeout(() => r(capMs), capMs))
  const closed = (async () => {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch {
      // reset by peer
    }
    return Date.now() - started
  })()
  const ms = await Promise.race([closed, cap])
  await reader.cancel().catch(() => {})
  return ms
}

describe("kb-server SSE lifetime", () => {
  it(
    "keeps an idle progress stream open past Bun's default 10s idle timeout",
    async () => {
      const app = createApp(deps(), null)
      // Ships with idleTimeout disabled...
      const good = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: KB_SERVE_IDLE_TIMEOUT, fetch: (r) => app.fetch(r) })
      // ...and a control that takes Bun's default, to prove the timeout is real.
      const control = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => app.fetch(r) })

      try {
        // Bun's default fires around 10s, but not to the millisecond — the control
        // was measured closing at ~12s. Bound loosely: it must close well before the
        // cap, and ours must reach it.
        const CAP = 16_000
        const [kept, dropped] = await Promise.all([
          streamLifetimeMs(good.port!, CAP),
          streamLifetimeMs(control.port!, CAP),
        ])

        expect(KB_SERVE_IDLE_TIMEOUT).toBe(0)
        expect(kept).toBeGreaterThanOrEqual(CAP)
        // The control must actually drop, or the assertion above proves nothing.
        expect(dropped).toBeLessThan(CAP - 1_000)
        // ...and drop because of the idle timeout, not an instant connection error.
        expect(dropped).toBeGreaterThan(8_000)
      } finally {
        good.stop(true)
        control.stop(true)
      }
    },
    25_000,
  )
})
