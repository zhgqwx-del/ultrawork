// math-css-layout.e2e.ts — REAL-BROWSER proof of the KaTeX CSS regressions
// (discussions/055 §七之前 W1/W3) and of the bundled font path.
//
// jsdom has no layout engine and no font loading, so the unit tests in
// src/__tests__/components/chat/math-rendering.test.tsx can only prove that the
// right DOM comes out. They cannot prove:
//   W1  a long display formula scrolls INSIDE its own box instead of widening
//       the reading column (KaTeX ships `white-space: nowrap` and no overflow
//       rule; without our fix the column itself grows or the formula is clipped)
//   W3  a drag-select copies the formula once, not three times (MathML +
//       annotation + visual HTML are all in the DOM)
//   FONT the `url(/assets/KaTeX_*.woff2)` emitted into the BUILT css actually
//       resolves — this is the first `url()` reference inside our bundled CSS,
//       so it has no production precedent in this repo.
//
// Serves the real `dist/` over HTTP (closest thing to the Tauri asset protocol
// that a headless browser can exercise) and drives real Chromium.
//
//   cd packages/client/desktop && bun run --bun vite build   # dist must exist
//   cd packages/client/desktop && bun run --bun e2e/math-css-layout.e2e.ts
//
// Needs: a built dist/. No opencode, no model key, no network.
import { chromium, webkit } from "playwright-core"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import katex from "katex"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const DIST = join(DESKTOP, "dist")
const PORT = 8199
const ENGINE = process.env.E2E_ENGINE === "webkit" ? webkit : chromium
const ENGINE_NAME = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chromium"

if (!existsSync(DIST)) {
  console.error("dist/ not found — run `bun run --bun vite build` first")
  process.exit(1)
}
const cssFile = readdirSync(join(DIST, "assets")).find((f) => /^index-.*\.css$/.test(f))
if (!cssFile) { console.error("no built index-*.css in dist/assets"); process.exit(1) }

// Column width: 560px, i.e. the chat column once the artifact preview is open
// (it takes half the window). That is the real narrow case, and it is where a
// long formula actually overflows — at the full ~860px reading width even a
// KL-divergence line still fits, which is why the first version of this test
// was vacuous.
const COL_W = 560
// Deliberately wide: overflow must be guaranteed, otherwise the assertions
// below prove nothing. The non-vacuity check enforces that.
const LONG =
  "D_{KL}(P \\parallel Q) = \\sum_{x \\in \\mathcal{X}} P(x) \\log\\left(\\frac{P(x)}{Q(x)}\\right)" +
  " + \\int_{-\\infty}^{+\\infty} f(x)\\,dx - \\frac{1}{\\sigma\\sqrt{2\\pi}}" +
  " e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}} + \\alpha\\beta\\gamma\\delta\\epsilon\\zeta\\eta\\theta"
const SHORT = "M \\cdot q(x) \\geq p(x)"

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/assets/${cssFile}">
<style>#col{width:${COL_W}px;overflow-x:hidden}</style></head>
<body><div id="col"><div class="chat-md prose prose-sm">
  <p>before</p>
  <div id="long">${katex.renderToString(LONG, { displayMode: true, throwOnError: false, strict: false })}</div>
  <p id="inline">satisfies ${katex.renderToString(SHORT, { throwOnError: false, strict: false })} always</p>
  <p>after</p>
</div></div></body></html>`

const fontReqs: { url: string; status: number }[] = []
let server: ReturnType<typeof Bun.serve> | undefined
let browser: Awaited<ReturnType<typeof ENGINE.launch>> | undefined
let failed = false
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`)
  if (!ok) failed = true
}

