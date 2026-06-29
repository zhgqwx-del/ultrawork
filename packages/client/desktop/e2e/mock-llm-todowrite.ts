// Mock OpenAI-compatible LLM that drives a real `todowrite` tool call (ADR-038
// plan-panel e2e): 1st request → emit a tool_call to opencode's built-in
// `todowrite` with a fixed todos payload; 2nd request (carries the tool result)
// → answer "plan written". Real opencode executes todowrite → persists todos →
// emits `todo.updated` over /event, which the connector normalizes to
// `plan.updated`. No real model / credentials needed.
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8090)

// Whole list each time (整表) — what the panel renders. Kept in sync with the
// e2e's expectations.
const TODOS = [
  { content: "Write the failing test", status: "in_progress", priority: "high" },
  { content: "Implement the fix", status: "pending", priority: "medium" },
  { content: "Run the suite", status: "pending", priority: "low" },
]

function frame(o: unknown) { return `data: ${JSON.stringify(o)}\n\n` }

Bun.serve({
  port: PORT, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models"))
      return Response.json({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] })
    if (!url.pathname.endsWith("/chat/completions")) return new Response("ok")
    const body = (await req.json().catch(() => ({}))) as { messages?: Array<{ role: string }> }
    const hasToolResult = body.messages?.some((m) => m.role === "tool")
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (o: unknown) => c.enqueue(enc.encode(frame(o)))
        if (!hasToolResult) {
          send({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "todowrite", arguments: JSON.stringify({ todos: TODOS }) } }] }, finish_reason: null }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
        } else {
          send({ choices: [{ index: 0, delta: { content: "plan written" }, finish_reason: null }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        }
        c.enqueue(enc.encode("data: [DONE]\n\n"))
        c.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})
console.log(`[mock-llm-todowrite] listening :${PORT}`)
