// orchestration-worktree.e2e.ts — worktree isolation's three reclaim branches,
// against the REAL compiled acp-client + REAL opencode.
//
// Why this exists as an e2e and not a unit test: `worktree.test.ts` calls
// `removeWorktree` directly, so it proves the function's contract but never runs
// the orchestrator's branching. The bug it guards (every worktree run leaving an
// empty `<root>/<runId>/` behind — 168 residual dirs after a 523-run soak) lived in
// the gap between those two, and the FAN-OUT shape is what a unit test cannot reach:
// the Pipeline tab gives every worker the SAME `inputs`, so they start in PARALLEL
// and several worktrees exist under one runId at once. A serial-chain recipe
// (`inputs: ["s0"]`) never produces that, which is exactly how the soak missed it.
//
// Three branches, and they must not be collapsed — they behave differently:
//   A  all steps succeed        -> run dir reclaimed
//   B  a step writes no deliverable -> worktree KEPT for debugging, dir survives
//   C  run cancelled mid-flight -> cancel path tears it down, dir reclaimed
//
// Run:  cd packages/client/desktop && bun run --bun e2e:orch-worktree
// Needs: built sidecars (`bun run build:acp`, `bun run build:opencode`) + git.
// Isolated: temp HOME/XDG, own ports (4696/4699/8696). Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync, readdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const DESKTOP = join(HERE, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const PLAT = process.platform === "win32" ? "pc-windows-msvc" : process.platform === "linux" ? "unknown-linux-gnu" : "apple-darwin"
const EXE = process.platform === "win32" ? ".exe" : ""
const bin = (n: string) => join(DESKTOP, "src-tauri/binaries", `${n}-${ARCH}-${PLAT}${EXE}`)
const PW = "orch-wt-pw"
const OC_PORT = process.env.ORCH_OC_PORT ?? "4696"
const ACP_PORT = process.env.ORCH_ACP_PORT ?? "4699"
const LLM_PORT = process.env.ORCH_LLM_PORT ?? "8696"
const OC = `http://127.0.0.1:${OC_PORT}`
const ACP = `http://127.0.0.1:${ACP_PORT}`

// HOME must be redirected BEFORE this process starts: `os.homedir()` resolves once
// at startup, so setting process.env.HOME here would be a no-op and the run would
// write the developer's real ~/.local/share/ultrawork (gotchas §7).
const CHILD = process.env.ORCH_WT_TMP
if (!CHILD) {
  // REALPATH the temp root, don't just mkdtemp it. On macOS `/var` symlinks to
  // `/private/var`, and `worktreesRoot()` derives from XDG_DATA_HOME verbatim — so
  // an unresolved HOME makes a worker's deliverable path (`/var/...`) disagree with
  // its own cwd, which opencode resolves (`/private/var/...`). The write is then
  // treated as escaping the sandbox: the tool call never returns and every worker
  // step dies with a bare "turn timed out", pointing nowhere near the real cause.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "orch-wt-")))
  const child = Bun.spawn([process.execPath, "run", "--bun", import.meta.path], {
    env: {
      ...process.env, ORCH_WT_TMP: parent, HOME: parent, USERPROFILE: parent,
      XDG_CONFIG_HOME: join(parent, ".config"), XDG_DATA_HOME: join(parent, ".local/share"),
      XDG_CACHE_HOME: join(parent, ".cache"), XDG_STATE_HOME: join(parent, ".local/state"),
    },
    stdout: "inherit", stderr: "inherit",
  })
  const code = await child.exited
  rmSync(parent, { recursive: true, force: true })
  process.exit(code)
}
const tmp = CHILD
if (homedir() !== tmp) {
  console.error(`FATAL: HOME redirect failed (homedir()=${homedir()}, want ${tmp}). Refusing to run.`)
  process.exit(1)
}

