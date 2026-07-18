#!/usr/bin/env python3
"""deckcraft layout extractor (P2b) — deck.html → layout.json for editable pptx.

Renders each page in headless Chrome (same per-page isolation as
probe_overflow.py — the isolated page drops the screen-fit <script>, so every
getBoundingClientRect is at scale 1 on an exact 1280x720 canvas) and injects a
translation script that walks each `.slide` subtree turning elements into
positioned primitives:

  - text   : a text box (runs preserve <br> breaks + inline colored spans)
  - rect   : a filled / bordered rectangle (rounded via border-radius)
  - image  : an <img> (translated to a picture, still swappable in PowerPoint)
  - raster : an element we cannot faithfully translate (inline SVG icon, CSS
             background-image / gradient) — flagged for the caller to rasterize
             from the page screenshot; its subtree is NOT descended into, so the
             baked-in image is the honest, non-editable representation.

Geometry stays in CSS px here (canvas 1280x720); the Node assembler owns the
px→inch (96 px/in) and px→pt (×0.75) mapping so there is one conversion SSOT.

    python3 extract_layout.py <project_dir> [--page N]   # prints layout.json to stdout

Import:  from extract_layout import extract   # returns the layout dict
Exit 0 = ok, 2 = setup problem.
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

# Injected mid-body (like probe): runs on `load` so images/fonts have settled,
# then serializes the element list into a <script id="__layout__"> tag that
# --dump-dom hands back to Python.
EXTRACT_JS = r"""
<script>
(function(){
function measure(){
  var slide = document.querySelector('.slide');
  if(!slide){ emit({error:'no .slide'}); return; }
  var sb = slide.getBoundingClientRect();
  var INLINE = {span:1,b:1,strong:1,i:1,em:1,a:1,br:1,small:1,code:1,sub:1,
                sup:1,mark:1,u:1,abbr:1,time:1,label:1,wbr:1};
  function round(n){ return Math.round(n * 10) / 10; }
  function hex(c){
    // "rgb(r,g,b)" / "rgba(r,g,b,a)" / modern "rgb(r g b / a)" -> {hex, alpha};
    // null when fully transparent. Split on comma, whitespace OR slash so the
    // space-separated form is not silently misparsed (adversarial-review L5).
    var m = /rgba?\(([^)]+)\)/.exec(c || '');
    if(!m) return null;
    var p = m[1].replace(/\//g, ' ').split(/[\s,]+/).filter(function(x){ return x.length; });
    if(p.length < 3) return null;
    var a = p.length > 3 ? parseFloat(p[3]) : 1;
    if(a === 0) return null;
    function h(n){ n = Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16);
                   return n.length < 2 ? '0'+n : n; }
    return { hex: (h(p[0])+h(p[1])+h(p[2])).toUpperCase(), alpha: a };
  }
  function relBox(r){
    return { x: round(r.left - sb.left), y: round(r.top - sb.top),
             w: round(r.width), h: round(r.height) };
  }
  function box(el){ return relBox(el.getBoundingClientRect()); }
  function opacityOf(cs){ var o = parseFloat(cs.opacity); return isNaN(o) ? 1 : o; }
  function alignOf(cs){
    var a = cs.textAlign;
    if(a === 'start') return 'left';
    if(a === 'end') return 'right';
    return a || 'left';
  }
  function isTextLeaf(el){
    if(!(el.textContent || '').trim()) return false;
    for(var i = 0; i < el.children.length; i++){
      if(!INLINE[el.children[i].tagName.toLowerCase()]) return false;
    }
    return true;
  }
  function textLeafCount(el){
    // how many editable text boxes this subtree WOULD have produced — used so a
    // rasterized element honestly reports the editable text it swallows, not "1"
    if(isTextLeaf(el)) return 1;
    var n = 0;
    for(var i = 0; i < el.children.length; i++) n += textLeafCount(el.children[i]);
    return n;
  }
  function styledRun(text, cs){
    // one run carries its OWN font size / color / weight / opacity so an inline
    // caption span (smaller + dimmer than its container) survives (review H1/M2)
    var col = hex(cs.color);
    return { text: text, color: col ? col.hex : '000000',
             bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
             italic: cs.fontStyle === 'italic',
             fontPx: parseFloat(cs.fontSize) || 16,
             opacity: opacityOf(cs) };
  }
  function runsOf(root){
    // recurse the inline subtree so nested emphasis (<span><b>…) keeps its own
    // style; preserve <br> breaks; collapse whitespace per text node
    var runs = [];
    function walkInline(node){
      for(var i = 0; i < node.childNodes.length; i++){
        var n = node.childNodes[i];
        if(n.nodeType === 3){
          var t = (n.nodeValue || '').replace(/\s+/g, ' ');
          if(t.length){
            var pcs = getComputedStyle(node);
            runs.push(styledRun(pcs.textTransform === 'uppercase' ? t.toUpperCase() : t, pcs));
          }
        } else if(n.nodeType === 1){
          if(n.tagName.toLowerCase() === 'br') runs.push({ break: true });
          else walkInline(n);
        }
      }
    }
    walkInline(root);
    while(runs.length && !runs[0].break && !(runs[0].text||'').trim()) runs.shift();
    while(runs.length && !runs[runs.length-1].break &&
          !(runs[runs.length-1].text||'').trim()) runs.pop();
    return runs;
  }
  var out = [];
  function pushText(box, runs, cs){
    // inset by padding so text sits at the CONTENT box, not the border box (M5)
    var pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0,
        pr = parseFloat(cs.paddingRight) || 0, pb = parseFloat(cs.paddingBottom) || 0;
    // did the browser lay this out on a single line? if so PowerPoint must NOT
    // re-wrap it — its substituted font is a hair wider, so a one-line number/
    // title/label would otherwise wrap ("01" → "0"/"1"). Keep wrap only for text
    // the browser itself already broke across lines. (review M4)
    var fpx = parseFloat(cs.fontSize) || 16;
    var lh = parseFloat(cs.lineHeight) || fpx * 1.35;
    var singleLine = (box.h - pt - pb) < lh * 1.6;
    out.push({ type:'text',
               box: { x: round(box.x + pl), y: round(box.y + pt),
                      w: round(Math.max(box.w - pl - pr, 1)),
                      h: round(Math.max(box.h - pt - pb, 1)) },
               runs: runs, wrap: !singleLine,
               fontFamily: (cs.fontFamily||'').split(',')[0].replace(/["']/g,'').trim(),
               fontPx: fpx, align: alignOf(cs),
               lineHeightPx: parseFloat(cs.lineHeight) || 0,
               letterSpacingPx: parseFloat(cs.letterSpacing) || 0 });
  }
  function pushBorders(cs, b){
    // per-side border rects — reproduces single-side accent bars / dividers that a
    // uniform-only rule dropped (review M1). Each visible side becomes a thin rect.
    function side(w, c, x, y, ww, hh){
      var pw = parseFloat(w) || 0;
      if(pw < 1 || ww < 1 || hh < 1) return;
      var col = hex(c);
      if(!col) return;
      out.push({ type:'rect', box:{ x:round(x), y:round(y), w:round(ww), h:round(hh) },
                 fill: col.hex, fillAlpha: col.alpha, line: null, radius: 0 });
    }
    var wt = parseFloat(cs.borderTopWidth) || 0, wb = parseFloat(cs.borderBottomWidth) || 0,
        wl = parseFloat(cs.borderLeftWidth) || 0, wr = parseFloat(cs.borderRightWidth) || 0;
    side(wt, cs.borderTopColor,    b.x,           b.y,             b.w, wt);
    side(wb, cs.borderBottomColor, b.x,           b.y + b.h - wb,  b.w, wb);
    side(wl, cs.borderLeftColor,   b.x,           b.y,             wl,  b.h);
    side(wr, cs.borderRightColor,  b.x + b.w - wr, b.y,            wr,  b.h);
  }
  function walk(el){
    var cs = getComputedStyle(el);
    if(cs.display === 'none' || cs.visibility === 'hidden' || opacityOf(cs) === 0) return;
    var b = box(el);
    if(b.w < 2 || b.h < 2) return;
    var tag = el.tagName.toLowerCase();
    if(tag === 'svg'){ out.push({ type:'raster', box:b, tag:'svg', textLost:0 }); return; }
    if(tag === 'img'){
      var isrc = el.getAttribute('src') || '';
      // only data-URI images embed directly (and stay swappable in PowerPoint); a
      // remote/relative src was fetched+rendered by Chrome, so bake it from the
      // screenshot (honest non-editable) instead of handing the assembler a path
      // it cannot resolve (which would drop the image silently)
      if(isrc.slice(0, 5) === 'data:') out.push({ type:'image', box:b, src:isrc });
      else out.push({ type:'raster', box:b, tag:'img', textLost:0 });
      return;
    }
    if(cs.backgroundImage && cs.backgroundImage !== 'none'){
      // rasterizing swallows the whole subtree — count the editable text it costs
      // so the delivery report can disclose it honestly (see export_deck NOTE)
      out.push({ type:'raster', box:b, tag:'bg-image', textLost: textLeafCount(el) }); return;
    }
    var op = opacityOf(cs);
    var bg = hex(cs.backgroundColor);
    var radius = parseFloat(cs.borderTopLeftRadius) || 0;
    // uniform + rounded border stays a single rounded outline ON the fill rect
    // (square corners from 4 side-rects would look wrong); every other border case
    // → per-side rects so single-side accent bars / dividers survive (review M1)
    var uniform = cs.borderTopWidth === cs.borderRightWidth &&
                  cs.borderTopWidth === cs.borderBottomWidth &&
                  cs.borderTopWidth === cs.borderLeftWidth &&
                  cs.borderTopColor === cs.borderRightColor &&
                  cs.borderTopColor === cs.borderBottomColor &&
                  cs.borderTopColor === cs.borderLeftColor;
    var bw = parseFloat(cs.borderTopWidth) || 0, bcol = hex(cs.borderTopColor);
    var uniformRounded = uniform && bw >= 1 && !!bcol && radius > 0;
    if(bg || uniformRounded){
      var rect = { type:'rect', box:b, fill: bg ? bg.hex : null,
                   fillAlpha: bg ? bg.alpha * op : 0, radius: round(radius), line: null };
      if(uniformRounded) rect.line = { color: bcol.hex, width: round(bw) };
      out.push(rect);
    }
    if(!uniformRounded) pushBorders(cs, b);
    if(isTextLeaf(el)){
      var runs = runsOf(el);
      if(runs.length) pushText(b, runs, cs);
      return; // a text leaf's inline children are already captured as runs
    }
    for(var i = 0; i < el.childNodes.length; i++){
      var n = el.childNodes[i];
      if(n.nodeType === 1) walk(n);
      else if(n.nodeType === 3 && (n.nodeValue||'').trim()){
        // loose text node directly under a non-leaf container — captured via a
        // Range so it is not silently dropped (review H2)
        var rng = document.createRange(); rng.selectNodeContents(n);
        var rr = rng.getBoundingClientRect();
        if(rr.width >= 2 && rr.height >= 2){
          pushText(relBox(rr),
                   [styledRun((n.nodeValue).replace(/\s+/g,' ').trim(), cs)], cs);
        }
      }
    }
  }
  for(var i = 0; i < slide.children.length; i++) walk(slide.children[i]);
  var scs = getComputedStyle(slide);
  // solid slide background (incl. .slide[data-dark]{background:var(--c-primary)})
  // is captured here; a gradient/image slide background is E4-forbidden by
  // validate_deck, so a solid backgroundColor is the only case that reaches here
  var sbg = hex(scs.backgroundColor);
  emit({ background: sbg ? sbg.hex : 'FFFFFF',
         color: (hex(scs.color) || {hex:'000000'}).hex,
         elements: out });
}
function emit(obj){
  var node = document.createElement('script');
  node.type = 'application/json'; node.id = '__layout__';
  // Escape every less-than sign to its JSON unicode form so element text containing
  // a literal closing-script tag can't prematurely close this JSON block in
  // --dump-dom (same guard as probe_overflow; keep the literal tag OUT of this
  // comment — it would itself close this inlined script mid-parse).
  node.textContent = JSON.stringify(obj).split(String.fromCharCode(60)).join(String.fromCharCode(92) + 'u003c');
  document.body.appendChild(node);
}
window.addEventListener('load', measure);
})();
</script>
"""


def extract(proj: Path, browser: str, pages: list[int] | None = None) -> dict:
    """Render each page and return the layout dict. Raises SystemExit(2) on setup
    problems. `pages` (1-based) limits which pages are extracted."""
    deck = proj / "deck.html"
    head, sections = split_pages(deck.read_text(encoding="utf-8"))
    if not sections:
        raise SystemExit("ERROR: no slides in deck.html")
    flat = "<style>.stage{margin:0}.slide{margin:0}</style>"
    targets = ([(p, sections[p - 1]) for p in pages] if pages
               else list(enumerate(sections, 1)))
    kwargs = {}
    if sys.platform.startswith("win"):
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW (ADR-054)

    result_pages: list[dict] = []
    with tempfile.TemporaryDirectory() as td:
        for i, sec in targets:
            page = Path(td) / f"p{i:02d}.html"
            page.write_text(head + flat + sec + EXTRACT_JS + "</div></body></html>",
                            encoding="utf-8")
            r = subprocess.run(
                [browser, *CHROME_BASE, "--window-size=1280,720",
                 "--virtual-time-budget=3000", "--dump-dom", page.resolve().as_uri()],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=120, **kwargs)
            m = re.search(r'<script type="application/json" id="__layout__">(.*?)</script>',
                          r.stdout, re.S)
            if not m:
                raise SystemExit(f"ERROR: extractor produced no report for page {i}")
            data = json.loads(m.group(1))
            if data.get("error"):
                raise SystemExit(f"ERROR: page {i}: {data['error']}")
            data["index"] = i
            result_pages.append(data)
    return {"canvas": {"w": 1280, "h": 720}, "pages": result_pages}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir")
    ap.add_argument("--page", type=int, default=None)
    a = ap.parse_args()
    proj = Path(a.project_dir)
    if not (proj / "deck.html").is_file():
        print(f"ERROR: {proj / 'deck.html'} not found — run build_deck.py first",
              file=sys.stderr)
        return 2
    browser = find_browser()
    if not browser:
        print("ERROR: no Chrome/Edge/Chromium found", file=sys.stderr)
        return 2
    layout = extract(proj, browser, [a.page] if a.page else None)
    print(json.dumps(layout, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
