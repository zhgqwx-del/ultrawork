// deckcraft P2b — Node assembler: layout.json → editable .pptx (pptxgenjs).
//
//   node assemble.mjs <layout.json> <out.pptx>
//
// Pure translation, no browser: reads the primitives extract_layout.py produced
// and emits one pptxgenjs object per element. This is the ONLY step that owns the
// px→inch (96 px/in) and px→pt (×0.75) conversion, so geometry has a single SSOT.
// pptxgenjs is loaded from the vendored self-contained CJS bundle (MIT) — no
// node_modules, no npm at runtime (see vendor/README.md).
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const PptxGenJS = (() => {
  const m = require(path.join(here, "vendor", "pptxgen.vendor.cjs"));
  return m.default || m;
})();

const PX_PER_IN = 96; // deck stage is 1280px wide == 13.333in → exactly 96 px/in
const IN = (px) => px / PX_PER_IN;
const PT = (px) => px * 0.75; // 1 CSS px = 1/96in, 1pt = 1/72in → px*72/96
const round = (n) => Math.round(n * 1000) / 1000;

function fail(msg) {
  process.stderr.write("ERROR: " + msg + "\n");
  process.exit(1);
}

const [layoutPath, outPath] = process.argv.slice(2);
if (!layoutPath || !outPath) fail("usage: node assemble.mjs <layout.json> <out.pptx>");

const fs = require("fs");
let layout;
try {
  layout = JSON.parse(fs.readFileSync(layoutPath, "utf-8"));
} catch (e) {
  fail("cannot read layout.json: " + e.message);
}
const pages = layout.pages || [];
if (!pages.length) fail("layout.json has no pages");

const pptx = new PptxGenJS();
pptx.defineLayout({ name: "DECK", width: 13.333, height: 7.5 });
pptx.layout = "DECK";

// geometry → pptxgenjs position object (inches), clamped into the slide
function pos(b) {
  return {
    x: round(IN(b.x)),
    y: round(IN(b.y)),
    w: round(Math.max(IN(b.w), 0.05)),
    h: round(Math.max(IN(b.h), 0.05)),
  };
}

// our run list → pptxgenjs text objects; a {break:true} marker ends the
// preceding line (breakLine on the last real run, or a standalone break)
function toRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (r.break) {
      if (out.length) out[out.length - 1].options.breakLine = true;
      else out.push({ text: "", options: { breakLine: true } });
      continue;
    }
    // per-run fontSize/transparency so an inline caption span keeps its own
    // smaller/dimmer look instead of inheriting the container's (review H1/M2)
    const o = { color: r.color || "000000", bold: !!r.bold, italic: !!r.italic };
    if (r.fontPx) o.fontSize = round(PT(r.fontPx));
    if (r.opacity != null && r.opacity < 1)
      o.transparency = Math.round((1 - r.opacity) * 100);
    out.push({ text: r.text || "", options: o });
  }
  return out.length ? out : [{ text: "" }];
}

let rasterTotal = 0;
const problems = []; // element the assembler could NOT place — surfaced as a hard
// failure at the end (never silently dropped), because every other output format
// shows these and the editable pptx must not quietly omit them
for (const pg of pages) {
  const slide = pptx.addSlide();
  slide.background = { color: pg.background || "FFFFFF" };
  // presenter-view notes (parity with the image-type pptx); absent when no outline
  if (pg.notes) slide.addNotes(String(pg.notes));
  for (const el of pg.elements || []) {
    const p = pos(el.box);
    if (el.type === "rect") {
      const opts = { ...p };
      if (el.radius > 0) opts.rectRadius = Math.min(round(IN(el.radius)), p.h / 2, p.w / 2);
      opts.fill =
        el.fill == null
          ? { type: "none" }
          : el.fillAlpha != null && el.fillAlpha < 1
          ? { color: el.fill, transparency: Math.round((1 - el.fillAlpha) * 100) }
          : { color: el.fill };
      opts.line = el.line
        ? { color: el.line.color, width: round(PT(el.line.width)) }
        : { type: "none" };
      slide.addShape(el.radius > 0 ? "roundRect" : "rect", opts);
    } else if (el.type === "text") {
      const opts = {
        ...p,
        fontSize: round(PT(el.fontPx || 16)),
        align: el.align || "left",
        valign: "top",
        margin: 0,
        fontFace: el.fontFamily || undefined,
      };
      if (el.lineHeightPx && el.fontPx)
        opts.lineSpacingMultiple = round(el.lineHeightPx / el.fontPx);
      if (el.letterSpacingPx) opts.charSpacing = round(PT(el.letterSpacingPx));
      // browser-single-line text keeps to one line (no PowerPoint re-wrap) — see
      // extract_layout pushText; multi-line text still wraps inside its box
      if (el.wrap === false) opts.wrap = false;
      slide.addText(toRuns(el.runs || []), opts);
    } else if (el.type === "image") {
      const src = el.src || "";
      const opts = { ...p };
      if (src.startsWith("data:")) opts.data = src;
      else opts.path = path.isAbsolute(src) ? src : path.resolve(path.dirname(layoutPath), src);
      try {
        slide.addImage(opts);
        if (el.rasterized) rasterTotal++;
      } catch (e) {
        problems.push(`page ${pg.index}: could not embed image (${e.message})`);
      }
    } else if (el.type === "raster") {
      // Python resolves every raster to a cropped image before this runs; a
      // leftover means it could not — that is a real defect, not something to
      // paper over with a blank slot.
      problems.push(`page ${pg.index}: unresolved raster element`);
    }
  }
}

// Any element we could not place is a hard failure — export_deck surfaces the
// non-zero exit + this message rather than shipping a silently deficient pptx.
if (problems.length) {
  fail(`could not place ${problems.length} element(s):\n  - ` + problems.join("\n  - "));
}

pptx
  .writeFile({ fileName: outPath })
  .then(() => {
    process.stdout.write(`OK: ${outPath} (${pages.length} slides, ${rasterTotal} rasterized elements)\n`);
    process.exit(0);
  })
  .catch((e) => fail("pptxgenjs writeFile failed: " + e.message));
