// add-source-auth.e2e.ts — the "add knowledge source" dialog against a REAL,
// auth-protected knowledge sidecar, driven through a real browser.
//
// Why this exists: `add-source-dialog.tsx` used to carry its own private `kbFetch`
// with a hardcoded `http://localhost:4098/kb` and no Authorization header. When the
// sidecar's port went dynamic and its routes required Basic auth (ADR-045), only
// `use-knowledge-base.ts` was migrated — so every add-source flow 401'd. A static
// sweep missed it (the dialog is not a consumer of the hook, it built its own
// client), and no browser test drove the dialog. This is that test.
//
// It asserts on the WIRE, not on a mock:
//   1. the sidecar really rejects an unauthenticated /kb/sources (else 3. is vacuous)
//   2. clicking "Test Connection" sends POST /kb/sources WITH an Authorization header
//   3. ...and the sidecar answers 2xx, not 401
//   4. the dialog never surfaces a "KB 401" error to the user
//
//   cd packages/client/desktop && bun run --bun e2e:add-source-auth   # exit 0 = PASS
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const KB_SIDECAR = join(DESKTOP, "src-tauri/binaries", `knowledge-sidecar-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "add-source-pw"
const KB = 4098

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60_000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try {
      if (await fn()) {
        console.log(`[ready] ${label}`)
        return
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timeout ${label}`)
}

const checks: string[] = []
const ok = (m: string) => {
  checks.push(m)
  console.log(`  ✓ ${m}`)
}

const tmp = mkdtempSync(join(tmpdir(), "add-source-"))
const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
let verdict = "INCOMPLETE"

try {
  console.log("=== boot the real knowledge-sidecar (Basic auth ON) + vite ===")
  spawn([KB_SIDECAR], { ...env, ULTRAWORK_SIDECAR_PASSWORD: PW })
  await poll("kb-sidecar", async () => (await fetch(`http://127.0.0.1:${KB}/kb/health`, { headers: { authorization: auth } })).ok)

  // Preflight: without this, assertion 3 could pass against a sidecar that has no auth.
  const anon = await fetch(`http://127.0.0.1:${KB}/kb/sources`)
  if (anon.status !== 401) throw new Error(`sidecar answered ${anon.status} to an anonymous /kb/sources, expected 401`)
  ok("sidecar rejects an unauthenticated /kb/sources with 401 (so the rest is not vacuous)")

  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("\n=== chrome + tauri-invoke shim (host hands the renderer its credential) ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  await page.addInitScript(
    ({ ws, pw }) => {
      const handlers: Record<string, (a: any) => any> = {
        check_directory_exists: () => true,
        ensure_default_workspace: () => ws,
        login_shell_path: () => "",
        scan_workspace_changes: () => [],
        read_mcp_config: () => ({}),
        write_mcp_config: () => null,
        get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      }
      // @ts-ignore
      window.__TAURI_INTERNALS__ = {
        invoke: async (c: string, a: any) => (handlers[c] ? handlers[c](a) : null),
        transformCallback: (cb: any) => cb,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      }
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
      localStorage.setItem("workspace_path", ws)
    },
    { ws, pw: PW },
  )

  // Watch the wire: every POST the page makes to /kb/sources.
  const posts: { auth: string | undefined; status: number }[] = []
  page.on("response", async (res) => {
    const req = res.request()
    if (req.method() === "POST" && new URL(res.url()).pathname === "/kb/sources") {
      posts.push({ auth: (await req.allHeaders()).authorization, status: res.status() })
    }
  })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)
  await page.getByRole("button", { name: /知识库|Knowledge/i }).first().click()
  await page.waitForTimeout(800)

  console.log("\n=== drive the dialog: Add Source → IMA → Test Connection ===")
  await page.getByRole("button", { name: /添加知识源|Add Source/i }).first().click()
  await page.getByText(/腾讯 IMA|IMA/i).first().click()
  const inputs = page.locator("input")
  await inputs.nth(0).fill("test-client-id")
  await inputs.nth(1).fill("test-api-key")
  await page.getByRole("button", { name: /测试连接|Test Connection/i }).first().click()

  // The dialog's first call is POST /kb/sources (it creates a temp source to probe with).
  await poll("dialog issued POST /kb/sources", async () => posts.length > 0, 20_000)

  const first = posts[0]
  if (!first.auth) throw new Error("the dialog sent POST /kb/sources with NO Authorization header")
  if (first.auth !== auth) throw new Error(`wrong Authorization header: ${first.auth}`)
  ok("the dialog's POST /kb/sources carries the host-issued Authorization header")

  if (first.status === 401) throw new Error("the sidecar 401'd the dialog's POST /kb/sources")
  if (first.status >= 400) throw new Error(`the sidecar answered ${first.status} to the dialog's POST /kb/sources`)
  ok(`the sidecar accepted it (HTTP ${first.status}) — the source was really created`)

  // Whatever the IMA credentials do (they are fake, so the probe fails upstream), the
  // user must never see the auth failure this test exists to prevent.
  await page.waitForTimeout(2500)
  const body = await page.locator("body").innerText()
  if (/KB 401|401/.test(body)) throw new Error(`the dialog surfaced a 401 to the user:\n${body.slice(0, 400)}`)
  ok("the dialog never surfaces a 401 to the user")

  verdict = `PASS ✅ — ${checks.length} assertions, add-source reaches the authenticated sidecar`
} catch (e) {
  verdict = `FAIL ❌ — ${(e as Error).message}`
} finally {
  console.log(`\n=== VERDICT: ${verdict} ===`)
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) {
    try {
      p.kill()
    } catch {}
  }
  rmSync(tmp, { recursive: true, force: true })
  process.exitCode = verdict.startsWith("PASS") ? 0 : 1
}
