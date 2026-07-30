// cuttable-proxy.ts — a TCP passthrough whose connections can be severed on demand.
//
// Needed because Playwright's `setOffline` does NOT cut loopback traffic: measured
// directly — markers kept arriving in the UI throughout a supposed 8s outage
// (7 -> 66). Any "no gap" conclusion drawn under it would be a statement about a
// network that never went down.
//
// Sits between the Vite dev proxy and opencode, so the renderer needs no config
// change and the CORS origin stays identical: Vite -> proxy(4096) -> opencode(4196).
// `cut()` drops every live socket AND refuses new ones, which is what an SSE
// transport actually experiences when a network drops while the server runs on.
export interface CuttableProxy {
  cut(): void
  restore(): void
  readonly accepted: number
}

export function startCuttableProxy(listenPort: number, upstreamPort: number): CuttableProxy {
  let severed = false
  let accepted = 0
  const live = new Set<{ end: () => void }>()

  Bun.listen({
    hostname: "127.0.0.1",
    port: listenPort,
    socket: {
      open(client) {
        if (severed) { try { client.end() } catch {} ; return }
        accepted++
        live.add(client as any)
        // Bytes can arrive before the upstream socket exists; queue them rather
        // than dropping, or the first request of a fresh connection is lost.
        const pending: Uint8Array[] = []
        ;(client as any).__pending = pending
        Bun.connect({
          hostname: "127.0.0.1",
          port: upstreamPort,
          socket: {
            data(_s, chunk) { try { client.write(chunk) } catch {} },
            close() { try { client.end() } catch {} },
            error() { try { client.end() } catch {} },
          },
        })
          .then((up) => {
            ;(client as any).__up = up
            live.add(up as any)
            for (const q of pending) { try { up.write(q) } catch {} }
            pending.length = 0
          })
          .catch(() => { try { client.end() } catch {} })
      },
      data(client, chunk) {
        const up = (client as any).__up
        if (up) { try { up.write(chunk) } catch {} }
        else (client as any).__pending?.push(chunk)
      },
      close(client) {
        const up = (client as any).__up
        if (up) { try { up.end() } catch {} ; live.delete(up) }
        live.delete(client as any)
      },
      error(client) { live.delete(client as any) },
    },
  })

  return {
    get accepted() { return accepted },
    cut() {
      severed = true
      for (const s of live) { try { s.end() } catch {} }
      live.clear()
    },
    restore() { severed = false },
  }
}
