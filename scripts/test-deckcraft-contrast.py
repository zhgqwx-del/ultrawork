#!/usr/bin/env python3
"""Calibration + regression guard for the deckcraft contrast gate (discussions/052).

    python3 scripts/test-deckcraft-contrast.py

The gate lives in skills/builtin/deckcraft/scripts/probe_overflow.py: it measures the
computed foreground colour of every text-owning element against its *composited*
background in real headless Chrome, and fails below a calibrated floor. This file
holds it to the acceptance criteria in docs/discussions/052 §六:

  1. the real defect reproduces (on-dark light text on a light card, ~1.1:1);
  2. no false positives — all four shipped examples stay clean;
  3. [data-dark] pages are resolved to their dark backdrop, not to white;
  4. the thresholds behave at the boundary, including the large-text allowance;
  5. deliberately non-gateable paint (transparent glyphs, image backdrops) is skipped.

It also cross-checks the injected JS luminance math against an independent Python
implementation of the same WCAG formula, so a silent regression in either is caught.

Lives OUTSIDE skills/builtin/ so it is not packed into skills-builtin.zip. NOT in the
CI matrix (CI runs TS + cargo, and this needs Chrome) — run manually after touching
probe_overflow.py. Exit 0 = all pass, 1 = a case failed, 2 = setup problem.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "builtin" / "deckcraft"
PROBE = SKILL / "scripts" / "probe_overflow.py"
sys.path.insert(0, str(SKILL / "scripts"))
import probe_overflow as P  # noqa: E402

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""))


# ---------------------------------------------------------------- WCAG, in Python
# Deliberately a second implementation of the same formula the probe injects as JS.
# If these two ever disagree, one of them is wrong and the gate is untrustworthy.
def _lin(byte: float) -> float:
    x = byte / 255
    return x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def ratio(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def gray_for_ratio_on_white(target: float) -> str:
    """The grey whose contrast against #FFFFFF is closest to `target`."""
    want = 1.05 / target - 0.05                      # required relative luminance
    v = 1.055 * (want ** (1 / 2.4)) - 0.055 if want > 0.0031308 else want * 12.92
    byte = max(0, min(255, round(v * 255)))
    return "#{0:02x}{0:02x}{0:02x}".format(byte)


