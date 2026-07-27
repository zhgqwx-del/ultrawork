// im-math-degrade.e2e.ts — LaTeX→Unicode degradation on the REAL IM outbound path
// (ADR-070 D5 / discussions/055 §十二).
//
// The unit tests call `degradeMathToUnicode` directly and drive the Bridge with a
// mocked opencode. Neither one exercises the path an actual IM reply takes: a real
// model answer, streamed as real SSE deltas, cut into blocks by the real
// BlockChunker, each block passing through the real `send()`. Every one of those
// is a place a formula could be split, re-ordered or degraded twice.
//
// Uses the SAME mock answer as `math-render-realapp.e2e.ts`, on purpose: that makes
// the two tests a true A/B on identical input — the desktop renders it as maths,
// the IM path degrades it to Unicode, and both are checked against one source.
//
// Flow (only the IM adapter is a stub; everything else is real):
//   mock-llm-math → REAL opencode → REAL Bridge (SSE + BlockChunker + send)
//                 → captured outbound text
//
//   cd packages/client/desktop && bun run --bun e2e:im-math   # exit 0 = PASS
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const BUN = process.execPath
const OPENCODE = join(HERE, "..", "src-tauri", "binaries", "opencode-server-aarch64-apple-darwin")
const PW = "immath-pw"
const OC = 4386 // off the standard ports so a running dev app doesn't collide
const LLM = 4387

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try { if (await fn()) return } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error("timeout")
}

const results: [string, boolean, string][] = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail])
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
}

// Same HOME-redirect guard as channel-session-rotation.e2e.ts: `os.homedir()`
// resolves once at process start, so the redirect has to be in place before this
// process exists — hence the re-exec. The Bridge's SessionStore writes a real file
// under ~/.ultrawork, and this test must never touch the developer's.
const CHILD = process.env.IMMATH_TMP

if (!CHILD) {
  const parentTmp = mkdtempSync(join(tmpdir(), "immath-"))
  const child = Bun.spawn([BUN, "run", import.meta.path], {
    env: {
      ...process.env,
      HOME: parentTmp,
      USERPROFILE: parentTmp, // windows
      IMMATH_TMP: parentTmp,
      XDG_CONFIG_HOME: join(parentTmp, ".config"),
      XDG_DATA_HOME: join(parentTmp, ".local/share"),
      OPENCODE_SERVER_PASSWORD: PW,
      OPENCODE_BASE_URL: `http://127.0.0.1:${OC}`,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  rmSync(parentTmp, { recursive: true, force: true })
  process.exit(code)
}

const tmp = CHILD
if (homedir() !== tmp) {
  console.error(`FATAL: HOME redirect failed (homedir()=${homedir()}, expected ${tmp}). Refusing to run.`)
  process.exit(1)
}

const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })

const llmBase = `http://127.0.0.1:${LLM}/v1`
writeFileSync(
  join(tmp, ".config/ultrawork/opencode.json"),
  JSON.stringify({
    model: "mockprov/mock-model",
    provider: {
      mockprov: {
        name: "Mock",
        npm: "@ai-sdk/openai-compatible",
        api: llmBase,
        options: { baseURL: llmBase, apiKey: "x" },
        models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } },
        whitelist: ["mock-model"],
      },
    },
  }),
)

const env = {
  HOME: tmp,
  XDG_CONFIG_HOME: join(tmp, ".config"),
  XDG_DATA_HOME: join(tmp, ".local/share"),
  OPENCODE_SERVER_PASSWORD: PW,
  // Without this opencode looks for its config under a different app name and
  // reports "No provider available" — the turn then errors and every content
  // assertion below passes vacuously against an empty string.
  OPENCODE_APP_NAME: "ultrawork",
}

