// im-math-sidecar-blackbox.e2e.ts — the LaTeX degradation as the CUSTOMER gets it:
// the **compiled sidecar binary** we actually ship, driven through a real channel
// adapter, asserted on the bytes it POSTs to the IM server (ADR-070 D5).
//
// `im-math-degrade.e2e.ts` imports `bridge.ts` in-process. That leaves the last
// gap open: the artifact that ships is `channel-gateway-<triple>`, produced by
// `bun build --compile`. Bundling is where an inlined dependency, a regex feature
// or a lazily-resolved module would break — and none of it is visible from source.
//
// The WeChat adapter's ilink `baseUrl` comes from the channel config, so it can be
// pointed at a local server. That makes a true black-box run possible without any
// real IM account:
//
//   mock ilink server ──getupdates──► REAL compiled gateway binary
//                                        │  (real ChannelManager + WeChat adapter
//                                        │   + Bridge + send() + stripMarkdown)
//                                        ▼
//                                   REAL opencode ──► mock-llm-math
//                                        │
//   captured POST /ilink/bot/sendmessage ◄┘   ← assertions run on this
//
//   cd packages/client/desktop && bun run --bun e2e:im-math-blackbox   # exit 0 = PASS
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const BUN = process.execPath
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const BIN = join(HERE, "..", "src-tauri", "binaries", `channel-gateway-${ARCH}-apple-darwin`)
const OPENCODE = join(HERE, "..", "src-tauri", "binaries", `opencode-server-${ARCH}-apple-darwin`)
const PW = "blackbox-pw"
const OC = 4396
const LLM = 4397
const ILINK = 4398
const GW = 4399

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 90000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try { if (await fn()) return } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timeout: ${label}`)
}

const results: [string, boolean, string][] = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail])
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
}

// Same HOME-redirect guard as the other gateway harnesses: the binary reads
// ~/.ultrawork/channels.json and writes ~/.ultrawork/session-map.json, both real
// files. `os.homedir()` resolves at process start, so the redirect must precede
// this process — hence the re-exec.
const CHILD = process.env.BLACKBOX_TMP

if (!CHILD) {
  const parentTmp = mkdtempSync(join(tmpdir(), "blackbox-"))
  const child = Bun.spawn([BUN, "run", import.meta.path], {
    env: { ...process.env, HOME: parentTmp, USERPROFILE: parentTmp, BLACKBOX_TMP: parentTmp },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  rmSync(parentTmp, { recursive: true, force: true })
  process.exit(code)
}

const tmp = CHILD
if (homedir() !== tmp) {
  console.error(`FATAL: HOME redirect failed (homedir()=${homedir()}). Refusing to run.`)
  process.exit(1)
}

const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
mkdirSync(join(tmp, ".ultrawork"), { recursive: true })

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

// The channel the binary will auto-connect on startup, pointed at our mock.
writeFileSync(
  join(tmp, ".ultrawork", "channels.json"),
  JSON.stringify({
    channels: [{
      id: "ch-blackbox",
      name: "微信",
      type: "wechat",
      workspaceDir: ws,
      autoConnect: true,
      botToken: "tok",
      ilinkBotId: "bot-1",
      ilinkUserId: "user-1",
      baseUrl: `http://127.0.0.1:${ILINK}`,
    }],
  }, null, 2),
)

// --- mock ilink server ------------------------------------------------------
const sent: string[] = []
let delivered = false
const ilink = Bun.serve({
  hostname: "127.0.0.1",
  port: ILINK,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/ilink/bot/getupdates") {
      if (!delivered) {
        delivered = true
        return Response.json({
          ret: 0,
          get_updates_buf: "cursor-1",
          msgs: [{
            message_type: 1, // MSG_TYPE_USER
            from_user_id: "u-blackbox",
            context_token: "ctx-1",
            item_list: [{ type: 1, text_item: { text: "拒绝采样是指?" } }],
          }],
        })
      }
      // Idle poll. Held briefly so the adapter's loop doesn't spin.
      await new Promise((r) => setTimeout(r, 800))
      return Response.json({ ret: 0, msgs: [] })
    }
    if (url.pathname === "/ilink/bot/sendmessage") {
      const body = (await req.json()) as any
      for (const item of body?.msg?.item_list ?? []) {
        if (item?.text_item?.text) sent.push(item.text_item.text)
      }
      return Response.json({ ret: 0 })
    }
    // getconfig / sendtyping / anything else
    return Response.json({ ret: 0 })
  },
})

