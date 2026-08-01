#!/usr/bin/env python3
"""Behaviour tests for the pdf skill's scripts (discussions/059 S2).

L1 proves each declared capability runs and produces an artifact; L2 proves the
artifact is a legal PDF. Neither can say whether the numbers are RIGHT — that a
requested page 3 is page 3, that a bounding box lands on the glyphs, that a locked
file is reported as encrypted. Those claims are this file's job.

    python3 scripts/test-pdf-skill.py
    python3 scripts/test-pdf-skill.py --json

Every assertion is run twice: once against the real output of the real scripts
(must stay silent) and once against output carrying exactly the defect it hunts
(must fire). The flaws are not invented damage — each is the plausible wrong
implementation, most of all `extract-page-space-as-display`, which is the bug this
skill actually shipped for an hour before the raster caught it.

The run prints a flaw -> fired-checks matrix. "All the negative controls went red"
is not the claim being made; "the RIGHT check went red" is, and only the matrix
shows the difference.

Exit 0 = every assertion behaved, 1 = something did not.
"""
from __future__ import annotations

import argparse
import copy
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / "skills" / "builtin" / "pdf"
FIXTURES = SKILL / "fixtures"
REPORT = FIXTURES / "report-cjk.pdf"
LOCKED = FIXTURES / "locked.pdf"
LOCKED_PW = "ultrawork"
PY = sys.executable

RENDER_DPI = 100
RENDER_PAGES = [1, 3]

# ── raster thresholds ─────────────────────────────────────────────────────────
# BOX_INK: share of dark pixels under one reported box, measured on the rendered
# page. Calibrated 2026-08-01 against BOTH the synthetic fixture and a real
# document, because a synthetic-only calibration is how the L2 tofu cutoff got it
# wrong the first time (gotchas §10⑭):
#
#   deckcraft examples deck.pdf, 110 line boxes ... min 0.088, median 0.248
#   fixtures/report-cjk.pdf, word/line/block ..... min 0.042 (a sparse table block)
#   SAME boxes read in the wrong coordinate frame  0.003   <- the defect
#
# 0.02 sits between 0.003 and 0.042 and is flat across DPI 100/144/220 and all
# three granularities.
#
# Known limit, stated rather than discovered later: on a page with a dark
# background every box is "inked", so this proves a box is not on blank paper —
# not that it is on glyphs. It is decisive on light pages, which is where the
# coordinate-frame defect shows.
BOX_INK = 0.02
BOX_PAGE_FRACTION = 0.9     # share of a page's boxes that must clear BOX_INK
DARK = 200                  # grey value counted as ink (matches the L2 gate)
GRID = 6                    # page ink signature resolution for "is this that page"
SIGNATURE_TOLERANCE = 0.02


