// Minimal OpenAI-compatible mock LLM for the switch-back gap harness
// (docs/discussions/022). Streams a long, marker-tagged response slowly
// (M001 M002 …) so a real opencode turn has a multi-second streaming window
// with a token sequence whose contiguity we can assert — no real model needed.
//
// Env: MOCK_LLM_PORT (8088) · MOCK_LLM_CHUNKS (70) · MOCK_LLM_DELAY_MS (150)
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8088)
const CHUNKS = Number(process.env.MOCK_LLM_CHUNKS ?? 70)
const DELAY = Number(process.env.MOCK_LLM_DELAY_MS ?? 150)

function chunk(content: string | null, finish: string | null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "mock-model",
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
  }
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] })
    }
    if (url.pathname.endsWith("/chat/completions")) {
      // Seeding path: a harness that needs a LONG history (many turns) can't wait
      // CHUNKS×DELAY per turn. A prompt tagged SEEDTURN answers in one frame with
      // no delay, so 20+ turns of real persisted history cost about a second.
      //
      // The sentinel is matched ONLY against the LAST message, never the whole
      // body. Measured the hard way: opencode replays the entire conversation on
      // every request, so once a seeded session exists its history carries
      // "SEEDTURN" forever — a whole-body match then fast-paths the REAL turn too
      // and the harness reports "stream never started". Same class as testing.md
      // §8 坑 2 (`body.includes("title")` also matching tool schemas).
      const body = req.method === "POST" ? await req.text().catch(() => "") : ""
      let isSeed = false
      try {
        const msgs = (JSON.parse(body) as { messages?: unknown[] }).messages
        const last = Array.isArray(msgs) ? (msgs[msgs.length - 1] as any) : undefined
        const text = typeof last?.content === "string"
          ? last.content
          : Array.isArray(last?.content) ? last.content.map((p: any) => p?.text ?? "").join(" ") : ""
        isSeed = text.includes("SEEDTURN")
      } catch { /* not JSON → treat as a normal streaming request */ }
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder()
          const send = (o: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`))
          send(chunk("", null)) // role frame
          if (isSeed) {
            send(chunk("SEEDACK", null))
            send(chunk(null, "stop"))
            controller.enqueue(enc.encode("data: [DONE]\n\n"))
            controller.close()
            return
          }
          for (let i = 1; i <= CHUNKS; i++) {
            send(chunk(`M${String(i).padStart(3, "0")} `, null))
            await new Promise((r) => setTimeout(r, DELAY))
          }
          send(chunk(null, "stop"))
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      })
    }
    return new Response("ok", { status: 200 })
  },
})
console.log(`[mock-llm] listening on http://127.0.0.1:${PORT} (${CHUNKS} chunks × ${DELAY}ms)`)
