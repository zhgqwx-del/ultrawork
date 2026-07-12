// channel-session-rotation.e2e.ts — idle rotation + /resume + the sidebar's session
// registry, against a REAL opencode and a REAL on-disk session-map (ADR-051).
//
// The unit tests mock opencode and stub the disk, so they can't catch: a session
// that opencode refuses to create, a store that doesn't survive a gateway restart,
// a rotation that mints a session the next prompt can't actually reach, or a
// /channel/sessions endpoint the desktop can't parse. That's what this covers.
//
// Flow (real opencode + mock-llm; only the IM adapter is a stub):
//   1. msg → assert a REAL opencode session is created and prompted
//   2. assert ~/.ultrawork/session-map.json exists on disk, v2, with our entry
//   3. restart the Bridge → assert the mapping survives (same session reused)
//   4. wait past the idle threshold → next msg rotates: NEW real session,
//      user is TOLD, prevSessionId remembers the old one
//   5. the rotated-to session is real: the prompt lands and opencode answers
//   6. /resume → swaps back, and the next prompt reaches the OLD session
//   7. GET /channel/sessions (real gateway HTTP, Basic auth) → the desktop's view
//
//   cd packages/client/desktop && bun run --bun e2e:channel-rotation   # exit 0 = PASS
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const BUN = process.execPath
const OPENCODE = join(HERE, "..", "src-tauri", "binaries", "opencode-server-aarch64-apple-darwin")
const PW = "chanrot-pw"
const OC = 4296 // off the standard 4096 so a running dev app doesn't collide
const LLM = 4297
const GW = 4298

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

// `os.homedir()` resolves ONCE at process start and ignores later writes to
// process.env.HOME (verified on Bun). The Bridge's SessionStore defaults to
// `~/.ultrawork/session-map.json` — a real file — so the redirect has to be in
// place BEFORE this process starts. Hence: parent sets up a temp HOME and re-execs
// this same script into it; the child does the actual testing.
//
// This is not hypothetical. The unit suite originally tried to redirect HOME with
// vi.stubEnv at runtime, it silently did nothing, and the tests overwrote the
// developer's live session map. The guard below is the fail-closed version of that
// lesson: if HOME did not take, refuse to run rather than write the real file.
const CHILD = process.env.CHANROT_TMP

