// attachments-composer.e2e.ts — proves composer attachments reach the MODEL, not just the UI.
//
// Runs the real Vite app in Chromium against a REAL opencode, with a mock provider that
// echoes back which content parts it received. So the assertions are on the provider-layer
// payload, not on "a chip appeared":
//
//   A. paste an image + text  → provider gets parts=text,image_url image=image/png
//   B. paste an image, NO text → provider still gets image_url (attachment-only turn)
//   C. pick a .md file via ➕  → wireUrl is file://…, opencode reads it off disk and the
//                                provider gets the file's TEXT inlined (marker string)
//   D. user's own bubble renders the image it sent (file parts used to be filtered out)
//
// The capability gate (a model that can't see images) is covered by unit tests
// (model-capabilities.test.ts, chat-input-attachments.test.tsx) — it never reaches a provider.
//
//   cd packages/client/desktop && bun run --bun e2e/attachments-composer.e2e.ts
// Needs: system Chrome; built opencode binary.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "attach-pw"
const LLM = 8092
const OC = 4196  // NOT 4096: the user's real app may be holding that port
const MARKER = "MARKER_TEXT_FILE_7391"

// A real 8x8 red PNG (not a 1x1: we want a plausible image, and non-trivial bytes).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoU2P8z8Dwn4ECwDiqgGE0DBhGwwAaBgCK5gX/kQAZgwAAAABJRU5ErkJggg=="

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 90000) {
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

const tmp = mkdtempSync(join(tmpdir(), "attach-"))
const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })

// The text file that scenario C attaches by path. Its content must come back through the
// model, which only happens if the file:// URL was well-formed AND the server read it.
const textFile = join(ws, "notes.md")
writeFileSync(textFile, `# Notes\n\nThe secret marker is ${MARKER}.\n`)

