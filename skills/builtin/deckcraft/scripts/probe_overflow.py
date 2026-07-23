#!/usr/bin/env python3
"""deckcraft physical probe — ground truth for text overflow AND text contrast.

    python3 probe_overflow.py <project_dir> [--page N] [--dump-contrast]

Renders each page in headless Chrome with an injected measuring script and reports:
  (a) overflow — elements that stick out of the 1280x720 canvas, or whose content
      is clipped by an overflow-hidden ancestor;
  (b) low contrast — visible text whose computed color against its *effective*
      (composited) background falls below MIN_CONTRAST.

Both upgrade a heuristic to a physical gate: what Chrome actually lays out and
paints. (a) backstops the IR character budget; (b) backstops visual-review R4
"对比可读", which is a subjective reviewer judgement and was empirically missed on
a real deck — see docs/discussions/052.

  --page N          probe only page N (used by the first-page gate)
  --dump-contrast   print every measured text element (ratio, fg, bg) instead of
                    only failures — the calibration/debug view, exit 0

Output: one line per finding + a JSON summary appended to <project>/qa_report.json
(sections "overflow" and "contrast"). Exit 0 = clean, 1 = finding, 2 = setup problem.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from export_deck import CHROME_BASE, split_pages
from find_chrome import find_browser

from console_encoding import configure_utf8_stdio

configure_utf8_stdio()

PROBE_JS = """
<script>
(function(){
// Measure only after the load event: a synchronous snapshot would run before
// images decode, so an oversized image could never be caught (false negative).
// --virtual-time-budget advances headless Chrome past load before --dump-dom.

// ---- WCAG 2.x relative luminance / contrast ratio ----
function parseColor(s){
  var m = /rgba?\\(([^)]+)\\)/.exec(s || '');
  if (!m) return null;
  var p = m[1].split(',');
  return { r: parseFloat(p[0]), g: parseFloat(p[1]), b: parseFloat(p[2]),
           a: p.length > 3 ? parseFloat(p[3]) : 1 };
}
function over(fg, bg){            // composite fg over an already-opaque bg
  var a = fg.a;
  return { r: fg.r*a + bg.r*(1-a), g: fg.g*a + bg.g*(1-a), b: fg.b*a + bg.b*(1-a), a: 1 };
}
function lum(c){
  var v = [c.r, c.g, c.b].map(function(x){
    x /= 255;
    return x <= 0.03928 ? x/12.92 : Math.pow((x + 0.055)/1.055, 2.4);
  });
  return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2];
}
function contrast(f, b){
  var l1 = lum(f), l2 = lum(b);
  return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
}
function hex(c){
  function h(x){ var s = Math.round(x).toString(16); return s.length < 2 ? '0'+s : s; }
  return '#' + h(c.r) + h(c.g) + h(c.b);
}
// The painted background under `el`: composite every ancestor's background-color
// from the outermost inward over an opaque white base. This is what makes a
// [data-dark] page resolve to its dark section colour rather than to white, and
// what makes a translucent card blend instead of being read as its own alpha.
function effectiveBg(el){
  var chain = [], n = el;
  while (n && n.nodeType === 1) { chain.push(n); n = n.parentElement; }
  var base = { r: 255, g: 255, b: 255, a: 1 }, imaged = false;
  for (var i = chain.length - 1; i >= 0; i--) {
    var cs = getComputedStyle(chain[i]);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') imaged = true;
    var bc = parseColor(cs.backgroundColor);
    if (bc && bc.a > 0) base = over(bc, base);
  }
  return { color: base, imaged: imaged };
}
// Only the element that directly owns the characters, so a wrapper div does not
// get scored for text its child paints (that would double-count and mis-attribute
// the foreground colour, which is inherited but often overridden on the child).
function ownText(el){
  var t = '';
  for (var i = 0; i < el.childNodes.length; i++) {
    var n = el.childNodes[i];
    if (n.nodeType === 3) t += n.nodeValue;
  }
  return t.replace(/\\s+/g, ' ').trim();
}
function cumulativeOpacity(el){
  var o = 1, n = el;
  while (n && n.nodeType === 1) {
    var v = parseFloat(getComputedStyle(n).opacity);
    if (!isNaN(v)) o *= v;
    n = n.parentElement;
  }
  return o;
}

