#!/usr/bin/env python3
"""deckcraft overflow probe — physical ground truth for text/element overflow.

    python3 probe_overflow.py <project_dir> [--page N]

Renders each page in headless Chrome with an injected measuring script and
reports elements that (a) stick out of the 1280x720 canvas or (b) have content
clipped by an overflow-hidden ancestor. This upgrades the IR-level character
budget (a heuristic) with a physical gate: what Chrome actually lays out.

  --page N   probe only page N (used by the first-page gate)

Output: one line per finding + a JSON summary appended to <project>/qa_report.json
(section "overflow"). Exit 0 = clean, 1 = overflow found, 2 = setup problem.
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

PROBE_JS = """
<script>
(function(){
  var out = [];
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
  }
  var node = document.createElement('script');
  node.type = 'application/json'; node.id = '__probe__';
  node.textContent = JSON.stringify(out);
  document.body.appendChild(node);
})();
</script>
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir")
    ap.add_argument("--page", type=int, default=None)
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

    findings: dict[str, list] = {}
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
                capture_output=True, text=True, timeout=120, **kwargs)
            m = re.search(r'<script type="application/json" id="__probe__">(.*?)</script>',
                          r.stdout, re.S)
            if not m:
                print(f"ERROR: probe script produced no report for page {i}", file=sys.stderr)
                return 2
            hits = json.loads(m.group(1))
            if hits:
                findings[str(i)] = hits
                for h in hits:
                    print(f"OVERFLOW p{i}: {h['kind']} {h['el']} +{h['px']}px  「{h['text']}」")

    report_f = proj / "qa_report.json"
    report = {}
    if report_f.is_file():
        try:
            report = json.loads(report_f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            report = {}
    report["overflow"] = {"pages_probed": [i for i, _ in targets], "findings": findings}
    report_f.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"probe-overflow: {len(targets)} pages · {sum(len(v) for v in findings.values())} findings")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
