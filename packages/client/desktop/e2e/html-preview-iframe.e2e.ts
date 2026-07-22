// html-preview-iframe.e2e.ts — engine-level proof for the in-app HTML preview.
//
// The artifact preview renders HTML files as an in-app browser preview:
// `<iframe srcDoc={content} sandbox="allow-scripts">` (artifact-preview.tsx). The
// vitest unit test (artifact-preview-html.test.tsx) proves the REAL component
// emits that iframe with the right props + the preview⇄source toggle. This e2e
// proves that exact markup, fed a REAL self-contained deckcraft deck.html, both
// RENDERS and STAYS ISOLATED — on BOTH engines Tauri ships:
//   • Chromium  = Windows WebView2
//   • WebKit    = macOS WKWebView + Linux WebKitGTK
// so the two together cover all three shipping platforms' renderers.
//
// Asserts, per engine:
//   1. the self-contained deck renders (all 10 slides present)
//   2. the deck's inline "fit" script RAN under sandbox="allow-scripts"
//      (side effect: #stage gets an inline zoom:<s<1>) — confirms scripts work
//      WITHOUT needing allow-same-origin
//   3. sandbox isolation: opaque origin; the frame CANNOT reach the parent DOM
//      or a parent-exposed window.__TAURI__ IPC (both throw SecurityError)
//   4. control: with sandbox="" (scripts blocked) the fit script does NOT run —
//      proving assertion #2 actually discriminates.
//   5. fit correctness at a sub-1280 width (real half-panel): deck is CENTERED and
//      leaves NO empty scroll space below the last slide. The old transform:scale +
//      negative-margin fit left (1-s)*h of dark scrollable space at the bottom
//      because scrollHeight ignores negative margins; the zoom fit makes
//      body.scrollHeight == visual height (discussions/050).
//
// Run:  cd packages/client/desktop && bun run --bun e2e/html-preview-iframe.e2e.ts
// Needs: system Chrome (playwright-core channel:"chrome") and/or the bundled
//        WebKit. Self-contained — NO opencode server, NO model, NO auth key.
//        Each engine is skipped (not failed) if it can't launch. Exit 0 = PASS.
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright-core"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..", "..", "..") // e2e → desktop → client → packages → repo
const DECK = readFileSync(join(REPO, "skills/builtin/deckcraft/examples/ai-coding-pilot/deck.html"), "utf-8")
const EXPECTED_SLIDES = (DECK.match(/class="slide/g) || []).length // derive, don't hard-code

let failures = 0
let ran = 0
function check(engine: string, name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} [${engine}] ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

// Parent page simulates the real app webview: it exposes a Tauri-like IPC global
// and a secret. A properly isolated sandbox frame must reach NEITHER.
const PARENT = `<!doctype html><html><head><meta charset="utf-8"><title>PARENT_APP</title></head>
<body><div id="host"></div>
<script>
  window.__TAURI__ = { invoke: function(){ return "PARENT_SECRET_IPC" } };
  window.__APP_SECRET__ = "do-not-leak";
</script></body></html>`

// Mount the iframe from Node with DECK passed as a serialized arg — faithful to
// React's srcDoc={content} (the srcdoc property is set to the raw HTML string).
async function mountDeckFrame(page: Page, sandbox: string, width = 1280) {
  await page.setContent(PARENT, { waitUntil: "load" })
  await page.evaluate(({ deck, sandbox, width }) => {
    const f = document.createElement("iframe")
    f.setAttribute("sandbox", sandbox)
    f.id = "deckframe"
    f.style.cssText = `width:${width}px;height:720px;border:0`
    f.srcdoc = deck
    document.getElementById("host")!.appendChild(f)
  }, { deck: DECK, sandbox, width })
  await page.waitForTimeout(500) // let the frame attach + run its own script
}

const frameOf = (page: Page) => page.frames().find((f) => f !== page.mainFrame())

async function runEngine(kind: BrowserType, engine: string) {
  let browser: Browser
  try {
    browser = engine === "chromium"
      ? await kind.launch({ channel: "chrome", headless: true })
      : await kind.launch({ headless: true })
  } catch (e) {
    console.log(`\n=== engine: ${engine} === SKIPPED (cannot launch: ${(e as Error).message})`)
    return
  }
  ran++
  console.log(`\n=== engine: ${engine} ===`)
  try {
    // ---------- main path: sandbox="allow-scripts" (what the component uses) ----------
    const page = await browser.newPage()
    await mountDeckFrame(page, "allow-scripts")
    const frame = frameOf(page)
    check(engine, "sandboxed deck frame attached", !!frame)
    if (frame) {
      const slides = await frame.evaluate(() => document.querySelectorAll(".slide").length)
      check(engine, `self-contained deck rendered (${EXPECTED_SLIDES} slides)`, slides === EXPECTED_SLIDES, `got ${slides}`)

      const zoom = await frame.evaluate(() => {
        const st = document.getElementById("stage")
        return st ? st.style.zoom : "(no #stage)"
      })
      // width defaults to 1280 → s = (1280-32)/1280 = 0.975; a run leaves a numeric
      // fraction in (0,1], a no-run leaves "" (parseFloat → NaN → fails).
      check(engine, "fit script RAN under allow-scripts (#stage has inline zoom)", parseFloat(zoom) > 0 && parseFloat(zoom) <= 1, `zoom="${zoom}"`)

      const origin = await frame.evaluate(() => window.origin)
      check(engine, "opaque origin (sandbox isolation)", origin === "null", `origin=${origin}`)

      const parentDom = await frame.evaluate(() => {
        try { return String(window.parent.document.title) } catch (e) { return "BLOCKED:" + (e as Error).name }
      })
      check(engine, "parent DOM unreachable from frame", parentDom.startsWith("BLOCKED"), parentDom)

      const parentTauri = await frame.evaluate(() => {
        try { return typeof (window.parent as any).__TAURI__ } catch (e) { return "BLOCKED:" + (e as Error).name }
      })
      check(engine, "parent __TAURI__ IPC unreachable from frame", parentTauri.startsWith("BLOCKED"), parentTauri)

      const ownTauri = await frame.evaluate(() => typeof (window as any).__TAURI__)
      check(engine, "frame has no __TAURI__ of its own", ownTauri === "undefined", `typeof=${ownTauri}`)
    }
    await page.close()

    // ---------- fit correctness at a sub-1280 width (the real half-panel): the deck
    // must be CENTERED and leave NO empty scroll space below the last slide. zoom
    // scales layout+paint so margin:0 auto centers and body.scrollHeight collapses
    // to the visual height; the old transform:scale + negative-margin left a big
    // (1-s)*h dark scrollable gap at the bottom (discussions/050). ----------
    const cen = await browser.newPage()
    await mountDeckFrame(cen, "allow-scripts", 1145)
    const cframe2 = frameOf(cen)
    if (cframe2) {
      const m = await cframe2.evaluate(() => {
        const slides = [...document.querySelectorAll(".slide")] as HTMLElement[]
        const first = slides[0], last = slides[slides.length - 1]
        const vw = document.documentElement.clientWidth
        const r = first.getBoundingClientRect()
        return {
          off: Math.round(r.left + r.width / 2 - vw / 2),
          left: Math.round(r.left), right: Math.round(vw - r.right),
          gap: Math.round(document.body.scrollHeight - last.getBoundingClientRect().bottom),
        }
      })
      check(engine, "deck centered at sub-1280 width (1145 ≈ half panel)", Math.abs(m.off) <= 3 && Math.abs(m.left - m.right) <= 3, `off=${m.off}px L=${m.left} R=${m.right}`)
      // old fit left ~950px here; zoom leaves only the last slide's bottom margin (≤24px).
      check(engine, "no empty scroll space below last slide (zoom fit, discussions/050)", Math.abs(m.gap) <= 30, `gap=${m.gap}px`)
    }
    await cen.close()

    // ---------- control: sandbox="" → scripts blocked → fit script must NOT run ----------
    const ctl = await browser.newPage()
    await mountDeckFrame(ctl, "")
    const cframe = frameOf(ctl)
    if (cframe) {
      const cZoom = await cframe.evaluate(() => {
        const st = document.getElementById("stage")
        return st ? st.style.zoom : "(no #stage)"
      })
      check(engine, "control: scripts blocked → fit script did NOT run (zoom unset)", cZoom === "", `zoom="${cZoom}"`)
      const cSlides = await cframe.evaluate(() => document.querySelectorAll(".slide").length)
      check(engine, "control: static content still renders without scripts", cSlides === EXPECTED_SLIDES, `got ${cSlides}`)
    }
    await ctl.close()
  } finally {
    await browser.close()
  }
}

await runEngine(chromium, "chromium")
await runEngine(webkit, "webkit")

if (ran === 0) {
  console.log("\nNO ENGINE AVAILABLE — could launch neither Chrome nor WebKit; nothing verified.")
  process.exit(1)
}
console.log(`\n${failures === 0 ? `ALL CHECKS PASSED ✓ (${ran} engine(s))` : `${failures} CHECK(S) FAILED ✗`}`)
process.exit(failures === 0 ? 0 : 1)