function measure(){
  var out = [], con = [];
  var els = document.querySelectorAll('.slide *');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    var name = el.tagName.toLowerCase() +
      (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');
    var text = (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 24);
    if (r.right > 1282 || r.bottom > 722 || r.left < -2 || r.top < -2) {
      out.push({ el: name, text: text, kind: 'out-of-canvas',
                 px: Math.round(Math.max(r.right - 1280, r.bottom - 720, -r.left, -r.top)) });
      continue;
    }
    var cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      var ow = el.scrollWidth - el.clientWidth, oh = el.scrollHeight - el.clientHeight;
      if (ow > 1 || oh > 1) {
        out.push({ el: name, text: text, kind: 'clipped', px: Math.round(Math.max(ow, oh)) });
      }
    }

    // ---- contrast ----
    var own = ownText(el);
    if (!own) continue;
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    var fgRaw = parseColor(cs.color);
    if (!fgRaw) continue;
    // Fully transparent glyphs are a paint technique (background-clip:text
    // gradients), not a legibility defect this gate can reason about.
    if (fgRaw.a === 0) continue;
    var op = cumulativeOpacity(el);
    if (op < 0.05) continue;                    // effectively not painted
    var bg = effectiveBg(el);
    // Fold inherited opacity into the glyph alpha. Approximation: an ancestor's
    // opacity also fades that ancestor's own background, but in this skill's
    // templates the faded thing is the text layer, and the error is conservative
    // (a faded glyph reads as lower contrast, which is what the eye sees).
    var fg = over({ r: fgRaw.r, g: fgRaw.g, b: fgRaw.b, a: fgRaw.a * op }, bg.color);
    var size = parseFloat(cs.fontSize) || 0;
    var weight = parseInt(cs.fontWeight, 10) || 400;
    con.push({ el: name, text: own.slice(0, 24),
               ratio: Math.round(contrast(fg, bg.color) * 100) / 100,
               fg: hex(fg), bg: hex(bg.color), size: Math.round(size),
               // WCAG "large text": >=24px, or >=18.66px when bold
               large: size >= 24 || (size >= 18.66 && weight >= 700),
               imaged: bg.imaged });
  }
  var node = document.createElement('script');
  node.type = 'application/json'; node.id = '__probe__';
  // Escape every less-than sign to its JSON unicode form so a slide whose visible
  // text contains a literal closing-script tag can't prematurely close this JSON
  // block in the --dump-dom serialization (which would truncate the Python-side
  // regex extraction and crash json.loads). fromCharCode(92)=backslash avoids
  // Python/JS backslash double-escaping; json.loads reads it back to the character.
  // (NOTE: keep the literal closing-script character sequence OUT of this comment —
  // it would itself close this inlined script mid-parse. Meta, but real.)
  node.textContent = JSON.stringify({ o: out, c: con }).split(String.fromCharCode(60)).join(String.fromCharCode(92) + 'u003c');
  document.body.appendChild(node);
}
// this script is inlined mid-body, so it always runs during parse (before load);
// waiting for load guarantees images have decoded before we measure
window.addEventListener('load', measure);
})();
</script>
"""


# This is a "can a human see this at all" floor, deliberately far below WCAG AA
# (4.5): the gate must never argue with the skill's own muted/accent styling, only
# catch text that is effectively invisible (docs/discussions/052).
#
# Calibrated by measuring every text element Chrome actually paints across all four
# shipped examples (369 elements) against the real defect it exists to catch:
#
#   defect (on-dark light text on a light card)  1.10:1   28px h2, i.e. "large"
#   lowest legitimate large text                 2.57:1   80px accent number on dark
#   lowest legitimate normal text                3.12:1   14px accent kicker
#   correct S04 column head                      9.96:1
#
# Hence two floors, shaped like WCAG's own large-text allowance. Large text keeps a
# lower floor so decorative accent numerals are not second-guessed, and the defect is
# still caught with room to spare (1.10 << 1.8). Both floors sit ~1.4x below the
# lowest thing the examples legitimately do, so neither is on a knife edge.
MIN_CONTRAST = 2.3        # normal text — lowest legitimate measured 3.12
MIN_CONTRAST_LARGE = 1.8  # >=24px, or >=18.66px bold — lowest legitimate measured 2.57


def floor_for(t: dict) -> float:
    """The contrast floor this text element must clear (WCAG-shaped size allowance)."""
    return MIN_CONTRAST_LARGE if t["large"] else MIN_CONTRAST


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir")
    ap.add_argument("--page", type=int, default=None)
    ap.add_argument("--dump-contrast", action="store_true",
                    help="print every measured text element instead of only failures")
    a = ap.parse_args()
    proj = Path(a.project_dir)
    deck = proj / "deck.html"
    if not deck.is_file():
        print(f"ERROR: {deck} not found — run build_deck.py first", file=sys.stderr)
        return 2
    browser = find_browser()
    if not browser:
        print("ERROR: no Chrome/Edge/Chromium found", file=sys.stderr)
        return 2

    head, sections = split_pages(deck.read_text(encoding="utf-8"))
    if not sections:
        print("ERROR: no slides in deck.html", file=sys.stderr)
        return 2
    flat = "<style>.stage{margin:0}.slide{margin:0}</style>"

    if a.page is not None and not 1 <= a.page <= len(sections):
        print(f"ERROR: --page {a.page} out of range (deck has {len(sections)} pages)",
              file=sys.stderr)
        return 2

    findings: dict[str, list] = {}
    low: dict[str, list] = {}
    measured = 0
    targets = [(a.page, sections[a.page - 1])] if a.page else list(enumerate(sections, 1))
    kwargs = {}
    if sys.platform.startswith("win"):
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW (ADR-054)
    with tempfile.TemporaryDirectory() as td:
        for i, sec in targets:
            page = Path(td) / f"p{i:02d}.html"
            page.write_text(head + flat + sec + PROBE_JS + "</div></body></html>", encoding="utf-8")
            r = subprocess.run(
                [browser, *CHROME_BASE, "--window-size=1280,720", "--virtual-time-budget=3000",
                 "--dump-dom", page.resolve().as_uri()],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=120, **kwargs)
            m = re.search(r'<script type="application/json" id="__probe__">(.*?)</script>',
                          r.stdout, re.S)
            if not m:
                print(f"ERROR: probe script produced no report for page {i}", file=sys.stderr)
                return 2
            payload = json.loads(m.group(1))
            hits, texts = payload["o"], payload["c"]
            if hits:
                findings[str(i)] = hits
                for h in hits:
                    print(f"OVERFLOW p{i}: {h['kind']} {h['el']} +{h['px']}px  「{h['text']}」")
            measured += len(texts)
            if a.dump_contrast:
                for t in sorted(texts, key=lambda t: t["ratio"]):
                    # single-char flags (never blank) so this line stays machine-parseable
                    flags = ("L" if t["large"] else "-") + ("I" if t["imaged"] else "-")
                    print(f"  p{i} {t['ratio']:6.2f}:1 {flags} {t['fg']} on {t['bg']} "
                          f"{t['size']:>3}px {t['el']}  「{t['text']}」")
            # A background-image ancestor means the painted backdrop is not a flat
            # colour, so the composited value we measured is not the real one —
            # report it in the dump but never fail the gate on a guess.
            bad = [t for t in texts if t["ratio"] < floor_for(t) and not t["imaged"]]
            if bad:
                low[str(i)] = bad
                for t in bad:
                    print(f"CONTRAST p{i}: {t['ratio']}:1 < {floor_for(t)} "
                          f"{t['el']} {t['fg']} on {t['bg']} {t['size']}px  「{t['text']}」")

    report_f = proj / "qa_report.json"
    report = {}
    if report_f.is_file():
        try:
            report = json.loads(report_f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            report = {}
    probed = [i for i, _ in targets]
    report["overflow"] = {"pages_probed": probed, "findings": findings}
    report["contrast"] = {"pages_probed": probed, "threshold": MIN_CONTRAST,
                          "threshold_large": MIN_CONTRAST_LARGE,
                          "elements_measured": measured, "findings": low}
    report_f.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    n_over = sum(len(v) for v in findings.values())
    n_low = sum(len(v) for v in low.values())
    print(f"probe: {len(targets)} pages · {n_over} overflow · {n_low} low-contrast "
          f"(of {measured} text elements, floor {MIN_CONTRAST}:1 / {MIN_CONTRAST_LARGE}:1 large)")
    return 1 if (findings or low) else 0


if __name__ == "__main__":
    sys.exit(main())