def run_script(name: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([PY, str(SKILL / "scripts" / name), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=180)


# ── raster helpers ────────────────────────────────────────────────────────────
def gray_pixmap(page_or_path, dpi: int):
    import fitz
    if isinstance(page_or_path, Path):
        pix = fitz.Pixmap(str(page_or_path))
        if pix.n > 1:
            pix = fitz.Pixmap(fitz.csGRAY, pix)
        return pix
    return page_or_path.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)


def ink_share(pix, box, scale: float) -> float:
    """Share of dark pixels inside `box` (points) of a pixmap rendered at `scale`."""
    w, h, data = pix.width, pix.height, pix.samples
    x0, y0, x1, y1 = (int(v * scale) for v in box)
    x0, y0 = max(x0, 0), max(y0, 0)
    x1, y1 = min(x1, w), min(y1, h)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    dark = total = 0
    for y in range(y0, y1):
        row = data[y * w + x0: y * w + x1]
        dark += sum(1 for v in row if v < DARK)
        total += len(row)
    return dark / total if total else 0.0


def signature(pix) -> list[float]:
    """Coarse ink map of a page, size-independent so it survives a DPI change."""
    w, h, data = pix.width, pix.height, pix.samples
    out = []
    for gy in range(GRID):
        for gx in range(GRID):
            x0, x1 = w * gx // GRID, w * (gx + 1) // GRID
            y0, y1 = h * gy // GRID, h * (gy + 1) // GRID
            dark = total = 0
            for y in range(y0, y1):
                row = data[y * w + x0: y * w + x1]
                dark += sum(1 for v in row if v < DARK)
                total += len(row)
            out.append(dark / total if total else 0.0)
    return out


# ── the assertions ────────────────────────────────────────────────────────────
CHECKS: dict[str, dict] = {}


def check(cid: str, title: str):
    def deco(fn):
        CHECKS[cid] = {"id": cid, "title": title, "fn": fn}
        return fn
    return deco


@check("V0", "the fixtures actually give every assertion something to look at")
def v0_not_vacuous(ctx: dict) -> list[str]:
    """A silent check and a check with no subjects look identical from the outside.

    L1 shipped a green C4 while zero capabilities were declared; the same shape is
    available here the moment a fixture loses a page. These are the counts each
    assertion below needs to be non-empty, asserted rather than assumed.
    """
    out = []
    pages = ctx["extract"]["json"]["pages"]
    boxes = sum(len(p["items"]) for p in pages)
    rotated = [p for p in pages if p["rotation"]]
    for label, got, need in (
            ("rendered images", len(ctx["render"]["report"]["rendered"]), 2),
            ("malformed-input cases", len(ctx["render_rejects"]), 5),
            ("extracted pages", len(pages), 3),
            ("extracted boxes", boxes, 10),
            # E2's whole discriminating power lives on a rotated page: everywhere
            # else the two frames are the same numbers and the control is a no-op.
            ("rotated pages (E2's only discriminating case)", len(rotated), 1),
            ("info reports", len([k for k in ("plain", "locked", "unlocked")
                                  if ctx["info"].get(k)]), 3)):
        if got < need:
            out.append(f"V0 only {got} {label}, need >= {need} — assertions covering "
                       f"them would pass by having nothing to check")
    return out


@check("R1", "render writes exactly the requested pages, named by SOURCE page number")
def r1_selection(ctx: dict) -> list[str]:
    out = []
    want = {f"page-{n:03d}.png" for n in ctx["render"]["requested"]}
    have = {p.name for p in sorted(Path(ctx["render"]["dir"]).glob("*.png"))}
    for missing in sorted(want - have):
        out.append(f"R1 requested page file {missing} was not written")
    for extra in sorted(have - want):
        out.append(f"R1 wrote {extra}, which no requested page maps to")
    reported = {r["page"] for r in ctx["render"]["report"]["rendered"]}
    if reported != set(ctx["render"]["requested"]):
        out.append(f"R1 summary claims pages {sorted(reported)}, "
                   f"requested {ctx['render']['requested']}")
    return out


@check("R2", "rendered pixel size follows --dpi")
def r2_dpi(ctx: dict) -> list[str]:
    out = []
    dpi = ctx["render"]["dpi"]
    for rec in ctx["render"]["report"]["rendered"]:
        f = Path(ctx["render"]["dir"]) / rec["file"]
        if not f.is_file():
            continue
        pix = gray_pixmap(f, dpi)
        for got, pts, axis in ((pix.width, rec["points"][0], "width"),
                               (pix.height, rec["points"][1], "height")):
            want = pts * dpi / 72.0
            if abs(got - want) > 1.5:
                out.append(f"R2 {rec['file']} {axis} {got}px, expected ~{want:.0f}px "
                           f"at {dpi} dpi from {pts}pt")
    return out


@check("R3", "each image is the source page it is named after")
def r3_identity(ctx: dict) -> list[str]:
    import fitz
    out = []
    doc = fitz.open(REPORT)
    with doc:
        for rec in ctx["render"]["report"]["rendered"]:
            f = Path(ctx["render"]["dir"]) / rec["file"]
            if not f.is_file():
                continue          # R1 owns "the file is missing"
            want = signature(gray_pixmap(doc[rec["page"] - 1], ctx["render"]["dpi"]))
            got = signature(gray_pixmap(f, ctx["render"]["dpi"]))
            drift = max(abs(a - b) for a, b in zip(want, got))
            if drift > SIGNATURE_TOLERANCE:
                out.append(f"R3 {rec['file']} does not look like source page "
                           f"{rec['page']} (ink map differs by {drift:.3f})")
    return out


@check("R4", "malformed page ranges and DPI are refused, not silently repaired")
def r4_rejects(ctx: dict) -> list[str]:
    return [f"R4 {label}: exited {code}, expected a non-zero refusal"
            for label, code in ctx["render_rejects"].items() if code == 0]


@check("R5", "a locked document is refused without a password, and nothing is written")
def r5_locked(ctx: dict) -> list[str]:
    out = []
    if ctx["locked_render"]["exit"] == 0:
        out.append("R5 rendering a password-protected file exited 0")
    if ctx["locked_render"]["files"]:
        out.append(f"R5 refused the locked file but still wrote "
                   f"{ctx['locked_render']['files']}")
    return out


def _boxes(page_rec: dict):
    for it in page_rec["items"]:
        yield it


def degenerate(box) -> bool:
    return box[2] <= box[0] or box[3] <= box[1]


@check("E1", "every box is non-degenerate and inside its own frame")
def e1_frames(ctx: dict) -> list[str]:
    out = []
    for p in ctx["extract"]["json"]["pages"]:
        pw, ph = p["size"]
        mw, mh = p["mediabox"]
        for it in _boxes(p):
            for key, (fw, fh) in (("bbox", (mw, mh)), ("bbox_display", (pw, ph))):
                b = it[key]
                if degenerate(b):
                    out.append(f"E1 page {p['number']} {key} {b} for {it['text'][:12]!r} "
                               f"is degenerate")
                elif b[0] < -1 or b[1] < -1 or b[2] > fw + 1 or b[3] > fh + 1:
                    out.append(f"E1 page {p['number']} {key} {b} for {it['text'][:12]!r} "
                               f"falls outside the {fw}x{fh} frame")
    return out


@check("E2", "bbox_display lands on the glyphs in the rendered page")
def e2_ink(ctx: dict) -> list[str]:
    import fitz
    out = []
    dpi, scale = 144, 2.0
    doc = fitz.open(REPORT)
    with doc:
        for p in ctx["extract"]["json"]["pages"]:
            pix = gray_pixmap(doc[p["number"] - 1], dpi)
            # Degenerate boxes are E1's finding; scoring them here would double-report
            # one defect as two.
            boxes = [it for it in _boxes(p) if not degenerate(it["bbox_display"])]
            if not boxes:
                continue
            hits = sum(1 for it in boxes
                       if ink_share(pix, it["bbox_display"], scale) >= BOX_INK)
            frac = hits / len(boxes)
            if frac < BOX_PAGE_FRACTION:
                worst = min(boxes, key=lambda it: ink_share(pix, it["bbox_display"], scale))
                out.append(f"E2 page {p['number']}: only {frac:.0%} of {len(boxes)} boxes "
                           f"cover ink (need {BOX_PAGE_FRACTION:.0%}); e.g. "
                           f"{worst['text'][:14]!r} at {worst['bbox_display']}")
    return out


@check("E3", "known text extracts back out, on the page it was written to")
def e3_text(ctx: dict) -> list[str]:
    out = []
    by_number = {p["number"]: p for p in ctx["extract"]["json"]["pages"]}
    for number, needles in ctx["extract"]["needles"].items():
        page = by_number.get(number)
        if page is None:
            out.append(f"E3 page {number} is missing from the extraction")
            continue
        joined = page["text"] + "\n" + "\n".join(it["text"] for it in _boxes(page))
        for needle in needles:
            if needle not in joined:
                out.append(f"E3 page {number} does not contain {needle!r}")
    return out


@check("E4", "the overlay keeps the source text layer byte-for-byte")
def e4_overlay(ctx: dict) -> list[str]:
    import fitz
    out = []
    src, dst = fitz.open(REPORT), fitz.open(ctx["extract"]["overlay"])
    with src, dst:
        if src.page_count != dst.page_count:
            return [f"E4 overlay has {dst.page_count} pages, source has {src.page_count}"]
        for i in range(src.page_count):
            a, b = src[i].get_text(), dst[i].get_text()
            if a != b:
                out.append(f"E4 overlay page {i + 1} text changed "
                           f"({len(a)} chars -> {len(b)})")
    return out


@check("I1", "page count and page geometry match the fixture")
def i1_geometry(ctx: dict) -> list[str]:
    out = []
    info = ctx["info"]["plain"]
    if info["page_count"] != 3:
        out.append(f"I1 page_count {info['page_count']}, fixture has 3")
    for page in info["pages"] or []:
        if abs(page["width_pt"] - 595) > 1 or abs(page["height_pt"] - 842) > 1:
            out.append(f"I1 page {page['number']} is "
                       f"{page['width_pt']}x{page['height_pt']}pt, expected 595x842")
        if page["paper"] != "A4":
            out.append(f"I1 page {page['number']} paper {page['paper']!r}, expected 'A4'")
    return out


@check("I2", "rotation is reported, and the rotated page's mediabox is not the rect")
def i2_rotation(ctx: dict) -> list[str]:
    out = []
    pages = {p["number"]: p for p in (ctx["info"]["plain"]["pages"] or [])}
    third = pages.get(3)
    if third is None:
        return ["I2 page 3 missing from the report"]
    if third["rotation"] != 90:
        out.append(f"I2 page 3 rotation {third['rotation']}, fixture stores 90")
    if third["mediabox_pt"] == [third["width_pt"], third["height_pt"]]:
        out.append("I2 page 3 mediabox equals the displayed rect — a 90-degree "
                   "rotation must make them differ, or one of the two is being "
                   "reported twice")
    for n in (1, 2):
        p = pages.get(n)
        if p and p["rotation"] != 0:
            out.append(f"I2 page {n} rotation {p['rotation']}, expected 0")
    return out


@check("I3", "encryption state is right in all three openings of the locked file")
def i3_encryption(ctx: dict) -> list[str]:
    out = []
    plain, locked, unlocked = (ctx["info"]["plain"], ctx["info"]["locked"],
                               ctx["info"]["unlocked"])
    if plain["encrypted"] or plain["locked"]:
        out.append(f"I3 the unencrypted fixture reports encrypted="
                   f"{plain['encrypted']} locked={plain['locked']}")
    if not locked["encrypted"]:
        out.append("I3 a password-protected file read WITHOUT the password reports "
                   "encrypted=false — the metadata is unreadable while locked, so "
                   "the lock itself has to count as evidence")
    if not locked["locked"]:
        out.append("I3 locked file without a password reports locked=false")
    if locked["page_count"] != 1:
        out.append(f"I3 locked file page_count {locked['page_count']}, the page tree "
                   f"is readable while locked and holds 1")
    if not unlocked["encrypted"] or unlocked["locked"]:
        out.append(f"I3 after authenticating: encrypted={unlocked['encrypted']} "
                   f"locked={unlocked['locked']}, expected true/false")
    if not (unlocked["encryption"] or "").upper().count("AES"):
        out.append(f"I3 encryption algorithm {unlocked['encryption']!r} does not name AES")
    perms = unlocked["permissions"] or {}
    if not perms.get("print") or perms.get("modify"):
        out.append(f"I3 permissions {perms} do not match the fixture "
                   f"(print allowed, modify denied)")
    return out


@check("I4", "a rejected password is an error, not a 'locked' report")
def i4_bad_password(ctx: dict) -> list[str]:
    if ctx["info"]["wrong_password_exit"] == 0:
        return ["I4 pdf_info accepted a wrong --password and exited 0"]
    return []


# ── collecting the real output ────────────────────────────────────────────────
NEEDLES = {1: ["季度经营分析报告", "Quarterly"], 2: ["科目", "营业收入"],
           3: ["第三页为横向版面"]}


def collect(work: Path) -> dict:
    render_dir, render_report = work / "png", work / "render.json"
    rr = run_script("pdf_render.py", "--in", REPORT, "--out", render_dir,
                    "--pages", ",".join(str(n) for n in RENDER_PAGES),
                    "--dpi", RENDER_DPI, "--report", render_report)
    if rr.returncode != 0:
        raise SystemExit(f"[setup] pdf_render.py failed: {rr.stdout}{rr.stderr}")

    rejects = {}
    for label, extra in (("page out of range", ["--pages", "9"]),
                         ("backwards range", ["--pages", "3-1"]),
                         ("non-numeric page", ["--pages", "one"]),
                         ("empty selection", ["--pages", ","]),
                         ("dpi out of range", ["--dpi", "5000"])):
        rejects[label] = run_script("pdf_render.py", "--in", REPORT,
                                    "--out", work / "reject", *extra).returncode

    locked_dir = work / "locked-png"
    lr = run_script("pdf_render.py", "--in", LOCKED, "--out", locked_dir)

    extract_json, overlay = work / "text.json", work / "overlay.pdf"
    r = run_script("pdf_extract.py", "--in", REPORT, "--out", extract_json,
                   "--granularity", "line", "--overlay", overlay)
    if r.returncode != 0:
        raise SystemExit(f"[setup] pdf_extract.py failed: {r.stdout}{r.stderr}")

    infos = {}
    for key, args in (("plain", ["--in", REPORT]),
                      ("locked", ["--in", LOCKED]),
                      ("unlocked", ["--in", LOCKED, "--password", LOCKED_PW])):
        out = work / f"info-{key}.json"
        res = run_script("pdf_info.py", *args, "--out", out)
        if res.returncode != 0:
            raise SystemExit(f"[setup] pdf_info.py {key} failed: {res.stdout}{res.stderr}")
        infos[key] = json.loads(out.read_text(encoding="utf-8"))
    infos["wrong_password_exit"] = run_script(
        "pdf_info.py", "--in", LOCKED, "--password", "definitely-wrong").returncode

    return {
        "render": {"dir": str(render_dir), "dpi": RENDER_DPI,
                   "requested": list(RENDER_PAGES),
                   "report": json.loads(render_report.read_text(encoding="utf-8"))},
        "render_rejects": rejects,
        "locked_render": {"exit": lr.returncode,
                          "files": sorted(p.name for p in locked_dir.glob("*"))
                          if locked_dir.is_dir() else []},
        "extract": {"json": json.loads(extract_json.read_text(encoding="utf-8")),
                    "overlay": str(overlay), "needles": NEEDLES},
        "info": infos,
    }


# ── negative controls ─────────────────────────────────────────────────────────
# Each flaw is what a plausible wrong implementation would have produced. The
# expectation is the check that MUST fire; anything else firing is either a real
# cascade (named in `cascade`) or a checker that is measuring the wrong thing.

def clone_render_dir(ctx: dict, work: Path, tag: str) -> Path:
    dst = work / f"flaw-{tag}"
    shutil.copytree(ctx["render"]["dir"], dst)
    ctx["render"]["dir"] = str(dst)
    return dst


def flaw_drop_page(ctx, work):
    d = clone_render_dir(ctx, work, "drop")
    (d / "page-003.png").unlink()
    return ctx


def flaw_sequential_names(ctx, work):
    """The tempting naming: number the outputs 1..n instead of by source page."""
    d = clone_render_dir(ctx, work, "seq")
    (d / "page-003.png").rename(d / "page-002.png")
    for rec in ctx["render"]["report"]["rendered"]:
        if rec["page"] == 3:
            rec["file"] = "page-002.png"
    return ctx


def flaw_swap_pages(ctx, work):
    d = clone_render_dir(ctx, work, "swap")
    a, b, spare = d / "page-001.png", d / "page-003.png", d / "spare"
    a.rename(spare)
    b.rename(a)
    spare.rename(b)
    return ctx


def flaw_half_dpi(ctx, work):
    import fitz
    d = clone_render_dir(ctx, work, "dpi")
    doc = fitz.open(REPORT)
    with doc:
        doc[0].get_pixmap(dpi=RENDER_DPI // 2).save(str(d / "page-001.png"))
    return ctx


def flaw_lenient_range(ctx, work):
    ctx["render_rejects"]["page out of range"] = 0
    return ctx


def flaw_renders_locked(ctx, work):
    ctx["locked_render"] = {"exit": 0, "files": ["page-001.png"]}
    return ctx


def flaw_degenerate_box(ctx, work):
    it = ctx["extract"]["json"]["pages"][0]["items"][0]
    it["bbox_display"] = [it["bbox_display"][0], it["bbox_display"][1],
                          it["bbox_display"][0], it["bbox_display"][3]]
    return ctx


def flaw_page_space_as_display(ctx, work):
    """THE defect this skill actually had: one set of coordinates, two frames."""
    for p in ctx["extract"]["json"]["pages"]:
        for it in p["items"]:
            it["bbox_display"] = list(it["bbox"])
    return ctx


def flaw_box_off_page(ctx, work):
    it = ctx["extract"]["json"]["pages"][0]["items"][0]
    it["bbox"] = [v + 5000 for v in it["bbox"]]
    return ctx


def flaw_missing_text(ctx, work):
    p = ctx["extract"]["json"]["pages"][0]
    p["text"] = p["text"].replace("季度经营分析报告", "")
    for it in p["items"]:
        it["text"] = it["text"].replace("季度经营分析报告", "")
    return ctx


def flaw_rasterized_overlay(ctx, work):
    """What "flatten it and draw on the image" produces: boxes visible, text gone."""
    import fitz
    dst = work / "flat-overlay.pdf"
    src, out = fitz.open(REPORT), fitz.open()
    with src, out:
        for page in src:
            pix = page.get_pixmap(dpi=72)
            np = out.new_page(width=page.rect.width, height=page.rect.height)
            np.insert_image(np.rect, pixmap=pix)
        out.save(str(dst))
    ctx["extract"]["overlay"] = str(dst)
    return ctx


def flaw_encrypted_false(ctx, work):
    """Deriving `encrypted` from the metadata string alone — null while locked."""
    ctx["info"]["locked"]["encrypted"] = False
    return ctx


def flaw_no_rotation(ctx, work):
    for p in ctx["info"]["plain"]["pages"]:
        p["rotation"] = 0
        p["mediabox_pt"] = [p["width_pt"], p["height_pt"]]
    return ctx


def flaw_wrong_page_count(ctx, work):
    ctx["info"]["plain"]["page_count"] = 2
    return ctx


def flaw_accepts_bad_password(ctx, work):
    ctx["info"]["wrong_password_exit"] = 0
    return ctx


def flaw_fixture_loses_the_rotated_page(ctx, work):
    """The vacuity control: drop the one page E2 can actually discriminate on.

    Without V0 this is invisible — E1/E2/E3/E4 all keep passing on the remaining
    pages and the suite still prints all-green.
    """
    ctx["extract"]["json"]["pages"] = [p for p in ctx["extract"]["json"]["pages"]
                                       if not p["rotation"]]
    ctx["extract"]["needles"] = {k: v for k, v in ctx["extract"]["needles"].items()
                                 if k != 3}
    return ctx


FLAWS = [
    ("render-drops-a-page", flaw_drop_page, {"R1"}, ""),
    # R3 deliberately does NOT fire here: the renamed file still holds page 3's
    # pixels and the summary still says page 3, so only the naming contract broke.
    # (The first draft of this table predicted a cascade that never happened —
    # a note nobody re-ran is indistinguishable from a note that is wrong.)
    ("render-names-output-sequentially", flaw_sequential_names, {"R1"}, ""),
    ("render-returns-the-wrong-page", flaw_swap_pages, {"R3"}, ""),
    ("render-ignores-dpi", flaw_half_dpi, {"R2"}, ""),
    ("render-clamps-out-of-range-pages", flaw_lenient_range, {"R4"}, ""),
    ("render-opens-a-locked-file", flaw_renders_locked, {"R5"}, ""),
    ("extract-emits-a-degenerate-box", flaw_degenerate_box, {"E1"}, ""),
    ("extract-page-space-as-display", flaw_page_space_as_display, {"E2"}, ""),
    ("extract-box-outside-the-page", flaw_box_off_page, {"E1"}, ""),
    ("extract-loses-the-title", flaw_missing_text, {"E3"}, ""),
    ("overlay-rasterizes-the-document", flaw_rasterized_overlay, {"E4"}, ""),
    ("info-reads-encrypted-from-metadata-only", flaw_encrypted_false, {"I3"}, ""),
    ("info-forgets-page-rotation", flaw_no_rotation, {"I2"}, ""),
    ("info-miscounts-pages", flaw_wrong_page_count, {"I1"}, ""),
    ("info-accepts-a-wrong-password", flaw_accepts_bad_password, {"I4"}, ""),
    ("CONTROL: fixture loses the rotated page", flaw_fixture_loses_the_rotated_page,
     {"V0"}, ""),
]


def fired(ctx: dict) -> dict[str, list[str]]:
    out = {}
    for cid, c in CHECKS.items():
        findings = c["fn"](ctx)
        if findings:
            out[cid] = findings
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    for f in (REPORT, LOCKED):
        if not f.is_file():
            print(f"[error] fixture missing: {f} (run fixtures/make_fixtures.py)",
                  file=sys.stderr)
            return 1

    results = []
    with tempfile.TemporaryDirectory(prefix="pdf-skill-test-") as td:
        work = Path(td)
        base = collect(work)

        clean = fired(base)
        results.append({"case": "real output of the real scripts", "expect": "silence",
                        "ok": not clean,
                        "detail": [f for v in clean.values() for f in v]})

        matrix = []
        for name, mutate, expected, cascade in FLAWS:
            ctx = mutate(copy.deepcopy(base), work)
            got = fired(ctx)
            unexpected = set(got) - expected
            missing = expected - set(got)
            matrix.append({"flaw": name, "expected": sorted(expected),
                           "fired": sorted(got), "cascade_note": cascade})
            detail = []
            if missing:
                detail.append(f"expected {sorted(missing)} to fire and it did not")
            if unexpected and not cascade:
                detail.append(f"unexpected checks fired: {sorted(unexpected)} — either a "
                              f"real cascade that needs documenting, or a check "
                              f"measuring the wrong thing")
            results.append({"case": f"flaw: {name}",
                            "expect": f"fires {sorted(expected)}",
                            "ok": not detail, "detail": detail,
                            "fired": sorted(got)})

    failed = [r for r in results if not r["ok"]]
    if args.json:
        print(json.dumps({"results": results, "matrix": matrix,
                          "failed": len(failed)}, ensure_ascii=False, indent=2))
        return 1 if failed else 0

    for r in results:
        print(f"{'PASS' if r['ok'] else 'FAIL'}  [{r['expect']}] {r['case']}")
        for d in r["detail"][:6]:
            print(f"      · {d}")
    print("\n[flaw -> fired] every row must light the check that owns the defect, "
          "and nothing else:")
    for m in matrix:
        extra = sorted(set(m["fired"]) - set(m["expected"]))
        note = f"   (also {', '.join(extra)}: {m['cascade_note']})" if extra else ""
        print(f"  {m['flaw']:<40} -> {', '.join(m['fired']) or '(nothing)'}{note}")
    print(f"\n[pdf-skill] {len(results) - len(failed)} passed, {len(failed)} failed, "
          f"{len(CHECKS)} assertions")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
