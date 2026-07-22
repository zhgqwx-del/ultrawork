// mock-llm-image.ts — OpenAI-compatible mock that streams a fixed answer full of
// inline images, so a REAL opencode turn renders through the REAL MarkdownContent
// → MarkdownImage pipeline and we can prove (in a real browser, against a real
// opencode /file/content) that:
//   · a workspace-RELATIVE local path resolves to a data: URI (the broken case)
//   · a workspace-ABSOLUTE path is stripped to relative and resolves too
//   · a base64 data: URI survives react-markdown's urlTransform and passes through
//   · a remote https URL passes through
//   · an OUTSIDE-workspace absolute path degrades to a fallback (no broken glyph)
// See discussions/049 / ADR-065. Env: MOCK_LLM_PORT, MOCK_WS (workspace abs path).
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8091)
const WS = process.env.MOCK_WS ?? "/tmp"

// A tiny 1x1 PNG (validity of bytes is irrelevant — we only assert the <img> src
// survives urlTransform; the DOM never has to decode it).
const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const ANSWER =
  "画好了，给你几张图：\n\n" +
  "相对路径：![章鱼-相对](octopus.svg)\n\n" +
  `绝对路径：![章鱼-绝对](${WS}/octopus.svg)\n\n` +
  "远程图：![远程图](https://example.com/remote.png)\n\n" +
  `base64：![内嵌图](data:image/png;base64,${B64})\n\n` +
  "工作区外：![外部图](/etc/hosts-not-here.png)\n"

// Stream it in a few segments (like a real turn) so the transcript builds up.
const SEGMENTS = ANSWER.match(/[^\n]*\n\n|[^\n]*\n?/g)?.filter(Boolean) ?? [ANSWER]

function chunk(content: string | null, finish: string | null) {
  return {
    id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1700000000, model: "mock-model",
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
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder()
          const send = (o: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`))
          send(chunk("", null))
          for (const seg of SEGMENTS) { send(chunk(seg, null)); await new Promise((r) => setTimeout(r, 60)) }
          send(chunk(null, "stop"))
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
    }
    return new Response("ok", { status: 200 })
  },
})
console.log(`[mock-llm-image] listening on http://127.0.0.1:${PORT} (WS=${WS})`)