try {
  server = Bun.serve({
    port: PORT,
    fetch(req) {
      const p = new URL(req.url).pathname
      if (p === "/" || p === "/index.html") return new Response(page, { headers: { "content-type": "text/html" } })
      const f = join(DIST, p)
      if (!f.startsWith(DIST) || !existsSync(f)) return new Response("nf", { status: 404 })
      const type = p.endsWith(".css") ? "text/css" : p.endsWith(".woff2") ? "font/woff2"
        : p.endsWith(".woff") ? "font/woff" : p.endsWith(".ttf") ? "font/ttf" : "application/octet-stream"
      return new Response(readFileSync(f), { headers: { "content-type": type } })
    },
  })

  browser = await ENGINE.launch()
  const ctx = await browser.newContext()
  const pg = await ctx.newPage()
  pg.on("response", (r) => { if (/KaTeX_/.test(r.url())) fontReqs.push({ url: r.url().split("/").pop()!, status: r.status() }) })
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" })
  await pg.evaluate(() => (document as unknown as { fonts: FontFaceSet }).fonts.ready)

  console.log(`\n[${ENGINE_NAME}] built CSS = ${cssFile}\n`)

  // ---- FONT: the bundled url(/assets/KaTeX_*) must actually resolve ----
  console.log("FONT — bundled font path resolves")
  const okFonts = fontReqs.filter((f) => f.status === 200)
  const badFonts = fontReqs.filter((f) => f.status !== 200)
  check("at least one KaTeX font fetched with 200", okFonts.length > 0,
    `${okFonts.length} ok / ${fontReqs.length} requested`)
  check("no KaTeX font 404s", badFonts.length === 0, badFonts.map((f) => `${f.url}:${f.status}`).join(", "))
  const usedKatexFont = await pg.evaluate(() => {
    const el = document.querySelector("#long .mord")
    return el ? getComputedStyle(el).fontFamily : ""
  })
  check("glyphs use a KaTeX font family", /KaTeX/i.test(usedKatexFont), usedKatexFont)

  // ---- W1: long display formula must scroll inside its own box ----
  console.log("\nW1 — long display formula must not widen the reading column")
  const w1 = await pg.evaluate(() => {
    const d = document.querySelector(".katex-display") as HTMLElement
    const col = document.getElementById("col") as HTMLElement
    const cs = getComputedStyle(d)
    return {
      overflowX: cs.overflowX,
      scrollW: d.scrollWidth, clientW: d.clientWidth,
      colScrollW: col.scrollWidth, colClientW: col.clientWidth,
      bodyScrollW: document.body.scrollWidth, bodyClientW: document.body.clientWidth,
    }
  })
  check("`.katex-display` computes overflow-x:auto", w1.overflowX === "auto", w1.overflowX)
  check("the formula really is wider than the column (test is not vacuous)",
    w1.scrollW > w1.clientW, `scrollWidth ${w1.scrollW} > clientWidth ${w1.clientW}`)
  check("the formula box itself is scrollable, not the column",
    w1.colScrollW <= w1.colClientW, `col scrollWidth ${w1.colScrollW} vs clientWidth ${w1.colClientW}`)
  check("the page body does not scroll sideways",
    w1.bodyScrollW <= w1.bodyClientW, `body scrollWidth ${w1.bodyScrollW} vs clientWidth ${w1.bodyClientW}`)

  // ---- W3: selection must not triplicate the formula ----
  console.log("\nW3 — drag-select must copy the formula once, not three times")
  const w3 = await pg.evaluate(() => {
    const mathml = document.querySelector(".katex-mathml") as HTMLElement
    const userSelect = getComputedStyle(mathml).userSelect || (getComputedStyle(mathml) as unknown as Record<string, string>)["webkitUserSelect"]
    const p = document.getElementById("inline") as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(p)
    const sel = window.getSelection()!
    sel.removeAllRanges(); sel.addRange(range)
    return { userSelect, selected: sel.toString(), rawText: p.textContent ?? "" }
  })
  check("`.katex-mathml` is user-select:none", w3.userSelect === "none", w3.userSelect)
  // The raw DOM text still contains the LaTeX source (annotation) — that is
  // expected and is exactly why the CSS rule is needed.
  check("raw textContent does contain the triplication (control)",
    w3.rawText.includes("\\cdot"), JSON.stringify(w3.rawText.slice(0, 60)))
  check("selection does NOT contain LaTeX source", !w3.selected.includes("\\cdot"),
    JSON.stringify(w3.selected))
  const occurrences = (w3.selected.match(/⋅/g) || []).length
  check("selection contains the operator exactly once", occurrences === 1, `found ${occurrences}`)

  console.log(`\n${failed ? "❌ FAILURES ABOVE" : "✅ all checks passed"}\n`)
} catch (e) {
  console.error("e2e crashed:", e)
  failed = true
} finally {
  await browser?.close()
  server?.stop(true)
}
process.exit(failed ? 1 : 0)