const baseURL = `http://127.0.0.1:${LLM}/v1`
writeFileSync(
  join(tmp, ".config/ultrawork/opencode.json"),
  JSON.stringify({
    model: "mockprov/mock-model",
    provider: {
      mockprov: {
        name: "Mock",
        npm: "@ai-sdk/openai-compatible",
        api: baseURL,
        options: { baseURL, apiKey: "x" },
        models: {
          // `modalities.input` is what opencode turns into capabilities.input.image —
          // the exact field our gate reads. Without it the composer would (correctly)
          // refuse to send the image at all.
          "mock-model": {
            id: "mock-model",
            name: "Mock Vision",
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
        whitelist: ["mock-model"],
      },
    },
  }),
)
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
let verdict = "INCOMPLETE"
const results: Record<string, boolean> = {}

try {
  console.log("=== start mock-llm-vision + opencode + vite ===")
  // Assertions read from HERE, not from the DOM: the transcript renders each reply in more
  // than one place (session list preview + the turn itself), so counting occurrences in the
  // body silently matches the PREVIOUS turn's answer and the test passes without the new
  // turn ever happening. The provider's own request log is the only authoritative record.
  const seen: string[] = []
  const llm = spawn([BUN, "run", join(DIR, "mock-llm-vision.ts")], { MOCK_LLM_PORT: String(LLM) })
  void (async () => {
    for await (const buf of (llm.stdout as ReadableStream).pipeThrough(new TextDecoderStream())) {
      for (const line of String(buf).split("\n")) {
        const m = line.match(/\[mock-llm-vision\] (GOT .*)$/)
        if (m) { seen.push(m[1]); console.log(`  [provider#${seen.length}] ${m[1].slice(0, 150)}`) }
      }
    }
  })()
  // Match by CONTENT, never by ordinal: opencode fires an extra LLM call per session to
  // generate the title, so "the 2nd request" is not "the 2nd turn".
  const awaitRequest = async (label: string, pred: (r: string) => boolean) => {
    await poll(label, async () => seen.some(pred), 45000)
    return seen.find(pred)!
  }
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  const oc = spawn([OPENCODE, "serve", "--port", String(OC)], {
    ...env,
    OPENCODE_SERVER_PASSWORD: PW,
    OPENCODE_APP_NAME: "ultrawork",
  })
  // Surface opencode's own errors — a 500 from the app is otherwise a black box.
  void (async () => {
    for await (const line of (oc.stderr as ReadableStream).pipeThrough(new TextDecoderStream())) {
      for (const l of String(line).split("\n")) if (l.trim()) console.log(`  [opencode] ${l.slice(0, 220)}`)
    }
  })()
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  // Point the Vite proxy at OUR opencode, not the default 4096 a dev app may be holding.
  spawn([BUN, "run", "dev"], { E2E_OPENCODE_PORT: String(OC) }, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  page.on("console", (m) => {
    const t = m.text()
    if (/SSE error|Failed to load resource/.test(t)) return
    console.log(`  [browser:${m.type()}] ${t.slice(0, 200)}`)
  })
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`))
  page.on("response", async (r) => {
    if (!r.ok() && /\/session|\/provider|\/config/.test(r.url())) {
      console.log(`  [http ${r.status()}] ${r.request().method()} ${r.url()} :: ${(await r.text().catch(() => "")).slice(0, 200)}`)
    }
  })

  await page.addInitScript(
    ({ ws, pw, textFile, oc }) => {
      const handlers: Record<string, (a: any) => any> = {
        check_directory_exists: () => true,
        ensure_default_workspace: () => ws,
        login_shell_path: () => "",
        scan_workspace_changes: () => [],
        // ADR-045 dynamic ports: the app asks Rust for the ports instead of assuming 4096.
        // Without this it falls back to the default and talks to whatever real sidecar is up.
        get_sidecar_ports: () => ({ opencode: oc, gateway: 4197, knowledge: 4198, acp: 4199 }),
        get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
        // The ➕ button goes through the dialog plugin; hand it our .md file.
        "plugin:dialog|open": () => textFile,
        file_size: () => 64,
        copy_attachment_into_workspace: (a: any) => `${ws}/.ultrawork/attachments/x/${a.src.split("/").pop()}`,
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
    { ws, pw: PW, textFile, oc: OC },
  )

  for (let i = 0; ; i++) {
    try {
      await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" })
      break
    } catch (e) {
      if (i >= 4) throw e
      await page.waitForTimeout(2000)
    }
  }
  await page.waitForTimeout(3000)
  const body = async () => await page.locator("body").innerText()

  /** Paste a PNG into the composer exactly the way a real screenshot paste arrives. */
  const pasteImage = async () => {
    await page.locator("textarea").first().click()
    await page.evaluate((b64) => {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const file = new File([bytes], "clip.png", { type: "image/png" })
      const dt = new DataTransfer()
      dt.items.add(file)
      const ta = document.querySelector("textarea")!
      ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
    }, PNG_B64)
    // The chip only appears after the async FileReader/canvas round-trip.
    await page.waitForTimeout(800)
  }

  // Home's CTA is a labelled button ("马上开始"); the session composer's is an icon button
  // with an aria-label. Try both so the same helper works before and after navigation.
  const send = async () => {
    const cta = page.getByRole("button", { name: /马上开始|Start Now/i }).first()
    if (await cta.count().then((n) => n > 0).catch(() => false)) {
      if (await cta.isEnabled().catch(() => false)) { await cta.click(); return }
    }
    await page.getByLabel(/Send message|发送消息/i).first().click()
  }

  // ---------- A. paste an image WITH text ----------
  console.log("\n=== A: paste image + text → send ===")
  await page.locator("textarea").first().fill("describe this")
  await pasteImage()
  const chipA = (await body()).includes("clip.png")
  console.log(`[A1] chip shown in composer: ${chipA}`)
  const ctaState = await page.getByRole("button", { name: /马上开始|Start Now/i }).first().isEnabled().catch(() => "n/a")
  console.log(`[A1b] CTA enabled: ${ctaState}`)
  await send()
  await page.waitForTimeout(2500)
  console.log(`[A1c] url after send: ${page.url()}`)
  console.log(`[A1d] body: ${(await body()).replace(/\n+/g, " | ").slice(0, 300)}`)
  await page.waitForURL(/\/session\//, { timeout: 20000 })
  const reqA = await awaitRequest("A: image+text reached the provider",
    (r) => /parts=[^ ]*image_url/.test(r) && r.includes("describe this"))
  results.A_image_reached_provider = reqA.includes("image=image/png") && reqA.includes("bytes=")
  console.log(`[A2] ${reqA.slice(0, 140)}`)

  // ---------- D. the user's OWN bubble renders the image ----------
  const imgCount = await page.locator("img[src^='data:image/png']").count()
  results.D_user_bubble_shows_image = imgCount > 0
  console.log(`[D] <img data:image/png> in the user's own bubble: ${imgCount}`)

  // ---------- B. attachment-only turn (no text at all) ----------
  console.log("\n=== B: paste image, NO text → send ===")
  await pasteImage()
  await send()
  // The image must be there AND the turn must carry NO text part at all — `parts=image_url`
  // with nothing before it. A `parts=text,image_url` here would mean we fabricated an empty
  // `{type:"text",text:""}` on an attachment-only send.
  const reqB = await awaitRequest("B: attachment-only turn reached the provider",
    (r) => /parts=image_url\b/.test(r) && r.includes('text=""'))
  results.B_attachment_only_no_empty_text_part = true
  console.log(`[B] ${reqB.slice(0, 140)}`)

  // The turn reaching the provider is only half of it. The message role is INFERRED from the
  // first streamed part, and an attachment-only turn leads with a `file` part — which used to
  // be read as "assistant", ripping the user's own image out of their bubble and re-rendering
  // it as if the model had said it. Assert the image is still in the user's own bubble.
  await page.waitForTimeout(1500)
  const userImgs = await page.locator("div.items-end img[src^='data:image']").count()
  results.B_image_stays_in_the_users_own_bubble = userImgs >= 2
  console.log(`[B2] images inside user bubbles after two image turns: ${userImgs} (want 2)`)

  // ---------- C. attach a text file BY PATH (file:// wire URL) ----------
  console.log("\n=== C: ➕ → notes.md (file:// path) → send ===")
  await page.getByLabel(/Add attachment|添加附件/).first().click()
  await page.waitForTimeout(600)
  const chipC = (await body()).includes("notes.md")
  console.log(`[C1] chip shown: ${chipC}`)
  await page.locator("textarea").first().fill("what is the secret marker?")
  await send()
  const reqC = await awaitRequest("C: server read the file:// attachment off disk",
    (r) => r.includes(MARKER))
  results.C_file_url_read_by_server = true
  console.log(`[C2] ${reqC.slice(0, 220)}`)

  // The server splices a SYNTHETIC text part into the USER's message for a text attachment —
  // "Called the Read tool with the following input: {...}" plus up to 50 KB of the file. Shown
  // verbatim, the user's own speech bubble fills with a tool transcript and a file dump they
  // never typed. It must be filtered out of their bubble (the model still sees it).
  await page.waitForTimeout(1500)
  const userBubbles = await page.locator("div.items-end").allInnerTexts()
  const leaked = userBubbles.some((b) => b.includes("Called the Read tool") || b.includes(MARKER))
  results.C_no_synthetic_dump_in_user_bubble = !leaked
  console.log(`[C3] synthetic Read-tool dump leaked into a user bubble: ${leaked}`)

  const allPass = Object.values(results).every(Boolean)
  verdict = allPass
    ? "PASS ✅ — attachments reach the provider (image + attachment-only + file:// text), and the user's bubble renders them"
    : `FAIL ❌ — ${JSON.stringify(results)}`
} catch (e) {
  verdict = `ERROR: ${(e as Error).message}`
} finally {
  console.log("\n=== results:", JSON.stringify(results, null, 2))
  console.log("=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) {
    try {
      p.kill()
    } catch {}
  }
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