# ---------------------------------------------------------------- fixture deck
# Structural CSS copied from a real shipped deck.html so fixtures behave exactly like
# generated decks (token names, .slide box, the [data-dark] inversion rule).
HEAD = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>contrast fixtures</title>
<style>
:root{
  --c-bg:#F6F8FA; --c-bg2:#E8EDF2; --c-primary:#1B3A57; --c-accent:#0E7490;
  --c-muted:#5A6B7B; --c-text:#15202B; --c-on-dark:#F3F8FC;
  --fs-h2:28px; --fs-body:21px; --fs-caption:14px;
}
*{margin:0;padding:0;box-sizing:border-box;font-synthesis:none}
html,body{background:#3a3a3a}
body{font-family:sans-serif;color:var(--c-text)}
.stage{width:1280px;margin:0 auto}
.slide{width:1280px;height:720px;background:var(--c-bg);overflow:hidden;position:relative;padding:64px;margin:24px 0}
.slide[data-dark]{background:var(--c-primary);color:var(--c-on-dark)}
h2{font-size:var(--fs-h2);font-weight:700;line-height:1.3}
p{font-size:var(--fs-body);font-weight:300;line-height:1.65}
</style>
</head>
<body>
<div class="stage" id="stage">
"""


def slide(body: str, dark: bool = False) -> str:
    return f'<section class="slide"{" data-dark" if dark else ""}>{body}</section>\n'


def build(project: Path, sections: list[str]) -> None:
    project.mkdir(parents=True, exist_ok=True)
    (project / "deck.html").write_text(
        HEAD + "".join(sections) + "</div></body></html>", encoding="utf-8")


DUMP_RE = re.compile(
    r"p(\d+)\s+([\d.]+):1\s+([L-])([I-])\s+(#[0-9a-f]{6}) on (#[0-9a-f]{6})\s+"
    r"(\d+)px\s+(\S+)\s+「(.*)」")


def run_probe(project: Path, dump: bool = False) -> tuple[int, str]:
    """Probe `project`, retrying once past a Chrome launch stall.

    One full pass of this suite launches ~40 headless Chromes back to back, and under
    that contention a launch occasionally blows probe_overflow.py's own 120s per-page
    timeout. That is the harness stacking work, not the gate: probing any single deck
    standalone is stable (verified 3/3 on the example that flaked here), and real use
    probes one 7-14 page deck at a time. Retry rather than relax the shipped timeout.
    """
    cmd = [sys.executable, str(PROBE), str(project)]
    if dump:
        cmd.append("--dump-contrast")
    for attempt in (1, 2):
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=900)
        out = r.stdout + r.stderr
        if "TimeoutExpired" not in out or attempt == 2:
            return r.returncode, out
        print(f"       (chrome launch stalled on {project.name}, retrying once)")
    raise AssertionError("unreachable")


def measurements(out: str) -> dict[str, dict]:
    """Parse --dump-contrast lines into {label: {...}} keyed by the element's text."""
    found = {}
    for m in DUMP_RE.finditer(out):
        found[m.group(9)] = {
            "page": int(m.group(1)), "ratio": float(m.group(2)),
            "large": m.group(3) == "L", "imaged": m.group(4) == "I",
            "fg": m.group(5), "bg": m.group(6), "size": int(m.group(7)),
            "el": m.group(8),
        }
    return found


CONTRAST_RE = re.compile(r"^CONTRAST p\d+:.*「(.*)」$", re.M)


def gated(out: str) -> set[str]:
    """Labels the gate actually failed (as opposed to merely measured)."""
    return set(CONTRAST_RE.findall(out))


# ---------------------------------------------------------------- fixtures
# 1. The real defect, reproduced from the actual shipped S04 markup: a column head
#    that should be --c-primary was painted --c-on-dark and left on a --c-bg2 card.
DEFECT = slide(
    '<div style="display:flex;gap:48px;min-height:432px">'
    '<div style="flex:1;background:var(--c-bg2);padding:40px">'
    '<h2 style="color:var(--c-on-dark)">DEFECT-HEAD</h2>'
    '<p style="color:var(--c-text);margin-top:24px">DEFECT-BODY</p>'
    "</div></div>")

# 2. The same markup done right — the control that proves the gate is not just
#    failing everything on that card.
CONTROL = slide(
    '<div style="display:flex;gap:48px;min-height:432px">'
    '<div style="flex:1;background:var(--c-bg2);padding:40px">'
    '<h2 style="color:var(--c-primary)">CONTROL-HEAD</h2>'
    '<p style="color:var(--c-muted);margin-top:24px">CONTROL-MUTED</p>'
    "</div></div>")

# 3. A dark page: the identical --c-on-dark colour that was a defect on the light
#    card is correct here. Only a composited backdrop can tell these two apart.
DARK = slide('<h2 style="color:var(--c-on-dark)">DARK-HEAD</h2>'
             '<p style="color:var(--c-on-dark);margin-top:24px">DARK-BODY</p>', dark=True)

# 4. Threshold boundary, normal-size text on white.
LO, MID, HI = (gray_for_ratio_on_white(r) for r in (2.0, 2.6, 3.0))
BOUNDARY = slide(
    '<div style="background:#ffffff;padding:40px">'
    f'<p style="color:{LO}">BOUND-2.0</p>'
    f'<p style="color:{MID}">BOUND-2.6</p>'
    f'<p style="color:{HI}">BOUND-3.0</p>'
    "</div>")

# 5. The large-text allowance: same colour, two sizes. The large one is let through,
#    the body-size one is not.
LARGE = slide(
    '<div style="background:#ffffff;padding:40px">'
    f'<p style="color:{LO};font-size:40px">LARGE-2.0</p>'
    f'<p style="color:{LO};font-size:14px">SMALL-2.0</p>'
    "</div>")

# 6. Paint this gate deliberately does not judge: glyphs with no alpha (a
#    background-clip:text technique) and text over a gradient/image backdrop.
SKIPPED = slide(
    '<div style="background:#ffffff;padding:40px">'
    '<p style="color:transparent">CLIP-TEXT</p>'
    '<div style="background-image:linear-gradient(#fff,#eee);padding:20px">'
    f'<p style="color:{LO}">ON-IMAGE</p>'
    "</div></div>")


def main() -> int:
    if not PROBE.is_file():
        print(f"ERROR: {PROBE} not found", file=sys.stderr)
        return 2

    print(f"floors: normal {P.MIN_CONTRAST}:1 · large {P.MIN_CONTRAST_LARGE}:1\n")

    with tempfile.TemporaryDirectory() as td:
        dirty = Path(td) / "dirty"
        build(dirty, [DEFECT, CONTROL, DARK, BOUNDARY, LARGE, SKIPPED])
        code, out = run_probe(dirty, dump=True)
        got = measurements(out)
        hit = gated(out)

        # --- 0. the harness itself saw everything it built
        want = {"DEFECT-HEAD", "CONTROL-HEAD", "CONTROL-MUTED", "DARK-HEAD",
                "BOUND-2.0", "BOUND-2.6", "BOUND-3.0", "LARGE-2.0", "SMALL-2.0",
                "ON-IMAGE"}
        check("all fixture text elements measured", want <= set(got),
              f"missing {sorted(want - set(got))}" if not want <= set(got) else "")
        if not want <= set(got):
            print("\nprobe output was:\n" + out, file=sys.stderr)
            return 2

        # --- 1. defect reproduces
        d = got["DEFECT-HEAD"]
        check("defect: on-dark head on light card is flagged",
              d["ratio"] < P.MIN_CONTRAST_LARGE, f"{d['ratio']}:1 {d['fg']} on {d['bg']}")
        check("defect: matches the 1.1:1 measured in discussions/052",
              abs(d["ratio"] - 1.10) < 0.05, f"{d['ratio']}:1")
        check("defect: reported by the gate, not just measured", "CONTRAST p1" in out)
        check("defect: sibling body text on the same card stays clean",
              got["DEFECT-BODY"]["ratio"] > 10)

        # --- 2. control + dark page are not false positives
        check("control: correct primary head passes", got["CONTROL-HEAD"]["ratio"] > 9)
        # --c-muted on a --c-bg2 card measures 4.66:1 (discussions/052 quotes 5.16:1 for
        # the same token on the lighter --c-bg page background) — either way it is
        # deliberate styling that must clear the floor with room to spare.
        check("control: deliberate muted body passes",
              got["CONTROL-MUTED"]["ratio"] > P.MIN_CONTRAST * 1.5,
              f"{got['CONTROL-MUTED']['ratio']}:1")
        check("dark page: same on-dark colour is correct on a dark backdrop",
              got["DARK-HEAD"]["ratio"] > 9, f"{got['DARK-HEAD']['ratio']}:1")
        check("dark page: not flagged", "CONTRAST p3" not in out)

        # --- 3. composited background actually resolved (not defaulted to white)
        check("effective bg: card colour resolved on light page",
              d["bg"] == "#e8edf2", d["bg"])
        check("effective bg: section colour resolved on dark page",
              got["DARK-HEAD"]["bg"] == "#1b3a57", got["DARK-HEAD"]["bg"])

        # --- 4. thresholds behave at the boundary
        check("boundary: 2.0:1 normal text fails", got["BOUND-2.0"]["ratio"] < P.MIN_CONTRAST)
        check("boundary: 2.6:1 normal text passes", got["BOUND-2.6"]["ratio"] >= P.MIN_CONTRAST)
        check("boundary: 3.0:1 normal text passes", got["BOUND-3.0"]["ratio"] >= P.MIN_CONTRAST)
        check("large allowance: 2.0:1 large text passes",
              got["LARGE-2.0"]["large"] and got["LARGE-2.0"]["ratio"] >= P.MIN_CONTRAST_LARGE)
        check("large allowance: same colour at body size fails",
              not got["SMALL-2.0"]["large"] and got["SMALL-2.0"]["ratio"] < P.MIN_CONTRAST)
        check("large allowance: still catches the defect (1.1 << 1.8)",
              d["large"] and d["ratio"] < P.MIN_CONTRAST_LARGE)

        # --- 5. non-gateable paint is skipped
        check("skipped: transparent glyphs are not measured", "CLIP-TEXT" not in got)
        check("skipped: image backdrop is flagged as such", got["ON-IMAGE"]["imaged"])
        check("skipped: text over an image backdrop is not gated", "ON-IMAGE" not in hit,
              f"{got['ON-IMAGE']['ratio']}:1")
        check("gate fired only on the pages that deserve it",
              hit == {"DEFECT-HEAD", "BOUND-2.0", "SMALL-2.0"}, f"gated: {sorted(hit)}")

        # --- 6. JS luminance math agrees with an independent Python implementation
        drift = []
        for label, m in got.items():
            expect = ratio(m["fg"], m["bg"])
            if abs(expect - m["ratio"]) > 0.02:
                drift.append(f"{label}: js {m['ratio']} vs py {expect:.2f}")
        check("WCAG math: injected JS agrees with Python reference", not drift,
              "; ".join(drift))

        # --- 7. exit code + qa_report wiring
        check("dirty deck exits non-zero", code == 1, f"exit={code}")
        rep = json.loads((dirty / "qa_report.json").read_text(encoding="utf-8"))
        con = rep.get("contrast", {})
        check("qa_report has a contrast section", bool(con))
        check("qa_report records both thresholds",
              con.get("threshold") == P.MIN_CONTRAST
              and con.get("threshold_large") == P.MIN_CONTRAST_LARGE)
        check("qa_report counts every measured element",
              con.get("elements_measured", 0) >= len(want))
        check("qa_report findings are keyed by page", "1" in con.get("findings", {}))
        check("qa_report keeps the overflow section intact", "overflow" in rep)

        # --- 8. a deck with only the good pages is clean, exit 0
        clean = Path(td) / "clean"
        build(clean, [CONTROL, DARK])
        code2, out2 = run_probe(clean)
        check("clean deck exits 0", code2 == 0, f"exit={code2} {out2.strip()}")
        check("clean deck reports 0 low-contrast", "0 low-contrast" in out2)

    # --- 9. no false positives on anything actually shipped
    for name in ("ai-coding-pilot", "http-caching-primer",
                 "platform-migration-brief", "product-launch-showcase"):
        ex = SKILL / "examples" / name
        if not ex.is_dir():
            check(f"shipped example {name} present", False)
            continue
        code, out = run_probe(ex)
        check(f"shipped {name}: 0 findings, exit 0", code == 0, out.strip().splitlines()[-1])

    print(f"\n=== {len(PASS)} passed, {len(FAIL)} failed ===")
    if FAIL:
        print("FAILED:", FAIL)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
