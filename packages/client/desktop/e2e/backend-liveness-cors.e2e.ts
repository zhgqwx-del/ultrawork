// backend-liveness-cors.e2e.ts — real-Chrome proof for the liveness probe.
//
// This one exists because two layers of testing lied in a row:
//   · jsdom's `fetch` does not implement CORS at all, so every unit test happily
//     read a 401 that a real browser would have refused to hand over;
//   · a hand-rolled "browser simulation" in node checked for the CORS header but
//     did NOT model preflight, so it blessed an OPTIONS fallback that real
//     Chrome blocks in every single case — including the healthy one.
//
// So the contract is pinned where it actually lives: real browser, real sidecar,
// real CORS. What it measures:
//
//   scenario          readable GET   no-cors GET   verdict
//   running, good pw  200            opaque        listening
//   running, bad pw   THROW          opaque        unauthorized
//   killed            THROW          THROW         absent
//
// The middle row is the whole point: a stale password used to be reported as
// "the service exited, restart the app" — advice that cannot work, because the
// bad credential lives in localStorage and survives the restart.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/backend-liveness-cors.e2e.ts
// Needs: system Chrome + a built opencode sidecar. Own ports (4198/1522).
// Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser } from "playwright-core"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DIR, "..", "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const OC_PORT = Number(process.env.E2E_OPENCODE_PORT ?? 4198)
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 1522)
const PW = "liveness-cors-pw"

const home = mkdtempSync(join(tmpdir(), "liveness-cors-"))
const auth = (p: string) => "Basic " + Buffer.from(`opencode:${p}`).toString("base64")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let browser: Browser | undefined
let web: ReturnType<typeof Bun.serve> | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"

const oc = spawn(OPENCODE, ["serve", "--port", String(OC_PORT)], {
  env: {
    ...process.env,
    OPENCODE_SERVER_PASSWORD: PW,
    OPENCODE_APP_NAME: "ultrawork",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
  },
  stdio: "ignore",
})

try {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${OC_PORT}/global/health`, {
        headers: { authorization: auth(PW) },
      })
      if (r.ok) break
    } catch {}
    await sleep(200)
  }

  // A page served over http://localhost:<port> — an origin opencode's CORS
  // policy accepts, same as the Tauri webview's tauri://localhost.
  web = Bun.serve({
    port: WEB_PORT,
    fetch: () =>
      new Response("<html><body>probe</body></html>", {
        headers: { "content-type": "text/html" },
      }),
  })

  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  await page.goto(`http://localhost:${WEB_PORT}/`)

  /** Run the hook's two probe requests inside the browser. */
  const probe = (pw: string) =>
    page.evaluate(
      async ({ port, pw }) => {
        const url = `http://localhost:${port}/global/health`
        const out = { readable: "THROW", noCors: "THROW" }
        try {
          const r = await fetch(url, {
            headers: { authorization: "Basic " + btoa(`opencode:${pw}`) },
          })
          out.readable = `ok ${r.status}`
        } catch {}
        try {
          const r = await fetch(url, { mode: "no-cors" })
          out.noCors = `ok ${r.type}`
        } catch {}
        return out
      },
      { port: OC_PORT, pw },
    )

  const good = await probe(PW)
  if (good.readable !== "ok 200") {
    throw new Error(`healthy + good creds: expected a readable 200, got ${good.readable}`)
  }
  checks.push("running + correct password → readable 200 ⇒ listening ✓")

  const bad = await probe("definitely-wrong")
  if (bad.readable !== "THROW") {
    throw new Error(
      `bad creds returned a READABLE ${bad.readable}. The upstream CORS ordering must have` +
        ` changed — if 401 is readable now, the no-cors fallback is dead weight and` +
        ` probeBackend should be simplified rather than left carrying it.`,
    )
  }
  if (bad.noCors !== "ok opaque") {
    throw new Error(`bad creds: the no-cors probe should still be opaque, got ${bad.noCors}`)
  }
  checks.push("running + wrong password → GET blocked, no-cors opaque ⇒ unauthorized (NOT absent) ✓")

  oc.kill("SIGKILL")
  await sleep(1500)
  const dead = await probe(PW)
  if (dead.noCors !== "THROW") {
    throw new Error(`killed: the no-cors probe should fail, got ${dead.noCors}`)
  }
  checks.push("killed → both probes fail ⇒ absent ✓")

  verdict = "PASS"
} catch (err) {
  verdict = "FAIL"
  console.error("\n✗", err instanceof Error ? err.message : err)
} finally {
  console.log(`\n===== ${verdict} =====`)
  for (const c of checks) console.log(" ✓", c)
  await browser?.close().catch(() => {})
  web?.stop()
  try {
    oc.kill("SIGKILL")
  } catch {}
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
  process.exit(verdict === "PASS" ? 0 : 1)
}
