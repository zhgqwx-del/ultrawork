// websearch-byok.e2e.ts — guards the ADR-042 vendor patch end-to-end against the
// REAL (patched) opencode binary, with a stub Tavily/IQS HTTP server and a mock
// OpenAI-compatible LLM that (a) records the `tools` array of every request and
// (b) emits a `websearch` tool_call when the tool is present. Asserts the full
// BYOK ladder:
//   A. no key            → websearch NOT in the model's tool list (degraded state)
//   B. PUT search-tavily → tool appears on the NEXT prompt (auth.json read fresh,
//      no refresh call) + executes against the Tavily stub with the Bearer key +
//      formatted results reach the answer; GET /global/auth/:id/status flips
//   C. PATCH ?refresh=soft provider=aliyun-iqs → explicit provider wins, IQS stub
//      hit (engineType/timeRange body shape) — proves soft refresh applies config
//   D. PATCH ?refresh=soft enabled=false → tool gone again
//
//   cd packages/client/desktop && bun run --bun e2e:websearch   # exit 0 = PASS
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const OPENCODE = join(HERE, "..", "src-tauri", "binaries", "opencode-server-aarch64-apple-darwin")
const PW = "ws-pw"
const LLM = 8092
const STUB = 8093
const OC = 4103
const TAVILY_KEY = "tvly-e2e-good"
const IQS_KEY = "iqs-e2e-good"

// ---------- in-process stub: Tavily + IQS ----------
type StubHit = { path: string; auth: string | null; body: any }
const stubHits: StubHit[] = []
Bun.serve({
  port: STUB,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    const body = await req.json().catch(() => ({}))
    const auth = req.headers.get("authorization")
    stubHits.push({ path: url.pathname, auth, body })
    if (url.pathname === "/search") {
      if (auth !== `Bearer ${TAVILY_KEY}`) return new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 })
      return Response.json({
        query: body.query,
        answer: "Stub Tavily answer.",
        results: [
          { title: "TAVILY-RESULT-ONE", url: "https://stub.tavily/one", content: "tavily snippet one", score: 0.99 },
          { title: "TAVILY-RESULT-TWO", url: "https://stub.tavily/two", content: "tavily snippet two", score: 0.42 },
        ],
      })
    }
    if (url.pathname === "/search/unified") {
      if (auth !== `Bearer ${IQS_KEY}`) return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 })
      return Response.json({
        pageItems: [
          { title: "IQS-RESULT-ONE", link: "https://stub.iqs/one", snippet: "iqs snippet", publishedTime: "2026-07-01T00:00:00", rerankScore: 0.9 },
        ],
        searchInformation: { searchTime: 42 },
      })
    }
    return new Response("not found", { status: 404 })
  },
})

