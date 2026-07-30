// mock-llm-orchestration.ts — OpenAI-compatible mock for orchestrator runs.
//
// The orchestrator's step contract is a FILE: `buildStepPrompt` appends
// "必须把最终交付物完整写入这个文件（覆盖写）：<abs path>" and the step fails if
// that file doesn't exist. So a mock that only streams text makes every run fail
// with "deliverable missing" — the run would then only ever exercise the FAILURE
// path, and any cleanup observed afterwards would be self-inflicted.
//
// Hence: parse the path out of the prompt and honour the contract with a real
// `write` tool call. `[[NOWRITE]]` opts out on purpose, so a harness can still
// reach the deliverable-missing branch (the one that deliberately KEEPS the
// worktree) — without an opt-out this mock is too obedient to ever fail a step.
//
// Env: MOCK_LLM_PORT (8696)
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8696)

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const delta = (content: string | null, finish: string | null) => ({
  id: "chatcmpl-orch",
  object: "chat.completion.chunk",
  created: 1700000000,
  model: "mock-model",
  choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
})

let calls = 0

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] })
    }
    if (!url.pathname.endsWith("/chat/completions")) return new Response("ok")

    calls++
    const body = (await req.json().catch(() => ({}))) as { messages?: Array<{ role: string; content?: unknown }> }
    const msgs = body.messages ?? []
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")
    const text =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? (lastUser!.content as Array<{ text?: string }>).map((p) => p.text ?? "").join(" ")
          : ""
    const afterTool = msgs[msgs.length - 1]?.role === "tool"

    // Keep this regex in sync with `artifacts.ts buildStepPrompt` (gotchas §9:
    // the deliverable contract lives in prompt text, so changing the wording
    // there silently breaks every orchestration harness).
    const refuseWrite = text.includes("[[NOWRITE]]")
    const deliverable = refuseWrite ? undefined : /写入这个文件(?:（覆盖写）)?[：:]\s*(\S+)/.exec(text)?.[1]
    // A long turn gives a harness a window to cancel mid-flight.
    const slow = text.includes("[[SLOW]]")
    if (process.env.E2E_VERBOSE === "1")
      console.log(`[mock] #${calls} afterTool=${afterTool} deliverable=${deliverable ?? "-"} text=${JSON.stringify(text.slice(0, 60))}`)

    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const send = (o: unknown) => c.enqueue(enc.encode(frame(o)))
        try {
          if (deliverable && !afterTool) {
            send({
              choices: [{
                index: 0,
                delta: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    index: 0,
                    id: `call_${calls}`,
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ filePath: deliverable, content: `# deliverable\n\ncall ${calls}\n` }),
                    },
                  }],
                },
                finish_reason: null,
              }],
            })
            send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
          } else {
            send(delta("", null))
            const chunks = slow ? 200 : 3
            for (let i = 1; i <= chunks; i++) {
              send(delta(`M${String(i).padStart(4, "0")} `, null))
              if (slow) await new Promise((r) => setTimeout(r, 100))
            }
            send(delta(null, "stop"))
          }
          c.enqueue(enc.encode("data: [DONE]\n\n"))
          c.close()
        } catch {
          // client aborted mid-stream (a cancel test doing its job)
          try { c.close() } catch {}
        }
      },
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    })
  },
})
console.log(`[mock-llm-orchestration] listening on http://127.0.0.1:${PORT}`)
