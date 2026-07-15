// mock-llm-vision.ts — OpenAI-compatible mock that REPORTS BACK what content parts it
// actually received, so an attachment e2e can assert the bytes reached the provider layer
// rather than merely that the UI drew a chip.
//
// Replies with a single line like:
//   GOT parts=text,image_url image=image/png bytes=1234 text="describe this"
// or, for a text/plain file part (which opencode inlines via its Read tool):
//   GOT parts=text image=none bytes=0 text="...MARKER_TEXT_FILE..."
//
// Env: MOCK_LLM_PORT.
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8092)

function describe(body: any): string {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  // The last user message is the turn under test.
  const user = [...msgs].reverse().find((m: any) => m.role === "user")
  if (!user) return "GOT no-user-message"

  // OpenAI-compatible content is either a bare string or an array of typed parts.
  const content = user.content
  if (typeof content === "string") {
    return `GOT parts=text image=none bytes=0 text=${JSON.stringify(content.slice(0, 200))}`
  }
  const parts: string[] = []
  let imageMime = "none"
  let imageBytes = 0
  let text = ""
  for (const p of content ?? []) {
    parts.push(p.type)
    if (p.type === "image_url") {
      const url: string = p.image_url?.url ?? ""
      const m = url.match(/^data:([^;]+);base64,(.*)$/)
      if (m) {
        imageMime = m[1]
        // base64 → bytes (4 chars ≈ 3 bytes); exactness doesn't matter, presence does.
        imageBytes = Math.floor((m[2].length * 3) / 4)
      } else {
        imageMime = `non-data-url(${url.slice(0, 12)})`
      }
    }
    if (p.type === "text") text += p.text ?? ""
  }
  return `GOT parts=${parts.join(",")} image=${imageMime} bytes=${imageBytes} text=${JSON.stringify(text.slice(0, 400))}`
}

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
      const body = await req.json().catch(() => ({}))
      const answer = describe(body)
      console.log(`[mock-llm-vision] ${answer}`)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          const send = (o: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`))
          send(chunk("", null))
          send(chunk(answer, null))
          send(chunk(null, "stop"))
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      })
    }
    return new Response("not found", { status: 404 })
  },
})
console.log(`[mock-llm-vision] listening on ${PORT}`)
