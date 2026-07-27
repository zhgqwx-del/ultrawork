// mock-llm-math.ts — OpenAI-compatible mock that streams an answer full of LaTeX,
// so a REAL opencode turn renders through the REAL MarkdownContent pipeline.
// Mirrors the answer shape from the screenshot that opened discussions/055.
// Env: MOCK_LLM_PORT.
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8098)

// Deliberately covers every case the unit tests pin, plus the two that only a
// real browser can judge: a display formula far wider than the reading column
// (W1) and enough formulas to make streaming reflow visible (W2).
const ANSWER = [
  "## 拒绝采样（Rejection Sampling）",
  "",
  "拒绝采样是一种从复杂概率分布中生成样本的蒙特卡洛方法。",
  "",
  "### 基本流程",
  "",
  "1. 选择提议分布 $q(x)$，并找到常数 $M$，使得对所有 $x$ 都满足：$M \\cdot q(x) \\geq p(x)$",
  "2. 从 $q(x)$ 中随机抽取样本 $x_0$，再取 $u \\sim U(0,1)$",
  "3. 以概率 $\\frac{p(x^*)}{M \\cdot q(x^*)}$ **接受**该样本，否则**拒绝**并重复",
  "",
  "接受率满足：",
  "",
  // Deliberately far wider than the ~810px chat column, so W1 is actually
  // exercised in the real app. A merely "long" formula (e.g. plain KL
  // divergence, ~600px) still fits and would make the overflow assertions
  // vacuous — that happened on the first run of this test.
  "$$",
  "D_{KL}(P \\parallel Q) = \\sum_{x \\in \\mathcal{X}} P(x) \\log\\left(\\frac{P(x)}{Q(x)}\\right) + \\int_{-\\infty}^{+\\infty} f(x)\\,dx - \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}} + \\alpha\\beta\\gamma\\delta\\epsilon\\zeta\\eta\\theta\\iota\\kappa\\lambda\\mu\\nu\\xi\\pi\\rho\\sigma\\tau\\upsilon\\phi\\chi\\psi\\omega + \\sum_{k=1}^{\\infty} \\frac{(-1)^{k+1}}{k^2} \\cdot \\prod_{j=1}^{m} \\binom{n}{j}",
  "$$",
  "",
  "### 关键要点",
  "",
  "| 要素 | 说明 |",
  "| --- | --- |",
  "| 提议分布 $q(x)$ | 容易采样的分布 |",
  "| 接受率 | 等于 $\\frac{1}{M}$ |",
  "",
  "环境变量不是公式：`$PATH` 与 `$HOME`。",
  "",
  "```python",
  'price = f"${x}"',
  "```",
  "",
  "以上。",
].join("\n")

// Chunk small enough that the transcript visibly builds up mid-formula — that is
// the condition under which streaming reflow (W2) would show.
const SEGMENTS = ANSWER.match(/[\s\S]{1,24}/g) ?? [ANSWER]

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
          for (const seg of SEGMENTS) { send(chunk(seg, null)); await new Promise((r) => setTimeout(r, 45)) }
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
console.log(`[mock-llm-math] listening on ${PORT}`)