try {
  spawn([BUN, "run", join(HERE, "mock-llm-math.ts")], { MOCK_LLM_PORT: String(LLM) })
  await poll(async () => (await fetch(`${llmBase}/models`)).ok)

  spawn([OPENCODE, "serve", "--hostname", "127.0.0.1", "--port", String(OC)], env)
  const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
  await poll(async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)

  const { Bridge } = await import("../../../channel/gateway/src/bridge.js")

  // One capture per channel type. The degradation lives in the shared `send()`,
  // so all four must come out identical — that is the claim being tested, and it
  // is the whole reason the code is not in the adapters.
  const CHANNELS = ["dingtalk", "wechat", "wecom", "feishu"]
  const outbound = new Map<string, string[]>(CHANNELS.map((c) => [c, []]))

  const bridge = new Bridge()
  await bridge.init()

  const msg = (channelType: string) => ({
    chatId: `u-${channelType}`,
    senderId: "s-1",
    senderName: "张三",
    channelType,
    text: "拒绝采样是指?",
    workspaceDir: ws,
    raw: {},
    reply: async (c: string) => { outbound.get(channelType)!.push(c) },
  }) as any

  for (const c of CHANNELS) await bridge.handleMessage(msg(c))
  // Wait for every turn to finish — blocks stream out as the agent produces them,
  // so an early read would see a partial reply and the assertions would be vacuous.
  await poll(async () => (bridge as any).activeContexts.size === 0, 60000)
  await new Promise((r) => setTimeout(r, 500)) // let the send chains drain

  const dingtalk = outbound.get("dingtalk")!.join("\n\n")

  // --- the turn produced something at all ----------------------------------
  // Non-vacuity gate (conventions §19). Half the assertions below are "X is NOT
  // present" and pass trivially against an empty string — the first run of this
  // harness had a misconfigured opencode, the turn errored out, and 4 checks went
  // green on a 51-char error message. Abort rather than report a green run.
  const produced = dingtalk.length > 200 && dingtalk.includes("拒绝采样")
  check("0. a real turn produced outbound text", produced, `${dingtalk.length} chars`)
  console.log("\n----- outbound (dingtalk) -----\n" + dingtalk + "\n-------------------------------\n")
  if (!produced) {
    console.error("FATAL: no real answer was produced — every check below would be vacuous. Aborting.")
    for (const p of procs) p.kill()
    process.exit(1)
  }

  // --- formulas actually degraded -------------------------------------------
  check("1. inline formula degraded", dingtalk.includes("M⋅q(x)≥p(x)"))
  check("2. fraction kept a fraction (not flattened)", dingtalk.includes("1/M") && !dingtalk.includes("1M"))
  check("3. the screenshot formula degraded", dingtalk.includes("p(x^(∗))/(M⋅q(x^(∗)))"))
  check("4. table cell formula degraded", dingtalk.includes("| 1/M |") || dingtalk.includes("1/M"))
  check("5. subscript rendered as Unicode", dingtalk.includes("x₀"))

  // --- nothing was left as source -------------------------------------------
  // Anything still wrapped in `$` outside code is a formula the user reads as
  // source. Strip code first, the same regions the degrader skips.
  const outsideCode = dingtalk
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
  const leftoverSpans = outsideCode.match(/\$\$[\s\S]+?\$\$|\$(?!\$)[^\n$]+?\$/g) ?? []
  check("6. no LaTeX span survived outside code", leftoverSpans.length === 0, JSON.stringify(leftoverSpans.slice(0, 3)))
  const leftoverCmds = outsideCode.match(/\\[a-zA-Z]+/g) ?? []
  check("7. no \\command sequences left outside code", leftoverCmds.length === 0, JSON.stringify(leftoverCmds.slice(0, 5)))

  // --- what must NOT be touched ---------------------------------------------
  check("8. inline code `$PATH` / `$HOME` untouched", dingtalk.includes("`$PATH`") && dingtalk.includes("`$HOME`"))
  // The mock's python fence contains `f"${x}"` — a `${x}` that KaTeX would happily
  // parse. If fence-skipping regressed, this is where it shows.
  check("9. fenced code block untouched", dingtalk.includes('f"${x}"'), 'expected f"${x}" verbatim')

  // --- the display formula, which is the one a chunker could split -----------
  // The mock's display block is enormous (the W1 case). It must come through as
  // ONE degraded string, not half-degraded.
  const hasBigDisplay = dingtalk.includes("D_(KL)") && dingtalk.includes("∑")
  check("10. huge display formula degraded whole", hasBigDisplay,
    hasBigDisplay ? "" : "display block may have been split across chunks")

  // --- all four channels get the identical text -----------------------------
  // This is the point of putting it in bridge.send() instead of the adapters.
  const joined = CHANNELS.map((c) => outbound.get(c)!.join("\n\n"))
  const allSame = joined.every((t) => t === joined[0])
  check("11. all four channels got identical degraded text", allSame,
    allSame ? "" : joined.map((t, i) => `${CHANNELS[i]}:${t.length}`).join(" "))

  // --- prose survived intact ------------------------------------------------
  check("12. surrounding prose untouched",
    dingtalk.includes("拒绝采样是一种从复杂概率分布中生成样本的蒙特卡洛方法") && dingtalk.includes("以上。"))

  // --- idempotence: the outbound text is a fixed point -----------------------
  // The Bridge degrades per block; a second pass must be a no-op, or a retry /
  // re-send path would slowly corrupt text.
  const { degradeMathToUnicode } = await import("../../../channel/gateway/src/math-unicode.js")
  check("13. degradation is idempotent", degradeMathToUnicode(dingtalk) === dingtalk)

  await bridge.shutdown()
} finally {
  for (const p of procs) p.kill()
  rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.error("FAILED:\n" + failed.map(([n, , d]) => `  ✗ ${n} ${d}`).join("\n"))
  process.exit(1)
}
console.log("✅ all checks passed")
