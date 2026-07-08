// mock-llm-markdown.ts — OpenAI-compatible mock that streams a fixed MARKDOWN
// answer (an h2 + a bullet list), so a real opencode turn renders through the
// real MarkdownContent (.chat-md) and we can assert the reading-column typography
// (13px body / 16px h2 / tightened leading) in a real browser. Env: MOCK_LLM_PORT.
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8091)

const SEGMENTS = [
  "根据搜索结果，今天（2026年7月4日）主要 AI 新闻：\n\n",
  "## 国内动态\n\n",
  "- **阿里全面禁用 Claude Code**：因安全风险被列入高风险软件名单\n",
  "- **美团发布万亿参数模型**：五万卡国产算力集群完成训练\n\n",
  "## 国际动态\n\n",
  "- Anthropic 全面封杀未授权访问，重点打击\"中转站\"\n",
]

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
          for (const seg of SEGMENTS) { send(chunk(seg, null)); await new Promise((r) => setTimeout(r, 80)) }
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
console.log(`[mock-llm-markdown] listening on http://127.0.0.1:${PORT}`)
