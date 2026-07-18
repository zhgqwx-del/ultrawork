// builtin-deckcraft.e2e.ts — proves the bundled deckcraft skill is discovered by a
// REAL opencode binary from the builtin skills dir, exactly as it lands after
// ensure_builtin_skills copies bundle resources on first boot. deckcraft is the
// default "make a PPT" skill (ppt-master was removed from the bundle in P3, ADR-061 /
// discussions/043 §18.5 — it survives only as a curated INSTALLABLE_SKILLS entry).
//
// Flow (pure HTTP, real opencode, isolated env):
//   1. extract deckcraft from the REAL bundled skills-builtin.zip →
//      <tmp>/.config/ultrawork/skills/builtin/ (the same artifact + extraction
//      semantics as the Rust first-boot installer; ms figure printed)
//   2. boot opencode (OPENCODE_APP_NAME=ultrawork) → GET /skill lists deckcraft,
//      location points into skills/builtin/, description carries the trigger words
//   3. self-containment smoke: run a bundled stdlib-only script (fetch_assets.py --help)
//      from the COPIED location — proves scripts work outside the upstream repo layout
//
//   cd packages/client/desktop && bun run --bun e2e/builtin-deckcraft.e2e.ts
//   Needs: built opencode sidecar binary + python3 on PATH. Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractBuiltinZip } from "./builtin-zip-helper"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const REPO = join(DESKTOP, "../../..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const SRC = join(REPO, "skills/builtin/deckcraft")
const PW = "deck-builtin-pw"
const OC = 4301

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 250)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "deck-builtin-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
const builtinDir = join(tmp, ".config/ultrawork/skills/builtin")
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const WH = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const base = `http://127.0.0.1:${OC}`

const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  if (!existsSync(SRC)) throw new Error(`missing ${SRC} — run scripts/fetch-builtin-skills.ts first`)

  // 1. the Rust first-boot install path: extract from the real bundled zip
  //    (prefix-selective, same semantics as extract_builtin_zip; measured)
  const t0 = Date.now()
  const nFiles = extractBuiltinZip(join(builtinDir, "deckcraft"), "deckcraft")
  const copyMs = Date.now() - t0
  checks.push(`extracted deckcraft (${nFiles} files) from skills-builtin.zip into config dir in ${copyMs}ms ✓`)

  // 2. real opencode discovers it
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode health", async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)

  const skills = await (await fetch(`${base}/skill`, { headers: WH })).json() as any[]
  const deck = Array.isArray(skills) ? skills.find((s) => s?.name === "deckcraft") : undefined
  if (!deck) throw new Error(`GET /skill does not list deckcraft (got: ${skills?.map((s: any) => s?.name).join(", ")})`)
  checks.push("GET /skill lists deckcraft ✓")
  if (!String(deck.location ?? "").includes(join("skills", "builtin", "deckcraft"))) {
    throw new Error(`location not under skills/builtin: ${deck.location}`)
  }
  checks.push(`location under skills/builtin (${deck.location}) ✓`)
  const desc = String(deck.description ?? "")
  if (!desc.includes("生成PPT") || !desc.toLowerCase().includes("pptx")) {
    throw new Error(`description lost trigger words: ${desc.slice(0, 120)}`)
  }
  checks.push("description carries 生成PPT / PPTX trigger words ✓")

  // 3. bundled script runs from the copied location (stdlib-only entry).
  //    deckcraft hard-requires Python >= 3.10 (its source_to_md converters use
  //    module-level `X | None` unions) — exactly what the python3.10+ dep badge
  //    gates. Find a suitable interpreter; on a 3.9-only host the smoke is skipped
  //    (the badge correctly shows missing).
  const candidates = ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]
  const modern = candidates.find((c) => {
    try {
      return Bun.spawnSync([c, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"]).exitCode === 0
    } catch { return false } // executable not on PATH
  })
  if (modern) {
    // fetch_assets.py imports only stdlib (argparse/json/re/sys/urllib/pathlib) —
    // --help parses and exits 0 without touching Chrome/pptx/network.
    const py = Bun.spawnSync([modern, join(builtinDir, "deckcraft/scripts/fetch_assets.py"), "--help"], { cwd: ws })
    if (py.exitCode !== 0) throw new Error(`fetch_assets.py --help failed (exit ${py.exitCode}): ${py.stderr.toString().slice(0, 200)}`)
    checks.push(`bundled scripts/fetch_assets.py runs from the copied location (${modern}, stdlib) ✓`)
  } else {
    checks.push("host python < 3.10: smoke SKIPPED (deckcraft requires python3.10+, matches the dep badge / Rust probe) ⚠")
  }

  verdict = "PASS ✅ — bundled deckcraft is discovered by a real opencode from skills/builtin and its scripts run from the copied location"
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
