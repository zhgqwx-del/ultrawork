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

# stdout must be UTF-8 on every platform, and on Windows a CAPTURED stdout is not:
# it is encoded in the machine's ANSI code page, and Python only defaults to UTF-8
# from 3.15 (PEP 686). This gate prints Chinese (the strings it asserts on are the
# skill's own Chinese output), so without these lines it exits 1 with
# UnicodeEncodeError on a Windows dev machine — reproducible anywhere with
# PYTHONIOENCODING=cp1252, which is how it was found. The other gates in this
# directory each carry the same block; these three deckcraft ones never did,
# and deckcraft's gates are NOT in CI, so only a real Windows machine would have
# hit it.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "builtin" / "deckcraft"
PROBE = SKILL / "scripts" / "probe_overflow.py"
sys.path.insert(0, str(SKILL / "scripts"))
import probe_overflow as P  # noqa: E402
from console_encoding import configure_utf8_stdio  # noqa: E402

# This file prints '·' and echoes the probe's CJK-bracketed labels. Without this a
# Windows console on a legacy code page raises UnicodeEncodeError mid-run and the
# suite dies for a reason that has nothing to do with the gate. (probe_overflow.py
# does the same on import for the same reason.)
configure_utf8_stdio()

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


# A palette from the other end of the skill's style range: tech-dark, where the page
# background itself is dark. None of the four shipped examples is a dark-first deck, so
# without this the thresholds would only be evidenced against light palettes — and the
# skill lets the model pick its own HEX per deck, so "works on our examples" is not the
# claim that matters. Values follow references/design-styles/tech-dark.md (deep bg with
# a colour temperature, second bg half a step up, warm-white on-dark, muted lifted
# brighter than the light-scheme would use, one high-saturation accent).
DARK_HEAD = HEAD.replace(
    "--c-bg:#F6F8FA; --c-bg2:#E8EDF2; --c-primary:#1B3A57; --c-accent:#0E7490;\n"
    "  --c-muted:#5A6B7B; --c-text:#15202B; --c-on-dark:#F3F8FC;",
    "--c-bg:#0E1419; --c-bg2:#18222B; --c-primary:#22303C; --c-accent:#22D3EE;\n"
    "  --c-muted:#9FB0BE; --c-text:#F2EFEA; --c-on-dark:#F2EFEA;")


def slide(body: str, dark: bool = False) -> str:
    return f'<section class="slide"{" data-dark" if dark else ""}>{body}</section>\n'


def build(project: Path, sections: list[str], head: str = HEAD) -> None:
    project.mkdir(parents=True, exist_ok=True)
    (project / "deck.html").write_text(
        head + "".join(sections) + "</div></body></html>", encoding="utf-8")


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
#    background-clip:text technique) and text over a real BITMAP backdrop.
#    A gradient used to live here too — ADR-068 D6 made gradients measurable
#    (their colour stops can be read), so only genuinely unreadable paint is
#    exempt now. A 1x1 transparent PNG stands in for a photo.
PNG_1PX = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
           "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
SKIPPED = slide(
    '<div style="background:#ffffff;padding:40px">'
    '<p style="color:transparent">CLIP-TEXT</p>'
    f'<div style="background-image:url({PNG_1PX});padding:20px">'
    f'<p style="color:{LO}">ON-IMAGE</p>'
    "</div></div>")

# 7. Light text over an absolutely positioned dark block that is a SIBLING, not an
#    ancestor. It reads perfectly on screen. An ancestor-only backdrop walk scores it
#    against the light page background and fails it — the false positive that would
#    block a legitimate design. Requires hit-testing the real paint stack.
OVERLAY = slide(
    '<div style="position:relative;height:300px">'
    '<div style="position:absolute;inset:0;background:#12303f"></div>'
    '<p style="position:absolute;top:20px;left:20px;color:var(--c-on-dark)">OVERLAY-TEXT</p>'
    "</div>")

# 7b/8b. Rendered against DARK_HEAD. The whole page is dark, so the "correct" and
#    "defective" colours swap roles relative to the light examples: warm-white body copy
#    is right, and a same-family dark primary on the dark background is the mirror image
#    of the defect this gate was built for.
DARK_OK = slide(
    '<div class="kicker" style="color:var(--c-muted)">TD-KICKER</div>'
    '<h2 style="color:var(--c-on-dark)">TD-HEAD</h2>'
    '<p style="color:var(--c-text)">TD-BODY</p>'
    '<p style="color:var(--c-muted)">TD-MUTED</p>'
    '<p style="color:var(--c-accent);font-size:76px;font-weight:700">TD-NUM</p>'
    '<div style="background:var(--c-bg2);padding:32px;margin-top:24px">'
    '<h2 style="color:var(--c-on-dark)">TD-CARD-HEAD</h2>'
    '<p style="color:var(--c-muted)">TD-CARD-MUTED</p></div>')
