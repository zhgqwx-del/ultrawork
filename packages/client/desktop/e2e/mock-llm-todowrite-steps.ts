// Mock OpenAI-compatible LLM that drives a MULTI-STEP todowrite turn (ADR-038
// switch-back e2e): within one turn it calls `todowrite` several times with
// evolving statuses, pausing between calls so the turn lasts long enough to
// switch away and back mid-flight. The Nth response is chosen by how many tool
// results the request already carries.
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8090)
const STEP_DELAY_MS = Number(process.env.MOCK_LLM_STEP_DELAY_MS ?? 2500)

const C = ["Set up project", "Write core module", "Verify it runs"]
// One whole-list snapshot per todowrite call (整表替换).
const SNAPSHOTS = [
  [["in_progress", C[0]], ["pending", C[1]], ["pending", C[2]]],
  [["completed", C[0]], ["in_progress", C[1]], ["pending", C[2]]],
  [["completed", C[0]], ["completed", C[1]], ["in_progress", C[2]]],
  [["completed", C[0]], ["completed", C[1]], ["completed", C[2]]],
] as const

function todos(i: number) {
  return SNAPSHOTS[i].map(([status, content]) => ({ content, status, priority: "medium" }))
}
function frame(o: unknown) { return `data: ${JSON.stringify(o)}\n\n` }

Bun.serve({
  port: PORT, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models"))
      return Response.json({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] })
    if (!url.pathname.endsWith("/chat/completions")) return new Response("ok")
    const body = (await req.json().catch(() => ({}))) as { messages?: Array<{ role: string }> }
    const seen = body.messages?.filter((m) => m.role === "tool").length ?? 0
    await new Promise((r) => setTimeout(r, STEP_DELAY_MS)) // stretch the turn
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (o: unknown) => c.enqueue(enc.encode(frame(o)))
        if (seen < SNAPSHOTS.length) {
          send({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${seen}`, type: "function", function: { name: "todowrite", arguments: JSON.stringify({ todos: todos(seen) }) } }] }, finish_reason: null }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
        } else {
          send({ choices: [{ index: 0, delta: { content: "all steps complete" }, finish_reason: null }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        }
        c.enqueue(enc.encode("data: [DONE]\n\n"))
        c.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})
console.log(`[mock-llm-todowrite-steps] listening :${PORT}, step delay ${STEP_DELAY_MS}ms`)
