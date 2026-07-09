// builtin-shadow-ui.e2e.ts — end-to-end UI proof for builtin-vs-user skill
// shadowing (ADR-040 phase 2), driving the REAL React app (Chrome + Vite +
// real opencode). The two Tauri commands are shimmed onto a local helper HTTP
// server that performs REAL filesystem mutations mirroring the Rust reconcile
// (status from fs truth; remove = delete user dir + restore builtin copy), so
// every skills refetch after the restore goes through a REAL opencode scan.
//
//   1. builtin tab: /ppt-master renders the SHADOW card (overridden badge +
//      restore button), not a normal builtin card
//   2. custom tab lists the user copy (marker description)
//   3. installable tab: ppt-master shows "Installed" (user copy), a
//      non-installed catalog entry still shows "Install"
//   4. restore flow: confirm dialog → fs mutation → soft refresh → shadow card
//      gone, normal builtin card back (upstream description via real opencode)
//   5. installable tab now shows Install + the builtin self-update hint; click
//      prefills the Home composer with the `--method git` install prompt
//
// Run:  cd packages/client/desktop && bun run --bun e2e/builtin-shadow-ui.e2e.ts
// Needs: system Chrome (playwright-core channel:"chrome") + built opencode sidecar.
//        Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractBuiltinZip } from "./builtin-zip-helper"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const REPO = join(DESKTOP, "../../..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const SRC = join(REPO, "skills/builtin")
const BUN = process.execPath
const PW = "shadow-ui-pw"
const HELPER_PORT = 4977

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "shadow-ui-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({}))
const skillsRoot = join(tmp, ".config/ultrawork/skills")
const builtinPpt = join(skillsRoot, "builtin/ppt-master")
const userPpt = join(skillsRoot, "ppt-master")
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

const BUNDLED = ["skill-creator", "skill-installer", "pdf", "markdown-exporter", "doc-edit", "ppt-master", "feishu-assistant"]
const USER_MARKER = "USER-INSTALLED upstream latest raw copy."

// Post-reconcile shadowed state: full first-boot install from the real bundled
// skills-builtin.zip, then prune ppt-master — exactly the sequence the Rust
// side runs on an upgrade-while-shadowed (install → reconcile prunes).
const tExtract = Date.now()
const nExtracted = extractBuiltinZip(join(skillsRoot, "builtin"))
console.log(`[builtin-zip] extracted ${nExtracted} files in ${Date.now() - tExtract}ms`)
rmSync(builtinPpt, { recursive: true, force: true })
mkdirSync(userPpt, { recursive: true })
writeFileSync(join(userPpt, "SKILL.md"), `---\nname: ppt-master\ndescription: ${USER_MARKER}\n---\n# user copy\n`)

// Helper server = the "Rust side" of the shimmed Tauri commands, with REAL fs
// mutations (mirrors reconcile semantics; status computed from fs truth).
const CORS = { "Access-Control-Allow-Origin": "*", "content-type": "application/json" }
const helper = Bun.serve({
  port: HELPER_PORT,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/status") {
      const shadowed = existsSync(join(userPpt, "SKILL.md")) ? ["ppt-master"] : []
      // Steady-state reconcile: no disk mutation -> changed:false (a true value
      // here would loop the app's coordinated auto-refresh).
      return new Response(JSON.stringify({ bundled: BUNDLED, shadowed, changed: false }), { headers: CORS })
    }
    if (url.pathname === "/remove-override") {
      rmSync(userPpt, { recursive: true, force: true })
      // Mirrors reconcile's restore: prefix-selective extraction from the zip.
      extractBuiltinZip(builtinPpt, "ppt-master")
      return new Response(JSON.stringify({ bundled: BUNDLED, shadowed: [], changed: true }), { headers: CORS })
    }
    return new Response("nf", { status: 404, headers: CORS })
  },
})