DARK_BAD = slide('<h2 style="color:var(--c-primary)">TD-PRIMARY-ON-DARK</h2>')

# 8. A colour syntax the probe cannot parse must be counted and announced, never
#    silently dropped — otherwise "0 low-contrast" could mean "0 elements examined".
UNREADABLE = slide(
    '<div style="background:#ffffff;padding:40px">'
    '<p style="color:oklch(0.95 0.01 250)">OKLCH-TEXT</p>'
    '<p style="color:rgb(20 20 20 / 90%)">MODERN-RGB</p>'
    "</div>")


def main() -> int:
    if not PROBE.is_file():
        print(f"ERROR: {PROBE} not found", file=sys.stderr)
        return 2

    print(f"floors: normal {P.MIN_CONTRAST}:1 · large {P.MIN_CONTRAST_LARGE}:1\n")

    with tempfile.TemporaryDirectory() as td:
        dirty = Path(td) / "dirty"
        build(dirty, [DEFECT, CONTROL, DARK, BOUNDARY, LARGE, SKIPPED, OVERLAY, UNREADABLE])
        code, out = run_probe(dirty, dump=True)
        got = measurements(out)
        hit = gated(out)

        # --- 0. the harness itself saw everything it built
        want = {"DEFECT-HEAD", "CONTROL-HEAD", "CONTROL-MUTED", "DARK-HEAD",
                "BOUND-2.0", "BOUND-2.6", "BOUND-3.0", "LARGE-2.0", "SMALL-2.0",
                "ON-IMAGE", "OVERLAY-TEXT", "MODERN-RGB"}
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
        # The gate's own premise is that reference docs do not reliably reach the model,
        # so a failure must carry its remedy rather than assume anyone re-reads them.
        check("defect: the failure tells you how to fix it",
              "FIX:" in out and "--c-primary" in out and "data-dark" in out)
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

        # --- 5b. real paint stack, not just the ancestor chain
        ov = got["OVERLAY-TEXT"]
        check("overlay: backdrop resolved to the painted sibling block, not the ancestor",
              ov["bg"] == "#12303f", ov["bg"])
        check("overlay: light-on-dark over a positioned sibling passes (no false positive)",
              "OVERLAY-TEXT" not in hit and ov["ratio"] > 9, f"{ov['ratio']}:1")

        # --- 5c. unreadable colour syntax is counted and announced, never silent
        check("unreadable: oklch text is not silently measured", "OKLCH-TEXT" not in got)
        check("unreadable: it is announced on stdout", "unreadable-colour" in out
              and "NOT checked" in out)
        check("unreadable: modern rgb()/alpha syntax still parses",
              got["MODERN-RGB"]["ratio"] > 10, f"{got['MODERN-RGB']['ratio']}:1")

        # --- 6. JS luminance math agrees with an independent Python implementation
        #
        # Compared against the reported hex, which is an 8-bit rounding of what the gate
        # actually judged. For an opaque foreground the hex is exact and the two agree to
        # rounding noise; for an alpha-composited one (e.g. rgb(20 20 20 / 90%) lands on
        # channel 43.5) half a level of quantisation moves the ratio by ~1% — the gate is
        # right, the label is lossy. Hence a relative bound, with an absolute floor so
        # low-ratio values are still held tightly.
        drift = []
        for label, m in got.items():
            expect = ratio(m["fg"], m["bg"])
            if abs(expect - m["ratio"]) > max(0.02, 0.01 * expect):
                drift.append(f"{label}: js {m['ratio']} vs py {expect:.2f}")
        check("WCAG math: injected JS agrees with Python reference", not drift,
              "; ".join(drift))
        # The claim above is only meaningful if opaque foregrounds — where the hex is
        # exact — agree tightly. If they ever stop doing so, that IS a math bug.
        tight = [lbl for lbl, m in got.items()
                 if abs(ratio(m["fg"], m["bg"]) - m["ratio"]) <= 0.02]
        check("WCAG math: the large majority agree to within 0.02 (exact-hex cases)",
              len(tight) >= len(got) - 1, f"{len(tight)}/{len(got)}")

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
        check("qa_report records the unreadable-colour count",
              con.get("elements_unreadable_color", 0) >= 1)
        check("qa_report findings are keyed by page", "1" in con.get("findings", {}))
        check("qa_report keeps the overflow section intact", "overflow" in rep)

        # --- 8. a deck with only the good pages is clean, exit 0
        clean = Path(td) / "clean"
        build(clean, [CONTROL, DARK])
        code2, out2 = run_probe(clean)
        check("clean deck exits 0", code2 == 0, f"exit={code2} {out2.strip()}")
        check("clean deck reports 0 low-contrast", "0 low-contrast" in out2)

        # --- 8b. generality: a dark-first palette the calibration never saw
        dark = Path(td) / "darkpalette"
        build(dark, [DARK_OK, DARK_BAD], head=DARK_HEAD)
        code3, out3 = run_probe(dark, dump=True)
        dgot, dhit = measurements(out3), gated(out3)
        weakest = min((dgot[k]["ratio"] for k in dgot if k.startswith("TD-")
                       and k != "TD-PRIMARY-ON-DARK"), default=0)
        check("dark palette: every correct element passes (no false positive)",
              dhit == {"TD-PRIMARY-ON-DARK"}, f"gated: {sorted(dhit)}")
        check("dark palette: the weakest correct element still clears with margin",
              weakest >= P.MIN_CONTRAST * 1.5, f"weakest {weakest}:1")
        check("dark palette: dark-on-dark is caught (mirror of the light-card defect)",
              dgot["TD-PRIMARY-ON-DARK"]["ratio"] < P.MIN_CONTRAST_LARGE,
              f"{dgot['TD-PRIMARY-ON-DARK']['ratio']}:1")
        check("dark palette: deck fails as a whole", code3 == 1, f"exit={code3}")

    # --- 8b. ADR-068 D6 — a gradient backdrop is MEASURED, not exempted
    # Before D6 any background-image marked the whole stack unreadable, so every text
    # element above a gradient was skipped: waiving gradients would have silently
    # switched this gate off. Both ends of the ramp are scored and the worse one kept.
    with tempfile.TemporaryDirectory() as td:
        g = Path(td) / "grad"
        # light text over a dark→light ramp: fine at the dark end, invisible at the light
        # Sized to stay INSIDE the padded canvas: an out-of-canvas element is
        # reported as overflow and skipped by the contrast pass, so an oversized
        # fixture would measure nothing at all (cost me a debugging round).
        bad = slide('<div style="background:linear-gradient(90deg,#111111,#f5f5f5);'
                    'height:560px;padding:24px">'
                    '<h2 style="color:#f7f7f8">GRADIENT-BAD</h2></div>')
        # same text over a dark→dark ramp: legible at both ends
        ok = slide('<div style="background:linear-gradient(90deg,#111111,#2d2d2d);'
                   'height:560px;padding:24px">'
                   '<h2 style="color:#f7f7f8">GRADIENT-OK</h2></div>')
        build(g, [bad, ok])
        code, out = run_probe(g, dump=True)
        got = measurements(out)
        hit = gated(out)
        check("D6 gradient page is measured, not exempted (no `I` flag)",
              all(not m["imaged"] for m in got.values()),
              f"imaged flags: {[k for k, m in got.items() if m['imaged']]}")
        check("D6 light text on a dark→light ramp is judged by the LIGHT end",
              "GRADIENT-BAD" in hit and got["GRADIENT-BAD"]["ratio"] < P.MIN_CONTRAST_LARGE,
              f"{got.get('GRADIENT-BAD', {}).get('ratio')}:1 bg={got.get('GRADIENT-BAD', {}).get('bg')}")
        check("D6 same text on a dark→dark ramp passes",
              "GRADIENT-OK" not in hit and got["GRADIENT-OK"]["ratio"] > 8,
              f"{got.get('GRADIENT-OK', {}).get('ratio')}:1")
        check("D6 the gradient deck fails as a whole", code == 1, f"exit={code}")

    # --- 8c. viewport self-check: the probe must refuse to measure a canvas it
    # cannot fit, rather than silently degrade to an ancestor walk below the fold
    # (ADR-068 Phase D: --window-size sets the OUTER window; 1280,720 left a
    # 1280x633 viewport and elementsFromPoint returned empty on the bottom 12%).
    src = (SKILL / "scripts" / "probe_overflow.py").read_text(encoding="utf-8")
    check("probe asks for a window far taller than the canvas",
          '"--window-size=1280,1400"' in src)
    check("probe self-checks the resulting viewport", "cannot hold the 1280x720 canvas" in src)

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
