// websearch-ui-walkthrough.e2e.ts — real-browser UI proof for ADR-042: drives the
// REAL React app (Chrome + Vite + real patched opencode) through the whole
// Settings → 工具 flow and the models-section per-model web-search toggle,
// asserting DISK truth (auth.json / global opencode.json) after every step —
// i.e. the UI → api-client → opencode chain works through real React, not mocks.
//
// The Tauri `test_search_provider` command is shimmed to a browser fetch against
// the SAME in-process stub the Rust curl would hit (CORS-enabled), classifying
// exactly like classify_provider_status — so the test-connection flow exercises
// a real HTTP round-trip with the entered key.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/websearch-ui-walkthrough.e2e.ts
// Needs: system Chrome + built sidecar binaries. Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "ws-ui-pw"
const STUB = 8095
const TAVILY_KEY = "tvly-ui-good"
const IQS_KEY = "iqs-ui-good"

// ---------- in-process stub Tavily/IQS with CORS (browser shim fetches it) ----------
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
}
Bun.serve({
  port: STUB,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
    const url = new URL(req.url)
    const auth = req.headers.get("authorization")
    const okKey = url.pathname === "/search" ? `Bearer ${TAVILY_KEY}` : `Bearer ${IQS_KEY}`
    if (auth !== okKey) return new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401, headers: CORS })
    return new Response(JSON.stringify({ results: [], pageItems: [] }), { status: 200, headers: { ...CORS, "content-type": "application/json" } })
  },
})

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "ws-ui-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const cfgPath = join(tmp, ".config/ultrawork/opencode.json")
const authPath = join(tmp, ".local/share/ultrawork/auth.json")
// Seed a DashScope-like custom provider so the models-section toggle flow is
// exercisable (isDashScopeLike matches the baseURL host).
const DS_PID = "my-dashscope"
writeFileSync(cfgPath, JSON.stringify({
  provider: {
    [DS_PID]: {
      name: "My DashScope",
      npm: "@ai-sdk/openai-compatible",
      api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      options: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      models: { "qwen-max": { id: "qwen-max", name: "Qwen Max", tool_call: true } },
      whitelist: ["qwen-max"],
    },
  },
}))
mkdirSync(join(tmp, ".local/share/ultrawork"), { recursive: true })
writeFileSync(authPath, JSON.stringify({ [DS_PID]: { type: "api", key: "sk-seed" } }))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