// ---------- in-process mock LLM (OpenAI-compatible, streaming) ----------
const toolLog: string[][] = [] // tools[] names per /chat/completions request
function frame(o: unknown) {
  return `data: ${JSON.stringify(o)}\n\n`
}
Bun.serve({
  port: LLM,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models"))
      return Response.json({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] })
    if (!url.pathname.endsWith("/chat/completions")) return new Response("ok")
    const body = (await req.json().catch(() => ({}))) as {
      messages?: Array<{ role: string; content: unknown }>
      tools?: Array<{ function?: { name?: string } }>
    }
    const names = (body.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean)
    toolLog.push(names)
    const toolMsg = body.messages?.find((m) => m.role === "tool")
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (o: unknown) => c.enqueue(enc.encode(frame(o)))
        if (toolMsg) {
          const txt = "ANSWER:" + (typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content))
          send({ choices: [{ index: 0, delta: { content: txt }, finish_reason: null }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        } else if (names.includes("websearch")) {
          send({
            choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_ws", type: "function", function: { name: "websearch", arguments: JSON.stringify({ query: "latest ai news", numResults: 2 }) } }] }, finish_reason: null }],
          })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
        } else {
          send({ choices: [{ index: 0, delta: { content: "NOTOOL" }, finish_reason: null }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        }
        c.enqueue(enc.encode("data: [DONE]\n\n"))
        c.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})

// ---------- harness ----------
const procs: ReturnType<typeof Bun.spawn>[] = []
async function poll(fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try {
      if (await fn()) return
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error("timeout")
}

const tmp = mkdtempSync(join(tmpdir(), "wsbyok-"))
const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const llmURL = `http://127.0.0.1:${LLM}/v1`
writeFileSync(
  join(tmp, ".config/ultrawork/opencode.json"),
  JSON.stringify({
    model: "mockprov/mock-model",
    provider: {
      mockprov: {
        name: "Mock",
        npm: "@ai-sdk/openai-compatible",
        api: llmURL,
        options: { baseURL: llmURL, apiKey: "x" },
        models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } },
        whitelist: ["mock-model"],
      },
    },
  }),
)
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const H = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const OCURL = `http://127.0.0.1:${OC}`

const checks: Array<[string, boolean, string?]> = []
const ok = (name: string, cond: boolean, detail?: string) => {
  checks.push([name, cond, detail])
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail && !cond ? ` — ${detail}` : ""}`)
}

async function promptAndWait(text: string): Promise<string> {
  const session = (await (await fetch(`${OCURL}/session`, { method: "POST", headers: H, body: "{}" })).json()) as { id: string }
  await fetch(`${OCURL}/session/${session.id}/prompt_async`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ parts: [{ type: "text", text }], model: { providerID: "mockprov", modelID: "mock-model" } }),
  })
  // Poll for a terminal answer instead of a fixed sleep (idle = answer text present).
  let all = ""
  await poll(async () => {
    const sm = (await (await fetch(`${OCURL}/session/${session.id}/message`, { headers: H })).json()) as Array<{
      info?: { role?: string }
      parts?: Array<{ type: string; text?: string }>
    }>
    all = sm
      .filter((m) => m.info?.role === "assistant")
      .flatMap((m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? ""))
      .join("")
    return all.includes("ANSWER:") || all.includes("NOTOOL")
  }, 30000)
  return all
}

let verdict = "INCOMPLETE"
try {
  const p = Bun.spawn([OPENCODE, "serve", "--port", String(OC)], {
    env: {
      ...process.env,
      HOME: tmp,
      XDG_CONFIG_HOME: join(tmp, ".config"),
      XDG_DATA_HOME: join(tmp, ".local/share"),
      OPENCODE_SERVER_PASSWORD: PW,
      OPENCODE_APP_NAME: "ultrawork",
      ULTRAWORK_TAVILY_BASE_URL: `http://127.0.0.1:${STUB}`,
      ULTRAWORK_ALIYUN_IQS_BASE_URL: `http://127.0.0.1:${STUB}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  procs.push(p)
  await poll(async () => (await fetch(`${OCURL}/global/health`, { headers: { authorization: auth } })).ok)

  // --- A. no key → websearch absent, agent degrades ---
  const aStatus = (await (await fetch(`${OCURL}/global/auth/search-tavily/status`, { headers: H })).json()) as { configured: boolean }
  ok("A: auth status route reports unconfigured", aStatus.configured === false)
  const aAnswer = await promptAndWait("what's new in ai today?")
  const aTools = toolLog[toolLog.length - 1] ?? []
  ok("A: websearch NOT in tool list without key", !aTools.includes("websearch"), aTools.join(","))
  ok("A: turn degrades gracefully", aAnswer.includes("NOTOOL"))

  // --- B. configure Tavily key → tool registers on next prompt, executes against stub ---
  await fetch(`${OCURL}/auth/search-tavily`, { method: "PUT", headers: H, body: JSON.stringify({ type: "api", key: TAVILY_KEY }) })
  const bStatus = (await (await fetch(`${OCURL}/global/auth/search-tavily/status`, { headers: H })).json()) as { configured: boolean; type?: string }
  ok("B: auth status flips to configured/api", bStatus.configured === true && bStatus.type === "api")
  const bAnswer = await promptAndWait("what's new in ai today?")
  const bToolsReq = toolLog.find((names, i) => i >= toolLog.length - 2 && names.includes("websearch"))
  ok("B: websearch in tool list after key (no refresh call needed)", !!bToolsReq)
  const bHit = stubHits.find((h) => h.path === "/search")
  ok("B: Tavily stub hit with Bearer key", bHit?.auth === `Bearer ${TAVILY_KEY}`)
  ok("B: request body carries query + clamped numResults", bHit?.body?.query === "latest ai news" && bHit?.body?.max_results === 2)
  ok("B: formatted results reach the answer", bAnswer.includes("TAVILY-RESULT-ONE") && bAnswer.includes("provider: tavily"))
  ok("B: tavily answer surfaced", bAnswer.includes("Stub Tavily answer."))

  // --- C. explicit provider aliyun-iqs via soft refresh ---
  await fetch(`${OCURL}/auth/search-aliyun-iqs`, { method: "PUT", headers: H, body: JSON.stringify({ type: "api", key: IQS_KEY }) })
  await fetch(`${OCURL}/global/config?refresh=soft`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ experimental: { websearch: { provider: "aliyun-iqs" } } }),
  })
  const cAnswer = await promptAndWait("what's new in ai today?")
  const cHit = stubHits.find((h) => h.path === "/search/unified")
  ok("C: IQS stub hit with Bearer key after soft refresh", cHit?.auth === `Bearer ${IQS_KEY}`)
  ok("C: IQS body shape (engineType/advancedParams)", cHit?.body?.engineType === "LiteAdvanced" && cHit?.body?.advancedParams?.numResults === 2)
  ok("C: answer names IQS provider + stub result", cAnswer.includes("provider: aliyun-iqs") && cAnswer.includes("IQS-RESULT-ONE"))

  // --- C2. provider:"auto" clears the explicit choice (PATCH merge can't delete keys) ---
  await fetch(`${OCURL}/global/config?refresh=soft`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ experimental: { websearch: { provider: "auto" } } }),
  })
  const tavilyHitsBefore = stubHits.filter((h) => h.path === "/search").length
  await promptAndWait("what's new in ai today?")
  const tavilyHitsAfter = stubHits.filter((h) => h.path === "/search").length
  ok("C2: provider:'auto' falls back to priority order (tavily first)", tavilyHitsAfter === tavilyHitsBefore + 1)

  // --- D. disable via soft refresh → tool gone ---
  await fetch(`${OCURL}/global/config?refresh=soft`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ experimental: { websearch: { enabled: false } } }),
  })
  const dAnswer = await promptAndWait("what's new in ai today?")
  const dTools = toolLog[toolLog.length - 1] ?? []
  ok("D: websearch gone after enabled=false (soft)", !dTools.includes("websearch"), dTools.join(","))
  ok("D: degrades gracefully again", dAnswer.includes("NOTOOL"))

  const failed = checks.filter(([, c]) => !c)
  verdict = failed.length === 0 ? `PASS ✅ — ${checks.length}/${checks.length}` : `FAIL ❌ — ${failed.length}/${checks.length} failed`
} catch (e) {
  verdict = `ERROR: ${(e as Error).message}`
} finally {
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) {
    try {
      p.kill()
    } catch {}
  }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
