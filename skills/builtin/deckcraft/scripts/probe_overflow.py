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
  --dump-contrast   also print every measured text element (ratio, fg, bg), not just
                    the failures — the calibration/debug view. A view flag only: the
                    exit code still reports the gate, so leaving it on cannot mask a
                    failure.

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
// Composite a list of elements (ordered bottom-most last) over an opaque white base.
// ADR-068 D6 — a gradient IS readable. Chrome normalises every colour inside a
// computed background-image to rgb()/rgba(), so the stops can be pulled out and
// each one treated as a candidate flat backdrop. Sampling both extremes and judging
// the WORSE of the two is exact, not a guess: the text really does sit over every
// stop somewhere along the gradient.
//
// Without this, allowing gradients would have switched ADR-067's contrast floor OFF
// for the whole page — `imaged` exempts every text element above an unreadable
// backdrop, and a gradient on .slide is under all of them. That is why `gradient`
// could not join E4's waivable set until this landed.
function gradientStops(bgImage){
  if (!bgImage || bgImage === 'none') return null;
  if (bgImage.indexOf('url(') >= 0) return null;      // a bitmap: not readable
  if (bgImage.indexOf('gradient(') < 0) return null;
  var found = bgImage.match(/rgba?\([^)]*\)/g) || [];
  var stops = [];
  for (var i = 0; i < found.length; i++) {
    var c = parseColor(found[i]);
    if (c) stops.push(c);
  }
  return stops.length ? stops : null;                  // syntax we cannot read
}
// `pick` selects which gradient stop to composite: 'lo' = darkest, 'hi' = lightest.
// Two passes over the same stack bracket the real painted backdrop exactly.
function compositeStack(list, pick){
  var base = { r: 255, g: 255, b: 255, a: 1 }, imaged = false;
  for (var i = list.length - 1; i >= 0; i--) {
    var el = list[i], cs = getComputedStyle(el);
    var bc = parseColor(cs.backgroundColor);
    if (bc && bc.a > 0) base = over(bc, base);
    var stops = gradientStops(cs.backgroundImage);
    if (stops) {
      var best = stops[0];
      for (var k = 1; k < stops.length; k++) {
        var lb = lum(over(stops[k], base)), lc = lum(over(best, base));
        if (pick === 'hi' ? lb > lc : lb < lc) best = stops[k];
      }
      base = over(best, base);
    } else if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      imaged = true;                                   // a bitmap or unreadable syntax
    }
    // A replaced element is a backdrop getComputedStyle cannot describe at all —
    // background-image stays 'none' for an <img>. Bracketing it white-to-black would
    // be guessing, and a guess that fails is a false positive, the costly kind here
    // (ADR-067 D3). So it stays a DECLARED blind spot: reported, never judged.
    // The layouts that do this (S11/S17/S19) say so in layouts/_index.md, and
    // visual-review R4 is the binding check on them.
    var tag = el.tagName;
    if (tag === 'IMG' || tag === 'SVG' || tag === 'VIDEO' || tag === 'CANVAS') imaged = true;
  }
  return { color: base, imaged: imaged };
}
// The background actually painted under `el`'s glyphs.
//
// Hit-testing the element's centre is what makes this correct: elementsFromPoint
// returns the whole paint stack at that point — ancestors AND anything overlapping —
// topmost first. An ancestor-only walk would miss an absolutely positioned block laid
// over the card, and would then score light-on-dark text against the card's light
// colour and fail a page that reads perfectly (a false positive, the costly kind here).
// We keep everything from `el` downwards; anything above it is painted over the text,
// which is an occlusion question this gate does not answer.
//
// Fallback to the ancestor chain when the hit test cannot see `el` (e.g. an ancestor
// sets pointer-events:none), so the measurement degrades instead of disappearing.
function effectiveBg(el, r){
  var chain = [], n = el;
  while (n && n.nodeType === 1) { chain.push(n); n = n.parentElement; }
  var cx = Math.min(1279, Math.max(0, r.left + r.width / 2));
  var cy = Math.min(719, Math.max(0, r.top + r.height / 2));
  var stack = document.elementsFromPoint ? (document.elementsFromPoint(cx, cy) || []) : [];
  var at = stack.indexOf(el);
  var list = at < 0 ? chain : stack.slice(at);
  return { lo: compositeStack(list, 'lo'), hi: compositeStack(list, 'hi') };
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
  var out = [], con = [], unparsed = 0;
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
    // A colour syntax we cannot read (oklch/color()/lab…) must be COUNTED, not
    // silently dropped: a quiet skip would let "0 low-contrast" mean "we looked at
    // nothing", which is the one failure mode a gate must never have.
    var fgRaw = parseColor(cs.color);
    if (!fgRaw) { unparsed++; continue; }
    // Fully transparent glyphs are a paint technique (background-clip:text
    // gradients), not a legibility defect this gate can reason about.
    if (fgRaw.a === 0) continue;
    var op = cumulativeOpacity(el);
    if (op < 0.05) continue;                    // effectively not painted
    var cand = effectiveBg(el, r);
    var size = parseFloat(cs.fontSize) || 0;
    var weight = parseInt(cs.fontWeight, 10) || 400;
    // A gradient makes the backdrop a RANGE, so score both ends and keep the worse
    // one — that is the pixel a reader can actually land on. With no gradient the
    // two ends are identical and this collapses to the old single measurement.
    var worst = null;
    ['lo', 'hi'].forEach(function (k) {
      var bgc = cand[k].color;
      // Fold inherited opacity into the glyph alpha. Approximation: an ancestor's
      // opacity also fades that ancestor's own background, but in this skill's
      // templates the faded thing is the text layer, and the error is conservative
      // (a faded glyph reads as lower contrast, which is what the eye sees).
      var fg = over({ r: fgRaw.r, g: fgRaw.g, b: fgRaw.b, a: fgRaw.a * op }, bgc);
      var ratio = contrast(fg, bgc);
      if (!worst || ratio < worst.ratio) worst = { ratio: ratio, fg: fg, bg: bgc, imaged: cand[k].imaged };
    });
    con.push({ el: name, text: own.slice(0, 24),
               ratio: Math.round(worst.ratio * 100) / 100,
               fg: hex(worst.fg), bg: hex(worst.bg), size: Math.round(size),
               // WCAG "large text": >=24px, or >=18.66px when bold
               large: size >= 24 || (size >= 18.66 && weight >= 700),
               imaged: worst.imaged });
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
  node.textContent = JSON.stringify({ o: out, c: con, u: unparsed, vh: document.documentElement.clientHeight, vw: document.documentElement.clientWidth }).split(String.fromCharCode(60)).join(String.fromCharCode(92) + 'u003c');
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
    unreadable = 0
    targets = [(a.page, sections[a.page - 1])] if a.page else list(enumerate(sections, 1))
    kwargs = {}
    if sys.platform.startswith("win"):
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW (ADR-054)
    with tempfile.TemporaryDirectory() as td:
        for i, sec in targets:
            page = Path(td) / f"p{i:02d}.html"
            page.write_text(head + flat + sec + PROBE_JS + "</div></body></html>", encoding="utf-8")
            r = subprocess.run(
                # 1280x1400, not 720: --window-size sets the OUTER window, and headless
                # Chrome reserves a FIXED chrome band that the inner viewport loses —
                # measured at exactly 87px on macOS regardless of window height (720→633,
                # 1400→1313). Every elementsFromPoint below the viewport returns EMPTY, so
                # the contrast probe would fall back to an ancestor-only walk on the bottom
                # of the canvas — where footnotes, page numbers and source credits live.
                # The band is fixed per platform but its size is platform-dependent and we
                # cannot measure Windows/Linux here, so instead of trimming to a tight
                # margin we make the window so much taller than the 720 canvas that no
                # plausible band (macOS 87px, headless Linux ~0) can reach into it. Layout
                # is unaffected (the slide is a fixed 720px box; the extra height is blank
                # backdrop), so the taller window costs nothing. The viewport self-check
                # below still fails loudly if some platform ever exceeds even this.
                [browser, *CHROME_BASE, "--window-size=1280,1400", "--virtual-time-budget=3000",
                 "--dump-dom", page.resolve().as_uri()],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=120, **kwargs)
            m = re.search(r'<script type="application/json" id="__probe__">(.*?)</script>',
                          r.stdout, re.S)
            if not m:
                print(f"ERROR: probe script produced no report for page {i}", file=sys.stderr)
                return 2
            payload = json.loads(m.group(1))
            # Fail loudly rather than measure 88% of the canvas and report a clean run:
            # a viewport shorter than the slide silently disables the hit test at the
            # bottom (see the --window-size note above).
            vh, vw = payload.get("vh", 0), payload.get("vw", 0)
            if vh < 720 or vw < 1280:
                print(f"ERROR: viewport {vw}x{vh} cannot hold the 1280x720 canvas — "
                      f"elementsFromPoint would return empty below y={vh} and the "
                      f"contrast measurement would silently degrade to an ancestor "
                      f"walk. Raise --window-size.", file=sys.stderr)
                return 2
            hits, texts = payload["o"], payload["c"]
            unreadable += payload.get("u", 0)
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
                          "elements_measured": measured,
                          "elements_unreadable_color": unreadable, "findings": low}
    report_f.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    n_over = sum(len(v) for v in findings.values())
    n_low = sum(len(v) for v in low.values())
    if low:
        # The whole premise of this gate (ADR-067) is that guidance sitting in a
        # reference file does not reliably reach the model. So the failure has to
        # carry its own remedy instead of assuming anyone re-reads the docs.
        print("FIX: 上述文本在它实际所处的背景上几乎不可见。改前景色，不要改阈值——"
              "标题/栏头/表头一律 var(--c-head)（它跟随风格深浅，不用你判断）、正文用 var(--c-text)；"
              "var(--c-on-dark) 只能用在 [data-dark] 深底页内；"
              "var(--c-primary) 只作背景与结构元素，不是墨色。"
              "若报的是 data-dark 页上被 opacity 压暗的脚注、且主色高饱和 —— "
              "去掉 opacity 用 100% on-dark、靠缩字号弱化，别靠降透明度。"
              "改完重跑本命令直到 exit 0。")
    if unreadable:
        # Not a gate failure (we cannot judge what we cannot read), but it must be
        # visible — otherwise "0 low-contrast" would quietly mean "0 examined".
        print(f"NOTE: {unreadable} text element(s) use a colour syntax this probe "
              f"cannot read (oklch/color()/lab…) and were NOT checked — "
              f"deck tokens should be HEX/rgb.")
    print(f"probe: {len(targets)} pages · {n_over} overflow · {n_low} low-contrast "
          f"(of {measured} text elements checked, {unreadable} unreadable-colour, "
          f"floor {MIN_CONTRAST}:1 / {MIN_CONTRAST_LARGE}:1 large)")
    return 1 if (findings or low) else 0


if __name__ == "__main__":
    sys.exit(main())
