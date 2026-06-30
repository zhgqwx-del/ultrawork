// skill-soft-refresh.e2e.ts — proves ADR-039's soft-refresh covers SKILLS against a
// REAL opencode binary: a skill file dropped into the global skills dir is invisible
// to a running server (opencode caches the skill list with NO file watcher), but
// becomes visible IMMEDIATELY after `POST /global/refresh` — no restart, no dispose.
//
// This is what makes use-skills' `refresh` (refreshGlobalConfig + re-fetch) actually
// surface a newly installed skill.
//
// Flow (pure HTTP, real opencode, isolated env, single process — NO restart):
//   1. boot opencode → GET /skill has no e2e skill (baseline)
//   2. write a new SKILL.md under ~/.config/ultrawork/skills/<name>/
//   3. GET /skill STILL has no e2e skill (cached, no watcher)            [proves the gap]
//   4. POST /global/refresh
//   5. GET /skill now shows the e2e skill immediately                    [proves the fix]
//
//   cd packages/client/desktop && bun run --bun e2e/skill-soft-refresh.e2e.ts
//   Needs: built opencode sidecar binary. Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const PW = "skill-refresh-pw"
const OC = 4299
const SKILL = "e2e-soft-skill"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 250)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "skill-refresh-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
const skillsDir = join(tmp, ".config/ultrawork/skills", SKILL)
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const WH = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const base = `http://127.0.0.1:${OC}`
const hasSkill = async (): Promise<boolean> => {
  const skills = await (await fetch(`${base}/skill`, { headers: WH })).json() as any[]
  return Array.isArray(skills) && skills.some((s) => s?.name === SKILL)
}

const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode health", async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)

  // 1. baseline — prime the skill cache (first GET builds it)
  if (await hasSkill()) throw new Error("baseline already has the e2e skill")
  checks.push("boot: GET /skill has no e2e skill (cache primed) ✓")

  // 2. drop a new SKILL.md on disk
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(join(skillsDir, "SKILL.md"), `---\nname: ${SKILL}\ndescription: An e2e soft-refresh skill\n---\n\n# ${SKILL}\n\nDropped on disk after boot.\n`)
  checks.push("dropped a new SKILL.md under ~/.config/ultrawork/skills/ ✓")

  // 3. still invisible — proves the cache gap (no file watcher)
  if (await hasSkill()) throw new Error("skill appeared WITHOUT a refresh — cache assumption wrong (test would be vacuous)")
  checks.push("GET /skill STILL has no e2e skill (cached, no watcher) — the gap soft-refresh fixes ✓")

  // 4. soft refresh
  const r = await fetch(`${base}/global/refresh`, { method: "POST", headers: { authorization: auth } })
  if (!r.ok) throw new Error(`POST /global/refresh failed ${r.status}`)
  checks.push("POST /global/refresh accepted ✓")

  // 5. now visible immediately, no restart
  if (!(await hasSkill())) throw new Error("skill NOT visible after POST /global/refresh — soft refresh did not evict the skill cache")
  checks.push("GET /skill shows the new skill IMMEDIATELY after refresh — no restart ✓")

  verdict = "PASS ✅ — a skill dropped on disk is cached-invisible until POST /global/refresh, then visible immediately (no restart)"
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