try {
  spawn([BUN, "run", join(HERE, "mock-llm-math.ts")], { MOCK_LLM_PORT: String(LLM) })
  await poll("mock-llm", async () => (await fetch(`${llmBase}/models`)).ok)

  spawn([OPENCODE, "serve", "--hostname", "127.0.0.1", "--port", String(OC)], {
    HOME: tmp,
    XDG_CONFIG_HOME: join(tmp, ".config"),
    XDG_DATA_HOME: join(tmp, ".local/share"),
    OPENCODE_SERVER_PASSWORD: PW,
    OPENCODE_APP_NAME: "ultrawork",
  })
  const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
  await poll("opencode", async () =>
    (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)

  // The shipped artifact, spawned exactly as the Tauri host spawns it.
  const gw = spawn([BIN], {
    HOME: tmp,
    XDG_CONFIG_HOME: join(tmp, ".config"),
    XDG_DATA_HOME: join(tmp, ".local/share"),
    GATEWAY_PORT: String(GW),
    OPENCODE_BASE_URL: `http://127.0.0.1:${OC}`,
    OPENCODE_SERVER_PASSWORD: PW,
    ULTRAWORK_SIDECAR_PASSWORD: PW,
  })
  // Surface the binary's own logs — if it dies on startup this is the only clue.
  ;(async () => {
    for await (const chunk of gw.stdout as ReadableStream) process.stdout.write(chunk)
  })().catch(() => {})

  await poll("gateway binary listening", async () =>
    (await fetch(`http://127.0.0.1:${GW}/health`).catch(() => ({ status: 0 } as any))).status !== 0)

  // The turn streams out in blocks; wait for the tail of the answer to land.
  await poll("outbound reply", async () => sent.join("\n").includes("以上。"), 90000)
  await new Promise((r) => setTimeout(r, 800)) // let any trailing block arrive

  const out = sent.join("\n\n")
  console.log(`\n----- 编译后 sidecar 真实 POST 出去的报文（${sent.length} 条）-----\n${out}\n----------------------------------------\n`)

  // Non-vacuity gate first (conventions §19): most checks below are negative.
  const produced = out.length > 200 && out.includes("拒绝采样")
  check("0. 编译产物真的发出了完整回答", produced, `${out.length} 字符 / ${sent.length} 条消息`)
  if (!produced) {
    console.error("FATAL: 出站为空或不完整，后续断言全是空转。中止。")
    ilink.stop(true)
    for (const p of procs) p.kill()
    process.exit(1)
  }

  check("1. 行内公式已降级", out.includes("M⋅q(x)≥p(x)"))
  check("2. 分式没有被拍平", out.includes("1/M") && !out.includes("1M"))
  check("3. 截图那条公式已降级", out.includes("p(x^(∗))/(M⋅q(x^(∗)))"))
  check("4. 下标是 Unicode", out.includes("x₀"))
  check("5. 巨型 display 公式整块降级", out.includes("D_(KL)") && out.includes("∑"))

  // WeChat gets plain text, so `stripMarkdown` has already unwrapped inline code
  // by this point: `` `$PATH` `` arrives as a bare `$PATH`. That is the correct
  // outcome and it pins the ordering — the degradation ran FIRST, while the
  // backticks were still there to protect the shell variables. Assert it
  // positively, then require that no span carrying LaTeX syntax survived.
  check("6a. shell 变量原样送达（降级早于 stripMarkdown 拆围栏，顺序正确）",
    out.includes("$PATH 与 $HOME"))
  const leftoverSpans = (out.match(/\$\$[\s\S]+?\$\$|\$(?!\$)[^\n$]+?\$/g) ?? [])
    .filter((s) => /[\\^_{}]/.test(s))
  check("6b. 没有含 LaTeX 语法的 span 残留", leftoverSpans.length === 0,
    JSON.stringify(leftoverSpans.slice(0, 3)))
  const leftoverCmds = out.match(/\\[a-zA-Z]+/g) ?? []
  check("7. 没有 \\command 残留", leftoverCmds.length === 0, JSON.stringify(leftoverCmds.slice(0, 5)))

  // WeChat is plain text: stripMarkdown ran too. Both the intraword `_` guard and
  // the `**bold**` stripping have to be intact in the compiled binary.
  check("8. stripMarkdown 已剥离强调（微信是纯文本）", !out.includes("**") && out.includes("接受该样本"))
  check("9. 降级产物里的 _(…) 没有被 stripMarkdown 吃掉", out.includes("D_(KL)"), "intraword 保护在编译产物中生效")
  // The mock answer's fenced python block carries `f"${x}"`; stripMarkdown unwraps
  // the fence but the text itself must survive both stages byte-for-byte.
  check("10. 代码块内容未被当公式吞掉", out.includes('f"${x}"'), 'expected f"${x}" verbatim')
  check("11. 正文完好", out.includes("拒绝采样是一种从复杂概率分布中生成样本的蒙特卡洛方法") && out.includes("以上。"))
} finally {
  ilink.stop(true)
  for (const p of procs) p.kill()
  rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.error("FAILED:\n" + failed.map(([n, , d]) => `  ✗ ${n} ${d}`).join("\n"))
  process.exit(1)
}
console.log("✅ 编译后 sidecar 黑盒验证全部通过")
