// mock-llm-write.ts — OpenAI-compatible mock that drives the transcript-artifact
// walkthrough deterministically.
//
// Per turn it first emits a `write` tool call (so opencode really writes the file
// and really records a tool part), then — once the tool result comes back — streams
// a markdown answer carrying every link shape we need to assert on.
//
// The file written on each turn comes from MOCK_LLM_FILES (comma-separated). Turn 3
// deliberately repeats turn 1's file: that is the last-wins case, and it is the one
// behaviour no unit test can prove end-to-end.
//
// Env: MOCK_LLM_PORT, MOCK_WS (workspace root), MOCK_LLM_FILES
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8093)
const WS = process.env.MOCK_WS ?? "/tmp"
const FILES = (process.env.MOCK_LLM_FILES ?? "report.md,notes.md,report.md").split(",")

/** The answer text. Every link shape the transcript must handle, in one message. */
function answer(turn: number): string {
  return (
    `第 ${turn} 轮完成。\n\n` +
    `参考 [文档](https://example.com/docs) 了解更多，` +
    `或直接访问 https://example.com/bare 。\n\n` +
    `本地文件见 [报告](./report.md)，锚点见 [章节](#detail)。\n`
  )
}

function frame(o: unknown) {
  return `data: ${JSON.stringify(o)}\n\n`
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
    if (!url.pathname.endsWith("/chat/completions")) return new Response("ok")

    const body = (await req.json().catch(() => ({}))) as { messages?: Array<{ role: string }> }
    const msgs = body.messages ?? []
    // Which turn are we in? One user message per turn.
    const turn = Math.max(1, msgs.filter((m) => m.role === "user").length)
    // Has this turn's write already run? opencode appends the tool result last.
    const afterTool = msgs[msgs.length - 1]?.role === "tool"
    const file = FILES[Math.min(turn, FILES.length) - 1]

    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (o: unknown) => c.enqueue(enc.encode(frame(o)))
        if (!afterTool) {
          send({
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${turn}`,
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({
                          filePath: `${WS}/${file}`,
                          content: `# ${file}\n\nwritten on turn ${turn}\n`,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
        } else {
          send({ choices: [{ index: 0, delta: { content: answer(turn) }, finish_reason: null }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        }
        c.enqueue(enc.encode("data: [DONE]\n\n"))
        c.close()
      },
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  },
})
console.log(`[mock-llm-write] listening :${PORT}, ws=${WS}, files=${FILES.join("|")}`)