const readCfg = () => JSON.parse(readFileSync(cfgPath, "utf8"))
const readAuth = () => { try { return JSON.parse(readFileSync(authPath, "utf8")) } catch { return {} } }

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  console.log("=== start opencode + vite ===")
  spawn([OPENCODE, "serve", "--port", "4096"], {
    ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork",
    ULTRAWORK_TAVILY_BASE_URL: `http://127.0.0.1:${STUB}`, ULTRAWORK_ALIYUN_IQS_BASE_URL: `http://127.0.0.1:${STUB}`,
  })
  await poll("opencode", async () => (await fetch("http://127.0.0.1:4096/global/health", { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + tauri-invoke shim (test_search_provider → real stub round-trip) ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.addInitScript(({ ws, pw, stub }) => {
    const handlers: Record<string, (a: any) => any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      // Mirrors the Rust command: minimal POST with the entered key, classified
      // like classify_provider_status. Real HTTP against the CORS-enabled stub.
      test_search_provider: async ({ provider, apiKey }: { provider: string; apiKey: string }) => {
        const path = provider === "tavily" ? "/search" : "/search/unified"
        try {
          const r = await fetch(`${stub}${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: "{}",
          })
          return { ok: r.ok, status: r.status, message: r.ok ? "ok" : r.status === 401 || r.status === 403 ? "auth" : "http" }
        } catch {
          return { ok: false, status: 0, message: "network" }
        }
      },
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW, stub: `http://127.0.0.1:${STUB}` })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)

  console.log("=== 1. navigate Settings → Tools ===")
  await page.getByText(/^(Tools|工具)$/).first().click()
  await page.getByText(/^(Web Search|联网搜索)$/).first().waitFor({ timeout: 10000 })
  const notChips = await page.getByText(/Not configured|未配置/).count()
  if (notChips !== 2) throw new Error(`expected 2 not-configured chips, got ${notChips}`)
  checks.push("Tools section renders: two provider cards, both not-configured ✓")

  console.log("=== 2. test button disabled without key; get-key link present ===")
  const testBtns = page.getByRole("button", { name: /^(Test|测试连接)$/ })
  if (!(await testBtns.first().isDisabled())) throw new Error("test button enabled without a key")
  if ((await page.getByRole("button", { name: /Get API Key|获取 API Key/ }).count()) !== 2)
    throw new Error("expected 2 get-key links")
  checks.push("test disabled without key + 2 console links ✓")

  console.log("=== 3. wrong Tavily key → auth error toast (with tvly hint) ===")
  const tavilyInput = page.locator('input[type="password"]').first()
  await tavilyInput.fill("tvly-wrong")
  await testBtns.first().click()
  await page.getByText(/Authentication failed|认证失败/).first().waitFor({ timeout: 8000 })
  checks.push("wrong key → auth-failure toast via real stub 401 round-trip ✓")

  console.log("=== 4. correct Tavily key → test OK → save → configured chip + auth.json on disk ===")
  await tavilyInput.fill(TAVILY_KEY)
  await testBtns.first().click()
  await page.getByText(/Connection OK|连接成功/).first().waitFor({ timeout: 8000 })
  await page.getByRole("button", { name: /^(Save Changes|保存更改)$/ }).first().click()
  await poll("search-tavily lands in auth.json", async () => readAuth()["search-tavily"]?.key === TAVILY_KEY, 10000)
  await page.getByText(/^(Configured|已配置)$/).first().waitFor({ timeout: 5000 })
  if ((await tavilyInput.inputValue()) !== "") throw new Error("key input not cleared after save")
  await page.getByText(/^(Active|已生效)$/).first().waitFor({ timeout: 5000 })
  checks.push("save → auth.json disk truth + configured/active chips + input cleared ✓")

  console.log("=== 5. IQS key save ===")
  const iqsInput = page.locator('input[type="password"]').nth(1)
  await iqsInput.fill(IQS_KEY)
  await page.getByRole("button", { name: /^(Save Changes|保存更改)$/ }).nth(1).click()
  await poll("search-aliyun-iqs lands in auth.json", async () => readAuth()["search-aliyun-iqs"]?.key === IQS_KEY, 10000)
  checks.push("IQS key save → auth.json ✓")

  console.log("=== 6. default provider select offers auto + both configured ===")
  await page.locator('[role="combobox"]').first().click()
  await page.getByRole("option", { name: /Auto|自动/ }).waitFor({ timeout: 5000 })
  const optionTexts = await page.getByRole("option").allTextContents()
  console.log("  select options:", JSON.stringify(optionTexts))
  const hasTavily = optionTexts.some((t) => t.includes("Tavily"))
  const hasIqs = optionTexts.some((t) => /Aliyun IQS|阿里云 IQS/.test(t))
  if (!hasTavily || !hasIqs) throw new Error(`select options missing: tavily=${hasTavily} iqs=${hasIqs} (${JSON.stringify(optionTexts)})`)
  await page.getByRole("option", { name: /Aliyun IQS|阿里云 IQS/ }).click()
  await poll("provider=aliyun-iqs persisted", async () => readCfg().experimental?.websearch?.provider === "aliyun-iqs", 10000)
  checks.push("default-provider select → experimental.websearch.provider on disk ✓")

  console.log("=== 7. advanced fold → exa opt-in persisted ===")
  await page.getByRole("button", { name: /^(Advanced|高级)$/ }).click()
  await page.getByRole("checkbox", { name: /Exa/ }).check()
  await poll("exa=true persisted", async () => readCfg().experimental?.websearch?.exa === true, 10000)
  checks.push("exa advanced opt-in → disk ✓")

  console.log("=== 8. master toggle off → enabled:false on disk, Active chip gone ===")
  await page.getByRole("checkbox", { name: /^(Enable|启用)$/ }).uncheck()
  await poll("enabled=false persisted", async () => readCfg().experimental?.websearch?.enabled === false, 10000)
  if ((await page.getByText(/^(Active|已生效)$/).count()) !== 0) throw new Error("Active chip still visible while disabled")
  await page.getByRole("checkbox", { name: /^(Enable|启用)$/ }).check()
  await poll("enabled=true persisted", async () => readCfg().experimental?.websearch?.enabled === true, 10000)
  checks.push("master enable toggle round-trip → disk + Active chip ✓")

  console.log("=== 9. remove Tavily key (two-step confirm) → auth.json cleaned + provider reset to auto ===")
  // deleting the PREFERRED provider is the interesting path — set tavily first
  await page.locator('[role="combobox"]').first().click()
  await page.getByRole("option", { name: "Tavily", exact: true }).click()
  await poll("provider=tavily persisted", async () => readCfg().experimental?.websearch?.provider === "tavily", 10000)
  await page.getByRole("button", { name: /Remove key|删除 Key/ }).first().click()
  await page.getByRole("button", { name: /Confirm remove|确认删除/ }).click()
  await poll("search-tavily removed from auth.json", async () => !readAuth()["search-tavily"], 10000)
  await poll("preferred provider reset to auto", async () => readCfg().experimental?.websearch?.provider === "auto", 10000)
  checks.push("remove key (confirm flow) → auth.json cleaned + stale preferred reset to auto ✓")

  console.log("=== 10. models-section: DashScope-like provider shows per-model web-search toggle ===")
  await page.getByText(/^(Models|模型)$/).first().click()
  await page.getByText("My DashScope").first().waitFor({ timeout: 10000 })
  await page.getByText("My DashScope").first().click() // expand
  const toggle = page.getByRole("checkbox", { name: /qwen-max/ })
  await toggle.waitFor({ timeout: 5000 })
  await toggle.check()
  await poll("enable_search=true persisted for qwen-max", async () =>
    readCfg().provider?.[DS_PID]?.models?.["qwen-max"]?.options?.enable_search === true, 10000)
  await toggle.uncheck()
  await poll("enable_search=false (explicit) persisted", async () =>
    readCfg().provider?.[DS_PID]?.models?.["qwen-max"]?.options?.enable_search === false, 10000)
  checks.push("models-section toggle → global config enable_search true→false round-trip on disk ✓")

  if (errors.length) console.log(`  (note: ${errors.length} console errors; first: ${errors[0]?.slice(0, 160)})`)
  verdict = "PASS ✅ — real React UI drives the full BYOK websearch settings + per-model toggle flows with disk-truth assertions at every step."
} catch (e) {
  verdict = `FAIL ❌ — ${(e as Error).message}`
} finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