if (!CHILD) {
  const parentTmp = mkdtempSync(join(tmpdir(), "chanrot-"))
  const child = Bun.spawn([BUN, "run", import.meta.path], {
    env: {
      ...process.env,
      HOME: parentTmp,
      USERPROFILE: parentTmp, // windows
      CHANROT_TMP: parentTmp,
      XDG_CONFIG_HOME: join(parentTmp, ".config"),
      XDG_DATA_HOME: join(parentTmp, ".local/share"),
      OPENCODE_SERVER_PASSWORD: PW,
      OPENCODE_BASE_URL: `http://127.0.0.1:${OC}`,
      ULTRAWORK_CHANNEL_IDLE_ROTATE_MS: "3000", // 3s, so this doesn't take an hour
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
  console.error(
    `FATAL: HOME redirect failed (homedir()=${homedir()}, expected ${tmp}).\n` +
      `Refusing to run — this would read and overwrite the REAL ~/.ultrawork/session-map.json.`,
  )
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
}
const STORE = join(tmp, ".ultrawork", "session-map.json")

try {
  // --- real sidecars -------------------------------------------------------
  spawn([BUN, "run", join(HERE, "mock-llm.ts")], { MOCK_LLM_PORT: String(LLM) })
  await poll(async () => (await fetch(`${llmBase}/models`)).ok)

  spawn([OPENCODE, "serve", "--hostname", "127.0.0.1", "--port", String(OC)], env)
  const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
  await poll(async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)

  // Bridge runs in-process so we can drive it with synthetic IM messages; every
  // dependency it touches (opencode, the LLM, the disk) is real.
  const { Bridge } = await import("../../../channel/gateway/src/bridge.js")
  const { createApp } = await import("../../../channel/gateway/src/gateway-server.js")

  const replies: string[] = []
  const msg = (text: string, over: Record<string, unknown> = {}) => ({
    chatId: "u-1",
    senderId: "s-1",
    senderName: "张三",
    channelType: "dingtalk",
    text,
    workspaceDir: ws,
    raw: {},
    reply: async (c: string) => { replies.push(c) },
    ...over,
  }) as any

  const sessionsOf = async (b: any): Promise<any[]> => b.listChannelSessions()

  /**
   * Wait for the turn to actually finish. Rotation deliberately refuses to fire
   * while a turn is in flight (the in-flight guardrail), so "send, sleep, send"
   * would test nothing — as the first run of this harness proved by failing here.
   * The real shape is: agent answers → user goes away → user comes back.
   */
  const waitIdle = (b: any) => poll(async () => b.activeContexts.size === 0, 30000)

  // --- 1. first message creates a REAL opencode session --------------------
  let bridge = new Bridge()
  await bridge.init()
  await bridge.handleMessage(msg("第一个任务"))

  let entries = await sessionsOf(bridge)
  const first = entries[0]?.sessionId
  check("1. real opencode session created", !!first && first.startsWith("ses"), first)

  const ocSession = await fetch(`http://127.0.0.1:${OC}/session/${first}`, {
    headers: { authorization: auth, "x-opencode-directory": ws },
  })
  check("1b. opencode really has that session", ocSession.ok, `GET /session/${first} → ${ocSession.status}`)

  // --- 2. store hit the real disk ------------------------------------------
  await new Promise((r) => setTimeout(r, 300)) // persist is fire-and-forget
  const onDisk = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf-8")) : null
  check("2. session-map.json written to disk", !!onDisk, STORE)
  check("2b. v2 schema, namespaced key", onDisk?.version === 2 && !!onDisk?.entries?.["dingtalk:u-1"],
    Object.keys(onDisk?.entries ?? {}).join(","))
  check("2c. carries the metadata the sidebar needs",
    onDisk?.entries?.["dingtalk:u-1"]?.channelType === "dingtalk" &&
    onDisk?.entries?.["dingtalk:u-1"]?.senderName === "张三" &&
    typeof onDisk?.entries?.["dingtalk:u-1"]?.lastActiveAt === "number")

  // --- 3. mapping survives a gateway restart -------------------------------
  await bridge.shutdown()
  bridge = new Bridge()
  await bridge.init()
  await bridge.handleMessage(msg("接着上面的"))
  entries = await sessionsOf(bridge)
  check("3. mapping survives gateway restart", entries[0]?.sessionId === first,
    `${entries[0]?.sessionId} vs ${first}`)

  // --- 4. rotate after idle ------------------------------------------------
  await waitIdle(bridge) // the turn must END before the idle clock means anything
  replies.length = 0
  await new Promise((r) => setTimeout(r, 3500)) // now go past the 3s threshold
  await bridge.handleMessage(msg("改一下刚才那个方案"))

  entries = await sessionsOf(bridge)
  const second = entries[0]?.sessionId
  check("4. rotated to a NEW session", !!second && second !== first, `${first} → ${second}`)
  check("4b. user was TOLD the context was cut",
    replies.some((r) => r.includes("新会话") && r.includes("/resume")),
    JSON.stringify(replies.filter((r) => r.includes("新会话"))))
  check("4c. old session remembered for /resume", entries[0]?.prevSessionId === first)

  // --- 5. the rotated-to session is REAL and reachable ----------------------
  const ocSecond = await fetch(`http://127.0.0.1:${OC}/session/${second}`, {
    headers: { authorization: auth, "x-opencode-directory": ws },
  })
  check("5. rotated-to session exists in opencode", ocSecond.ok, `→ ${ocSecond.status}`)
  const msgs = await (await fetch(`http://127.0.0.1:${OC}/session/${second}/message`, {
    headers: { authorization: auth, "x-opencode-directory": ws },
  })).json() as any[]
  check("5b. the prompt actually landed in it", msgs.length > 0, `${msgs.length} messages`)

  // --- 6. /resume swaps back, and the next prompt reaches the OLD session ---
  await waitIdle(bridge)
  replies.length = 0
  await bridge.handleMessage(msg("/resume"))
  entries = await sessionsOf(bridge)
  check("6. /resume swapped back", entries[0]?.sessionId === first, `now on ${entries[0]?.sessionId}`)
  check("6b. symmetric — can toggle back", entries[0]?.prevSessionId === second)

  const beforeCount = ((await (await fetch(`http://127.0.0.1:${OC}/session/${first}/message`, {
    headers: { authorization: auth, "x-opencode-directory": ws },
  })).json()) as any[]).length
  await bridge.handleMessage(msg("这条要落到老会话"))
  await poll(async () => {
    const after = (await (await fetch(`http://127.0.0.1:${OC}/session/${first}/message`, {
      headers: { authorization: auth, "x-opencode-directory": ws },
    })).json()) as any[]
    return after.length > beforeCount
  }, 20000)
  check("6c. next prompt really reached the resumed session", true, `${first} grew past ${beforeCount} messages`)

  // --- 7. the endpoint the desktop sidebar reads ---------------------------
  const app = createApp({ listStatus: () => [], listConfigs: () => [] } as any, undefined, null, bridge)
  const server = Bun.serve({ hostname: "127.0.0.1", port: GW, fetch: (r) => app.fetch(r) })
  const listed = await (await fetch(`http://127.0.0.1:${GW}/channel/sessions`)).json() as any
  server.stop(true)
  check("7. GET /channel/sessions serves the sidebar's registry",
    Array.isArray(listed?.sessions) && listed.sessions[0]?.channelType === "dingtalk" &&
    listed.sessions[0]?.senderName === "张三",
    JSON.stringify(listed?.sessions?.[0] ?? {}))

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
console.log("PASS")