const WS = (() => { mkdirSync(join(tmp, "ws"), { recursive: true }); return realpathSync(join(tmp, "ws")) })()
const WTROOT = join(tmp, ".local/share/ultrawork/worktrees")
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const llmBase = `http://127.0.0.1:${LLM_PORT}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  permission: { bash: "allow", edit: "allow", write: "allow" },
  provider: { mockprov: { name: "Mock", npm: "@ai-sdk/openai-compatible", api: llmBase,
    options: { baseURL: llmBase, apiKey: "x" },
    models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } }, whitelist: ["mock-model"] } },
}))

const AUTH = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
// /orchestration/* REQUIRES this header — the sidecar answers 401 without it
// (api-reference §ACP notes the doc used to say otherwise).
const H = { authorization: AUTH, "content-type": "application/json" }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const procs: ReturnType<typeof Bun.spawn>[] = []
// `pipe` without a reader is a deadlock: once the OS pipe buffer fills, the child
// blocks on write and simply stops. Hit while writing this harness — `plan` (little
// output) passed, then all five concurrent workers wedged and reported only "turn
// timed out". Either drain the streams or don't create them; `E2E_VERBOSE=1`
// forwards them for debugging.
const VERBOSE = process.env.E2E_VERBOSE === "1"
const spawn = (cmd: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdout: VERBOSE ? "inherit" : "ignore",
    stderr: VERBOSE ? "inherit" : "ignore",
  })
  procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 90000) {
  const s = Date.now()
  while (Date.now() - s < ms) { try { if (await fn()) return } catch {} ; await sleep(300) }
  throw new Error(`timeout: ${label}`)
}
const git = async (args: string[]) => { const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" }); await new Response(p.stdout).text(); await p.exited }

const checks: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = "") => { checks.push([n, ok, d]); console.log(`${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`) }
/** step dirs still under this run's worktree dir; null = the run dir itself is gone */
const stepsOf = (runId: string) => (existsSync(join(WTROOT, runId)) ? readdirSync(join(WTROOT, runId)) : null)

async function startRun(steps: unknown[]): Promise<string> {
  const r = await fetch(`${ACP}/orchestration/runs`, { method: "POST", headers: H,
    body: JSON.stringify({ recipe: { name: "wt-e2e", workspace: WS, steps } }) })
  if (!r.ok) throw new Error(`create run ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = (await r.json()) as any
  return j.run?.id ?? j.id
}
async function waitRun(id: string, ms = 120000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const r = await fetch(`${ACP}/orchestration/runs/${id}`, { headers: H })
    if (r.ok) {
      const run = ((await r.json()) as any).run
      if (run && !["running", "pending", "queued"].includes(run.status)) return run
    }
    await sleep(400)
  }
  throw new Error(`run ${id} never settled`)
}
/** planner + N workers sharing one input => the workers run in PARALLEL. */
const fanout = (workers: number, opts: { slow?: boolean } = {}) => [
  { id: "plan", agentId: "opencode:default", taskPrompt: "plan", model: "mockprov/mock-model", timeoutMs: 60000 },
  ...Array.from({ length: workers }, (_, i) => ({
    id: `worker-${i + 1}`, agentId: "opencode:default",
    taskPrompt: `${opts.slow ? "[[SLOW]] " : ""}worker ${i + 1}`,
    inputs: ["plan"], model: "mockprov/mock-model", timeoutMs: 60000, isolation: "worktree",
  })),
]

