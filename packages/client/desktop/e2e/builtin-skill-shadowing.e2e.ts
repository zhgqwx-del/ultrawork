// builtin-skill-shadowing.e2e.ts — end-to-end proof of the deterministic
// builtin-vs-user same-name shadowing (ADR-040 phase 2, discussions/025 §5)
// against a REAL opencode binary.
//
// The Rust half (reconcile_builtin_shadowing: prune builtin copy when a user
// same-name skill exists, restore it from the bundle when removed) is covered
// by cargo tests. This script proves the OPENCODE half: the filesystem states
// that reconcile produces resolve deterministically in a real scan, live via
// soft refresh (ADR-039), no restart:
//   A. RACE DOCUMENTED — both copies on disk → GET /skill returns exactly ONE
//      "deckcraft" and the winner is arbitrary (logged, not asserted).
//   B. USER WINS AFTER PRUNE — remove builtin copy (what reconcile does) +
//      POST /global/refresh → the user version (marker description, location
//      under skills/deckcraft) is served immediately.
//   C. BUILTIN RETURNS AFTER RESTORE — remove user copy, put builtin back
//      (what reconcile's restore does) + POST /global/refresh → the builtin
//      version (upstream description, location under skills/builtin) is back.
//
//   cd packages/client/desktop && bun run --bun e2e/builtin-skill-shadowing.e2e.ts
//   Needs: built opencode sidecar binary. Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractBuiltinZip } from "./builtin-zip-helper"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const REPO = join(DESKTOP, "../../..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
// Real bundled SKILL.md (the rest of the deckcraft tree is irrelevant to discovery).
// deckcraft is a self-written builtin; the shadowing mechanism it exercises here is
// generic to every bundled skill (ppt-master, the former fixture, left the bundle in P3).
const REAL_SKILL_MD = join(REPO, "skills/builtin/deckcraft/SKILL.md")
const PW = "shadow-pw"
const OC = 4302

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 250)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "skill-shadow-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
const skillsRoot = join(tmp, ".config/ultrawork/skills")
const builtinDir = join(skillsRoot, "builtin/deckcraft")
const userDir = join(skillsRoot, "deckcraft")
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const WH = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const base = `http://127.0.0.1:${OC}`

const USER_MARKER = "USER-INSTALLED deckcraft override. 生成PPT via user copy."

function installBuiltin() {
  // What reconcile's restore does for real: prefix-selective extraction of the
  // whole deckcraft subtree from the bundled skills-builtin.zip.
  const t0 = Date.now()
  const n = extractBuiltinZip(builtinDir, "deckcraft")
  console.log(`[builtin-zip] restored deckcraft (${n} files) in ${Date.now() - t0}ms`)
}
function installUser() {
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, "SKILL.md"), `---\nname: deckcraft\ndescription: ${USER_MARKER}\n---\n# user copy\n`)
}

async function getDeckcraft(): Promise<{ entries: number; location: string; description: string }> {
  const skills = await (await fetch(`${base}/skill`, { headers: WH })).json() as any[]
  const hits = (Array.isArray(skills) ? skills : []).filter((s) => s?.name === "deckcraft")
  return {
    entries: hits.length,
    location: String(hits[0]?.location ?? ""),
    description: String(hits[0]?.description ?? ""),
  }
}
async function softRefresh() {
  const r = await fetch(`${base}/global/refresh`, { method: "POST", headers: { authorization: auth } })
  if (!r.ok) throw new Error(`POST /global/refresh failed ${r.status}`)
}

const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  if (!existsSync(REAL_SKILL_MD)) throw new Error(`missing ${REAL_SKILL_MD} — run fetch-builtin-skills.ts first`)

  // A. both copies on disk — the exact state reconcile exists to prevent
  installBuiltin()
  installUser()
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode health", async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)

  const race = await getDeckcraft()
  if (race.entries !== 1) throw new Error(`expected the duplicate-name registry to hold ONE entry, got ${race.entries}`)
  const raceWinner = race.location.includes(join("skills", "builtin")) ? "builtin" : "user"
  checks.push(`A. duplicate names collapse to one arbitrary winner (this run: ${raceWinner}) — the race reconcile prevents ✓`)

  // B. prune (what reconcile does when the user copy exists) → user wins, live
  rmSync(builtinDir, { recursive: true, force: true })
  await softRefresh()
  const afterPrune = await getDeckcraft()
  if (afterPrune.entries !== 1) throw new Error(`after prune expected 1 entry, got ${afterPrune.entries}`)
  if (afterPrune.location.includes(join("skills", "builtin"))) throw new Error(`after prune location still builtin: ${afterPrune.location}`)
  if (!afterPrune.description.includes("USER-INSTALLED")) throw new Error(`after prune description is not the user copy: ${afterPrune.description.slice(0, 120)}`)
  checks.push("B. builtin pruned → soft refresh → USER version served (location + marker description), no restart ✓")

  // C. restore (user removed, builtin recopied from bundle) → builtin returns, live
  rmSync(userDir, { recursive: true, force: true })
  installBuiltin()
  await softRefresh()
  const afterRestore = await getDeckcraft()
  if (afterRestore.entries !== 1) throw new Error(`after restore expected 1 entry, got ${afterRestore.entries}`)
  if (!afterRestore.location.includes(join("skills", "builtin"))) throw new Error(`after restore location not builtin: ${afterRestore.location}`)
  if (afterRestore.description.includes("USER-INSTALLED") || !afterRestore.description.includes("生成PPT")) {
    throw new Error(`after restore description is not the upstream builtin: ${afterRestore.description.slice(0, 120)}`)
  }
  checks.push("C. user copy removed + builtin restored → soft refresh → BUILTIN version served again ✓")

  verdict = "PASS ✅ — real opencode confirms: duplicate names race to one arbitrary winner; after prune the user copy deterministically wins; after restore the builtin returns — both live via POST /global/refresh."
} catch (e) {
  verdict = `FAIL ❌ — ${(e as Error).message}`
} finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