const DEPS = [
  { name: "python3", available: true, path: "/usr/bin/python3" },
  { name: "node", available: true, path: "/usr/bin/node" },
  { name: "pandoc", available: true, path: "/usr/bin/pandoc" },
  { name: "soffice", available: true, path: "/usr/bin/soffice" },
  { name: "pdftoppm", available: true, path: "/usr/bin/pdftoppm" },
  { name: "git", available: true, path: "/usr/bin/git" },
  { name: "markdown-exporter", available: true, path: "/usr/bin/markdown-exporter" },
  { name: "python3.10+", available: true, path: "/usr/local/bin/python3" },
  { name: "python-pptx", available: true, path: "/usr/local/bin/python3" },
  { name: "lark-cli", available: true, path: "/usr/local/bin/lark-cli" },
]

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  if (!existsSync(join(SRC, "ppt-master/SKILL.md"))) throw new Error("skills/builtin/ppt-master missing — run fetch-builtin-skills.ts")

  console.log("=== start opencode + vite ===")
  spawn([OPENCODE, "serve", "--port", "4096"], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch("http://127.0.0.1:4096/global/health", { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + tauri-invoke shim (helper-backed shadow commands) ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  await page.addInitScript(({ ws, pw, deps, helperPort }) => {
    const helperBase = `http://127.0.0.1:${helperPort}`
    const handlers: Record<string, (a: any) => any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      check_skill_dependencies: () => deps,
      refresh_builtin_skills: async () => (await fetch(`${helperBase}/status`)).json(),
      remove_user_skill_override: async () => (await fetch(`${helperBase}/remove-override`)).json(),
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW, deps: DEPS, helperPort: HELPER_PORT })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)
  await page.getByText(/^(Skills|技能)$/).first().click()
  await page.waitForTimeout(1500)

  // 1. builtin tab: SHADOW card for ppt-master, no normal builtin card
  const shadowCard = page.locator("div.rounded-lg", { hasText: /Overridden by user install|已被用户安装版本覆盖/ }).first()
  await shadowCard.waitFor({ state: "visible", timeout: 15000 })
  const shadowText = (await shadowCard.innerText()).replace(/\s+/g, " ")
  if (!shadowText.includes("/ppt-master")) throw new Error(`shadow card is not about ppt-master: ${shadowText.slice(0, 160)}`)
  checks.push("builtin tab renders the shadow card (overridden badge) for /ppt-master ✓")
  // The permanent-shadow rule and the raw-upstream (unpatched) difference must
  // be surfaced to the user (ADR-040 阶段 2 requirement).
  if (!/(raw upstream|上游原版)/.test(shadowText) || !/(app updates|应用更新)/.test(shadowText))
    throw new Error(`shadow card copy lost the raw-upstream / permanent-shadow explanation: ${shadowText.slice(0, 240)}`)
  checks.push("shadow card explains raw-upstream difference + permanent-shadow rule ✓")
  const restoreBtn = shadowCard.getByRole("button", { name: /restore built-in|恢复内置/ })
  await restoreBtn.waitFor({ state: "visible", timeout: 5000 })
  checks.push("shadow card carries the restore button ✓")
  // The builtin tab must NOT also show a normal /ppt-master card (its live copy
  // is the user one → custom tab). Normal cards carry the source badge "skill".
  const builtinTabCards = await page.locator("div.rounded-lg", { hasText: "/ppt-master" }).count()
  if (builtinTabCards !== 1) throw new Error(`expected only the shadow card on the builtin tab, found ${builtinTabCards} /ppt-master cards`)
  checks.push("no duplicate normal builtin card for /ppt-master ✓")

  // 2. custom tab lists the user copy
  await page.getByRole("tab", { name: /Custom|自定义/ }).click()
  await page.waitForTimeout(800)
  const userCard = page.locator("div.rounded-lg", { hasText: "/ppt-master" }).first()
  await userCard.waitFor({ state: "visible", timeout: 10000 })
  if (!(await userCard.innerText()).includes("USER-INSTALLED")) throw new Error("custom tab card is not the user copy")
  checks.push("custom tab lists the user-installed copy (marker description, real GET /skill) ✓")

  // 3. installable tab: ppt-master Installed (user copy), mcp-builder Install
  await page.getByRole("tab", { name: /Recommended|推荐安装/ }).first().click()
  await page.waitForTimeout(800)
  const pptEntry = page.locator("div.rounded-lg", { hasText: "ppt-master" }).first()
  if (!/(Installed|已安装)/.test(await pptEntry.innerText())) throw new Error("catalog ppt-master not marked Installed while the user copy exists")
  checks.push("catalog marks ppt-master Installed while the USER copy exists ✓")
  const mcpEntry = page.locator("div.rounded-lg", { hasText: "mcp-builder" }).first()
  await mcpEntry.getByRole("button", { name: /Install|安装/ }).waitFor({ state: "visible", timeout: 5000 })
  checks.push("a non-installed catalog entry still offers Install ✓")

  // 4. restore flow: confirm dialog → real fs mutation → soft refresh → builtin back
  await page.getByRole("tab", { name: /Built-in|内置/ }).click()
  await page.waitForTimeout(500)
  await restoreBtn.click()
  const dialog = page.getByRole("dialog")
  await dialog.waitFor({ state: "visible", timeout: 5000 })
  if (!/(Restore the built-in skill|恢复内置技能)/.test(await dialog.innerText())) throw new Error("confirm dialog missing/wrong")
  checks.push("restore opens a confirm dialog (destructive delete guarded) ✓")
  await dialog.getByRole("button", { name: /restore built-in|恢复内置/ }).click()
  await page.waitForTimeout(2500)

  if (existsSync(userPpt)) throw new Error("user override dir still on disk after restore")
  if (!existsSync(join(builtinPpt, "SKILL.md"))) throw new Error("builtin copy not restored on disk")
  checks.push("confirm actually deletes the user dir and restores the builtin copy (fs truth) ✓")

  await page.locator("div.rounded-lg", { hasText: /Overridden by user install|已被用户安装版本覆盖/ }).first()
    .waitFor({ state: "hidden", timeout: 10000 }).catch(() => { throw new Error("shadow card did not disappear after restore") })
  const normalCard = page.locator("div.rounded-lg", { hasText: "/ppt-master" }).first()
  await normalCard.waitFor({ state: "visible", timeout: 10000 })
  const normalText = (await normalCard.innerText()).replace(/\s+/g, " ")
  if (normalText.includes("USER-INSTALLED")) throw new Error("builtin tab still shows the user description after restore")
  if (!/PPTX/i.test(normalText)) throw new Error(`restored card lost the upstream description: ${normalText.slice(0, 160)}`)
  checks.push("shadow card gone; normal builtin card back with the upstream description (real rescan) ✓")

  // 5. catalog back to Install + self-update hint; prompt mandates --method git
  await page.getByRole("tab", { name: /Recommended|推荐安装/ }).first().click()
  await page.waitForTimeout(800)
  const pptEntry2 = page.locator("div.rounded-lg", { hasText: "ppt-master" }).first()
  const entryText = await pptEntry2.innerText()
  if (/(Installed|已安装)/.test(entryText)) throw new Error("catalog still Installed after the user copy was removed")
  if (!/(self-update|内置该技能|built-in copy)/i.test(entryText)) throw new Error(`catalog entry lost the builtin self-update hint: ${entryText.slice(0, 200)}`)
  checks.push("catalog back to Install with the builtin self-update hint ✓")
  await pptEntry2.getByRole("button", { name: /Install|安装/ }).click()
  await page.waitForTimeout(1500)
  const composer = page.getByPlaceholder(/Ask anything|有什么可以帮到你/).first()
  await composer.waitFor({ state: "visible", timeout: 15000 })
  const prefilled = await composer.inputValue()
  if (!prefilled.includes("--method git")) throw new Error(`install prompt does not mandate --method git: "${prefilled.slice(0, 160)}"`)
  if (!prefilled.includes("hugohe3/ppt-master") || !prefilled.includes("skills/ppt-master"))
    throw new Error(`install prompt lost repo/path: "${prefilled.slice(0, 160)}"`)
  checks.push("catalog install hands off a prompt that mandates --method git (repo + path included) ✓")

  verdict = "PASS ✅ — real React UI renders the shadow state, guards the restore behind a confirm, restores the builtin (real fs + real opencode rescan), and the catalog entry round-trips Installed→Install with a --method git prompt."
} catch (e) {
  verdict = `FAIL ❌ — ${(e as Error).message}`
} finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  helper.stop(true)
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
