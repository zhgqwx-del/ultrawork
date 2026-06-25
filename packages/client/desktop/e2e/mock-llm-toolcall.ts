// Mock OpenAI-compatible LLM in TOOL-CALL mode (for meta-passthrough.e2e.ts):
// 1st request → emit a tool_call to `metachk_ping`; 2nd request (carries the tool
// result) → echo it back as the answer text so the harness can read the _meta out.
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8088)
const TOOL = process.env.MOCK_LLM_TOOL ?? "metachk_ping"

function frame(o: unknown) { return `data: ${JSON.stringify(o)}\n\n` }

Bun.serve({
  port: PORT, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] })
    if (!url.pathname.endsWith("/chat/completions")) return new Response("ok")
    const body = await req.json().catch(() => ({})) as { messages?: Array<{ role: string; content: unknown }> }
    const toolMsg = body.messages?.find((m) => m.role === "tool")
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (o: unknown) => c.enqueue(enc.encode(frame(o)))
        if (!toolMsg) {
          send({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: TOOL, arguments: "{}" } }] }, finish_reason: null }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
        } else {
          const txt = "ANSWER:" + (typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content))
          send({ choices: [{ index: 0, delta: { content: txt }, finish_reason: null }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        }
        c.enqueue(enc.encode("data: [DONE]\n\n"))
        c.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})
console.log(`[mock-llm-toolcall] listening :${PORT}, tool=${TOOL}`)