try {
  spawn([process.execPath, "run", "--bun", join(HERE, "mock-llm-orchestration.ts")], { MOCK_LLM_PORT: LLM_PORT })
  await poll("mock-llm", async () => (await fetch(`${llmBase}/models`)).ok)

  await git(["init", "-q", WS])
  await git(["-C", WS, "config", "user.email", "e2e@test"])
  await git(["-C", WS, "config", "user.name", "e2e"])
  writeFileSync(join(WS, "README.md"), "worktree e2e\n")
  await git(["-C", WS, "add", "-A"])
  await git(["-C", WS, "commit", "-qm", "init"])

  const env = {
    HOME: tmp, USERPROFILE: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share"),
    OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork",
  }
  spawn([bin("opencode-server"), "serve", "--hostname", "127.0.0.1", "--port", OC_PORT], env)
  await poll("opencode", async () => (await fetch(`${OC}/global/health`, { headers: H })).ok)
  spawn([bin("acp-client")], { ...env, ACP_CLIENT_PORT: ACP_PORT, OPENCODE_BASE_URL: OC,
    ULTRAWORK_SIDECAR_USERNAME: "opencode", ULTRAWORK_SIDECAR_PASSWORD: PW, PATH: process.env.PATH ?? "" })
  await poll("acp-client", async () => (await fetch(`${ACP}/acp/health`, { headers: H })).ok)

  // ── A: 5 parallel worktrees, all succeed ────────────────────────────────
  console.log("\n=== A) fan-out: 5 parallel worktrees, all succeed ===")
  const idA = await startRun(fanout(5))
  // Sample while it runs: "cleaned up" and "never created" look identical at the
  // end, so the fix is only proven if the worktrees demonstrably co-existed.
  let peak = 0
  const watch = (async () => { for (let i = 0; i < 600; i++) { peak = Math.max(peak, stepsOf(idA)?.length ?? 0); await sleep(50) } })()
  const runA = await waitRun(idA)
  await watch
  check("A1 worktrees really co-existed (non-vacuity)", peak >= 2, `peak concurrent = ${peak}`)
  check("A2 run completed", runA.status === "completed", `status=${runA.status}`)
  // A failing step's own message is the only thing that distinguishes "the fix is
  // broken" from "the harness never produced a deliverable" — print it rather than
  // leave the next reader to guess.
  if (runA.status !== "completed")
    for (const s of runA.steps ?? []) console.log(`    step ${s.id}: ${s.status}${s.error ? ` — ${s.error}` : ""}`)
  check("A3 run dir reclaimed", stepsOf(idA) === null, `left=${JSON.stringify(stepsOf(idA))}`)
  check("A4 worktrees root itself survives", existsSync(WTROOT))
  const arts = existsSync(join(WS, ".ultrawork/runs", idA)) ? readdirSync(join(WS, ".ultrawork/runs", idA)) : []
  check("A5 deliverables collected out of the worktrees", arts.length >= 6, `artifacts=${arts.length}`)

  // ── B: a step writes nothing => its worktree is KEPT ─────────────────────
  console.log("\n=== B) a worker writes no deliverable => worktree kept for debugging ===")
  const stepsB = fanout(3) as any[]
  stepsB[1].taskPrompt = "[[NOWRITE]] worker that writes nothing"
  const idB = await startRun(stepsB)
  const runB = await waitRun(idB)
  const leftB = stepsOf(idB)
  check("B1 run did not complete", runB.status !== "completed", `status=${runB.status}`)
  check("B2 failed step's worktree KEPT (dir survives)", !!leftB && leftB.length > 0, `left=${JSON.stringify(leftB)}`)

  // ── C: cancel mid-flight ────────────────────────────────────────────────
  console.log("\n=== C) cancel mid-flight ===")
  const idC = await startRun(fanout(4, { slow: true }))
  await poll("workers started", async () => (stepsOf(idC)?.length ?? 0) >= 1, 30000)
  await fetch(`${ACP}/orchestration/runs/${idC}/cancel`, { method: "POST", headers: H })
  const runC = await waitRun(idC)
  await sleep(1500)
  check("C1 run cancelled", runC.status === "cancelled" || runC.status === "failed", `status=${runC.status}`)
  check("C2 cancelled run leaves no empty dir", stepsOf(idC) === null, `left=${JSON.stringify(stepsOf(idC))}`)
} catch (e) {
  check("harness completed", false, String(e).slice(0, 300))
} finally {
  for (const p of procs) { try { p.kill(9) } catch {} }
  await sleep(600)
  const failed = checks.filter(([, ok]) => !ok)
  console.log(`\n${failed.length ? "FAIL" : "PASS"} — ${checks.length - failed.length}/${checks.length}`)
  for (const [n, , d] of failed) console.log(`  ✗ ${n} ${d}`)
  process.exit(failed.length ? 1 : 0)
}
