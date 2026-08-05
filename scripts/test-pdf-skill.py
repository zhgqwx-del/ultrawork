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

# ── stdout must be UTF-8 on every platform, and on Windows it is not ──────────
# This gate prints ✅/❌ and Chinese. Windows encodes a CAPTURED stdout in the
# machine's ANSI code page and Python only defaults to UTF-8 from 3.15 (PEP 686);
# CI pins 3.11. Measured on CI: this script died with
# `UnicodeEncodeError: 'charmap' codec can't encode character '\u2705'` inside its
# own `print(json.dumps(...))`. The skills were fixed for this first and the GATES
# were missed — the same defect has two homes, and only one of them was product.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (ValueError, OSError):        # already detached / not reconfigurable
            pass


REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / "skills" / "builtin" / "pdf"
FIXTURES = SKILL / "fixtures"
REPORT = FIXTURES / "report-cjk.pdf"
LOCKED = FIXTURES / "locked.pdf"
LOCKED_PW = "ultrawork"
PY = sys.executable

RENDER_DPI = 100
RENDER_PAGES = [1, 3]

FORM = FIXTURES / "form-acroform.pdf"
FORM_FLAT = FIXTURES / "form-flat.pdf"
FORM_FILLED = FIXTURES / "form-filled.pdf"
FORM_VALUES = FIXTURES / "values-acroform.json"
FORM_PLACEMENTS = FIXTURES / "placements-flat.json"
STDOUT_BUDGET = 4096      # bytes a single call may print for a large document
SCALE_PAGES = 60          # comfortably past pdfcommon.STDOUT_ITEM_LIMIT
DOC_SPEC = FIXTURES / "document.json"
TABLE_GRID = FIXTURES / "table-grid.pdf"

# What fixtures/table-grid.pdf holds: the SAME table twice, ruled on page 1 and
# unruled on page 2.
TABLE_CELLS = [["科目", "本季度", "上年同期"], ["营业收入", "1,240", "1,103"],
               ["营业成本", "769", "702"], ["毛利", "471", "401"]]
ENC_USER_PW, ENC_OWNER_PW = "s3cret", "admin"

# A Latin-only face, used to prove the glyph-coverage refusal guards a real failure.
# `helv` is PyMuPDF's own Helvetica: present wherever PyMuPDF is, carries real
# embeddable bytes, and has no CJK glyphs. The first version of this pointed at
# /System/Library/Fonts/…/Arial.ttf and the whole suite went red on any non-macOS
# host — a check that can only run on the author's machine is not a check.
LATIN_ONLY_FONT = "helv"

# PyMuPDF ships this CJK face at ~3.5MB. A generated document that carries it
# unsubset is the failure G2 exists to catch.
FULL_FONT_BYTES = 3_000_000
DOC_MARGIN = 56

# What fixtures/form-acroform.pdf is known to contain. Spelled out here rather than
# read back from the file: an expectation derived from the artifact it checks agrees
# with itself no matter what the artifact says.
EXPECT_FIELDS = {
    "applicant": {"type": "text", "required": True, "max_length": None},
    "id_no": {"type": "text", "required": False, "max_length": 18},
    "dept": {"type": "combobox", "choices": ["财务部", "技术部", "市场部"]},
    "remark": {"type": "text", "multiline": True},
    "agree": {"type": "checkbox"},
}

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
    return run_script_from(SKILL / "scripts", name, *args)


def run_script_from(scripts: Path, name: str, *args: str) -> subprocess.CompletedProcess:
    """Same call against an arbitrary copy of the scripts — used by LIVE controls,
    which re-run the REAL entry point with the fix backed out rather than editing the
    numbers this file collected. A control that only rewrites the observed facts
    proves the assertion reads a dict, not that it would catch the defect."""
    return subprocess.run([PY, str(Path(scripts) / name), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=180)


def patched_scripts(work: Path, old: str, new: str, name: str) -> Path:
    """A copy of the skill's scripts with one edit applied.

    Raises if the anchor is not found exactly once: a control arm that silently
    failed to apply is indistinguishable from one that applied and changed nothing.
    """
    dest = work / f"patched-{name}"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(SKILL / "scripts", dest,
                    ignore=shutil.ignore_patterns("__pycache__"))
    hits = 0
    for py in dest.glob("*.py"):
        text = py.read_text(encoding="utf-8")
        if old in text:
            hits += text.count(old)
            py.write_text(text.replace(old, new), encoding="utf-8")
    if hits != 1:
        raise SystemExit(f"control {name!r}: anchor matched {hits} times, expected 1 "
                         f"— the control did not replicate the defect")
    return dest


def png_ink(path: Path) -> int:
    """Dark pixels in an image pdf_render.py actually wrote.

    ⚠️ Deliberately NOT a re-render through PyMuPDF: fitz paints widget appearance
    streams whether or not a form env exists, so measuring that way would make the
    defect this guards against invisible — the control arm and the fix would score
    the same. The subject has to be the product's own output file.
    """
    from PIL import Image
    with Image.open(path) as img:
        hist = img.convert("L").histogram()
    return sum(c for v, c in enumerate(hist) if v < DARK)


# `open_raster` initialises PDFium's form env; backing that single line out is what
# the skill shipped until 2026-08-05, and it renders a filled AcroForm identically to
# an empty one (measured: 13540 dark pixels either way at 150 dpi).
FORMS_ANCHOR = 'doc.uw_forms_note = "initialised" if doc.init_forms() else FORMS_NONE'


# The three anchors the LIVE page-op controls back out. Each must match exactly once.
CARRY_ANCHOR = "    note = carry_acroform(writer, sources)"
KEYS_ANCHOR = 'ACROFORM_KEYS = ("/DR", "/DA", "/Q", "/NeedAppearances", "/SigFlags", "/XFA")'
REFUSE_ANCHOR = "    if len(withform) > 1:"


def collect_pageops_form(scripts: Path, work: Path, tag: str) -> dict:
    """Put a FILLED form through the page ops and ask whether it is still a form.

    `pdf_form_fill.py` (not the committed fixture) is the subject on purpose: the
    fixture's /AcroForm carries only /Fields, while a real filled document also has
    /DA and /NeedAppearances — the form-level keys a viewer needs when it rebuilds an
    appearance. A control that backs those out would score identically against the
    fixture, so the fixture cannot be the subject.
    """
    filled = work / f"n5-{tag}-filled.pdf"
    r = run_script_from(scripts, "pdf_form_fill.py", "--in", FORM, "--out", filled,
                        "--values", FORM_VALUES, "--report", work / f"n5-{tag}-fill.json")
    if r.returncode != 0:
        raise SystemExit(f"[setup] pdf_form_fill.py failed: {r.stdout}{r.stderr}")

    def ink_of(pdf: Path, page: int) -> int:
        d = work / f"n5-{tag}-{pdf.stem}-png"
        rr = run_script_from(scripts, "pdf_render.py", "--in", pdf, "--out", d,
                             "--pages", str(page), "--dpi", RENDER_DPI)
        if rr.returncode != 0:
            raise SystemExit(f"[setup] pdf_render.py on {pdf.name}: {rr.stdout}{rr.stderr}")
        return png_ink(d / f"page-{page:03d}.png")

    # The form-level keys the SOURCE actually has. Asserting a hardcoded list was
    # wrong: /DA comes from the document, not from the fill, and the committed
    # fixture has none while a regenerated one does — the assertion has to be
    # "nothing the input had was lost", which is also the only thing carry can promise.
    out: dict = {"standalone_ink": ink_of(filled, 1), "ops": {},
                 "source_keys": acroform_of(filled)["keys"]}
    ops = {
        # The form page lands SECOND, so a carry that only ever looks at input one
        # would be caught too.
        "merge": (["--op", "merge", "--in", REPORT, filled], 4),
        "extract": (["--op", "extract", "--in", filled, "--pages", "1"], 1),
        "rotate": (["--op", "rotate", "--in", filled, "--pages", "1", "--degrees", "90"], 1),
    }
    for name, (args, form_page) in ops.items():
        target, rep = work / f"n5-{tag}-{name}.pdf", work / f"n5-{tag}-{name}.json"
        rr = run_script_from(scripts, "pdf_pages.py", *args, "--out", target,
                             "--report", rep)
        if rr.returncode != 0:
            raise SystemExit(f"[setup] pdf_pages.py {name}: {rr.stdout}{rr.stderr}")
        report = json.loads(rep.read_text(encoding="utf-8"))
        out["ops"][name] = {"note": report.get("acroform"),
                            "catalog": acroform_of(target),
                            # rotate turns the page, which changes the raster — the ink
                            # comparison only means something on the two that do not.
                            "ink": ink_of(target, form_page) if name != "rotate" else None}
    # A merge of two documents with no form at all must NOT invent one.
    plain, prep = work / f"n5-{tag}-plain.pdf", work / f"n5-{tag}-plain.json"
    run_script_from(scripts, "pdf_pages.py", "--op", "merge", "--in", REPORT, TABLE_GRID,
                    "--out", plain, "--report", prep)
    out["plain_note"] = json.loads(prep.read_text(encoding="utf-8")).get("acroform")
    # Two form documents in one output: same field names, so a viewer would fuse them.
    two = run_script_from(scripts, "pdf_pages.py", "--op", "merge", "--in", filled, FORM,
                          "--out", work / f"n5-{tag}-two.pdf")
    out["two_forms"] = {"exit": two.returncode, "stderr": two.stderr}
    return out


def acroform_of(pdf: Path) -> dict:
    """What the OUTPUT file's catalog says — read back from disk, not from the report.
    A report claiming success and a file that carries it are two different facts."""
    from pypdf import PdfReader

    root = PdfReader(str(pdf)).trailer["/Root"]
    acro = root.get("/AcroForm")
    if acro is None:
        return {"present": False, "fields": 0, "keys": []}
    obj = acro.get_object()
    return {"present": True, "fields": len(obj.get("/Fields", [])),
            "keys": sorted(k for k in obj.keys() if k != "/Fields")}


def collect_forms_render(scripts: Path, work: Path, tag: str) -> dict:
    """Rasterize the same paper form three ways through the real entry point."""
    out = {}
    for key, src in (("unfilled", FORM), ("filled", FORM_FILLED), ("flat", FORM_FLAT)):
        d, rep = work / f"forms-{tag}-{key}", work / f"forms-{tag}-{key}.json"
        r = run_script_from(scripts, "pdf_render.py", "--in", src, "--out", d,
                            "--dpi", RENDER_DPI, "--report", rep)
        if r.returncode != 0:
            raise SystemExit(f"[setup] pdf_render.py {key} failed: {r.stdout}{r.stderr}")
        page = d / "page-001.png"
        out[key] = {"ink": png_ink(page),
                    "forms": json.loads(rep.read_text(encoding="utf-8")).get("forms")}
    return out


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
                                  if ctx["info"].get(k)]), 3),
            ("form fields extracted", len(ctx["form"]["fields"]), 5),
            ("rejected fill attempts", len(ctx["form"]["refusals"]), 7),
            ("anchored placements (M4's only subject)",
             len([p for p in ctx["form"]["placements"] if "anchor" in p]), 2),
            # M6 can only tell colours apart if more than one verdict is present.
            ("distinct proof verdicts",
             len({f["verdict"] for f in ctx["form"]["proof_of"]}), 3),
            ("fonts in the generated document", len(ctx["create"]["report"]["fonts"]), 2),
            ("spec strings to look for", len(ctx["create"]["needles"]), 5),
            ("generated pages measured", len(ctx["create"]["page_boxes"]), 2),
            ("pages carrying a detected table", len(ctx["ops"]["tables"]["pages"]), 2),
            ("CSV files exported", len(ctx["ops"]["csv"]), 2),
            ("split parts", len(ctx["ops"]["split"]["report"]["parts"]), 2),
            # R6 compares three rasters; with fewer than three it would be comparing
            # a document against itself and could not fail.
            ("form rasters (R6's only subjects)", len(ctx["forms_render"]), 3),
            # And the empty form must actually carry ink, or the ratio R6 measures
            # is a division into a number that means nothing.
            ("ink on the empty form (R6's denominator)",
             ctx["forms_render"]["unfilled"]["ink"], 1000),
            # N5 compares three ops; with fewer it stops covering the shared exit.
            ("page ops run against a form (N5's subjects)",
             len(ctx["pageops_form"]["ops"]), 3),
            ("ink on the standalone filled form (N5's denominator)",
             ctx["pageops_form"]["standalone_ink"], 1000),
            # Without at least one form-level key on the input, N5's second half has
            # nothing to lose and its control could not fire.
            ("form-level keys on the input (N5's half-B subjects)",
             len(ctx["pageops_form"]["source_keys"]), 1)):
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


@check("M1", "form detection separates a widget form from a flat one")
def m1_detect(ctx: dict) -> list[str]:
    out = []
    acro, flat = ctx["form"]["summary_acro"], ctx["form"]["summary_flat"]
    if not acro["has_acroform"]:
        out.append("M1 the AcroForm fixture reports has_acroform=false")
    if acro["field_count"] != len(EXPECT_FIELDS):
        out.append(f"M1 field_count {acro['field_count']}, fixture has {len(EXPECT_FIELDS)}")
    # The flat form carries the same visible layout and zero widgets. This is the
    # answer a filler routes on, so getting it wrong sends every value to the wrong
    # code path rather than producing a visible error.
    if flat["has_acroform"] or flat["field_count"]:
        out.append(f"M1 the flat fixture reports has_acroform={flat['has_acroform']} "
                   f"field_count={flat['field_count']}, both must be empty")
    if acro.get("required_unfilled") != ["applicant"]:
        out.append(f"M1 required_unfilled {acro.get('required_unfilled')}, "
                   f"expected ['applicant']")
    return out


@check("M2", "field extraction reports type, choices, limits and flags")
def m2_fields(ctx: dict) -> list[str]:
    out = []
    got = {f["name"]: f for f in ctx["form"]["fields"]}
    for name, want in EXPECT_FIELDS.items():
        f = got.get(name)
        if f is None:
            out.append(f"M2 field {name!r} is missing from the extraction")
            continue
        if f["type"] != want["type"]:
            out.append(f"M2 {name}: type {f['type']!r}, expected {want['type']!r}")
        if "choices" in want and f.get("choices") != want["choices"]:
            out.append(f"M2 {name}: choices {f.get('choices')}, expected {want['choices']}")
        if "max_length" in want and f.get("max_length") != want["max_length"]:
            out.append(f"M2 {name}: max_length {f.get('max_length')}, "
                       f"expected {want['max_length']}")
        for flag in ("required", "multiline"):
            if flag in want and bool(f["flags"].get(flag)) != want[flag]:
                out.append(f"M2 {name}: flag {flag}={f['flags'].get(flag)}, "
                           f"expected {want[flag]}")
        for key in ("rect", "rect_display"):
            box = f.get(key)
            if not box or box[2] <= box[0] or box[3] <= box[1]:
                out.append(f"M2 {name}: {key} {box} is missing or degenerate")
    return out


@check("M3", "AcroForm filling writes the values and refuses the ones it cannot hold")
def m3_fill(ctx: dict) -> list[str]:
    out = []
    written = {f["name"]: f["text"] for f in ctx["form"]["fill_report"]["filled"]}
    for name, want in ctx["form"]["values"].items():
        if name == "agree":
            continue                      # checkbox value is normalised to Yes/Off
        if written.get(name) != str(want):
            out.append(f"M3 {name}: wrote {written.get(name)!r}, values file said {want!r}")
    for label, code in ctx["form"]["refusals"].items():
        if code == 0:
            out.append(f"M3 {label}: exited 0 — this value cannot be stored faithfully "
                       f"and writing it anyway produces a file that only looks filled")
    return out


@check("M4", "overlay text is placed against its anchor, not at a guessed position")
def m4_overlay(ctx: dict) -> list[str]:
    import fitz
    out = []
    placed = {f["name"]: f for f in ctx["form"]["overlay_report"]["filled"]}
    doc = fitz.open(FORM_FLAT)
    with doc:
        for item in ctx["form"]["placements"]:
            if "anchor" not in item:
                continue
            got = placed.get(item["name"])
            if got is None:
                out.append(f"M4 placement {item['name']!r} is not in the fill report")
                continue
            hits = doc[0].search_for(item["anchor"])
            if not hits:
                out.append(f"M4 anchor {item['anchor']!r} is not in the fixture at all")
                continue
            anchor, box = hits[0], fitz.Rect(got["rect"])
            if box.x0 < anchor.x1:
                out.append(f"M4 {item['name']}: placed at x={box.x0:.1f}, which is left of "
                           f"the anchor {item['anchor']!r} ending at x={anchor.x1:.1f}")
            # Same line: a value that drifts to another row lands next to the wrong
            # label, which reads as filled-in and is wrong.
            if box.y1 < anchor.y0 or box.y0 > anchor.y1:
                out.append(f"M4 {item['name']}: placed at y {box.y0:.1f}-{box.y1:.1f}, "
                           f"anchor sits at {anchor.y0:.1f}-{anchor.y1:.1f}")
    return out


@check("M5", "the overflow check finds a value that does not fit, and clears one that does")
def m5_overflow(ctx: dict) -> list[str]:
    out = []
    clean, spill = ctx["form"]["check_clean"], ctx["form"]["check_overflow"]
    if clean["overflowing"]:
        bad = [f["name"] for f in clean["fields"] if f["verdict"] == "overflows"]
        out.append(f"M5 the fitting fixture reports {clean['overflowing']} overflow(s): {bad}")
    if not clean["checked"]:
        out.append("M5 the fitting fixture measured 0 fields — a clean report with "
                   "nothing measured is not a clean report")
    hit = [f["name"] for f in spill["fields"] if f["verdict"] == "overflows"]
    if hit != ["remark"]:
        out.append(f"M5 the overlong multiline value was reported as {hit or 'nothing'}, "
                   f"expected ['remark'] — no width measurement can see this, only the "
                   f"rendered spans can")
    return out


@check("M6", "the proof sheet draws one box per field, in the colour of its verdict")
def m6_proof(ctx: dict) -> list[str]:
    import fitz
    out = []
    colors = {"fits": (0.13, 0.55, 0.24), "overflows": (0.80, 0.16, 0.16),
              "not_applicable": (0.45, 0.45, 0.45), "unknown": (0.45, 0.45, 0.45)}
    doc = fitz.open(ctx["form"]["proof_pdf"])
    with doc:
        drawn = [(fitz.Rect(d["rect"]), d.get("color")) for d in doc[0].get_drawings()
                 if d.get("color")]
        for field in ctx["form"]["proof_of"]:
            rect = fitz.Rect(field["rect"])
            near = [(r, c) for r, c in drawn
                    if abs(r.x0 - rect.x0) < 1.5 and abs(r.y0 - rect.y0) < 1.5
                    and abs(r.x1 - rect.x1) < 1.5 and abs(r.y1 - rect.y1) < 1.5]
            if not near:
                out.append(f"M6 no box drawn on {field['name']!r} at {field['rect']}")
                continue
            want = colors[field["verdict"]]
            # EVERY box at this spot must agree. `any` would accept a sheet carrying a
            # green box and a red box on the same field, which tells a reader nothing.
            wrong = [c for _, c in near
                     if max(abs(a - b) for a, b in zip(c, want)) >= 0.02]
            if wrong:
                out.append(f"M6 {field['name']!r} is {field['verdict']} but carries "
                           f"box colour(s) {wrong}, expected {want} — a proof sheet that "
                           f"colours everything the same proves nothing")
    return out


@check("G1", "generated documents EMBED their font, subset, on every page")
def g1_embedded(ctx: dict) -> list[str]:
    out = []
    report = ctx["create"]["report"]
    if not report["fonts"]:
        return ["G1 the generated document declares no fonts at all"]
    for f in report["fonts"]:
        if not f["embedded"]:
            # This is precisely what fontname="china-s" produces: the file NAMES a
            # font and hopes the reader has it. It looks perfect on the machine that
            # made it and turns into blanks anywhere else.
            out.append(f"G1 page {f['page']}: {f['basefont']} is not embedded "
                       f"(file_ext {f['file_ext']!r}) — the reader has to already own it")
        # A subset tag (ABCDEF+Name) is how a subset font announces itself; without
        # one the whole face went in.
        if "+" not in (f["basefont"] or ""):
            out.append(f"G1 page {f['page']}: {f['basefont']} carries no subset tag, "
                       f"so the entire face was embedded")
    if not report["all_embedded"]:
        out.append("G1 the font report itself says not every font is embedded")
    return out


@check("G2", "embedding is paid for by subsetting, not by a 3.5MB file")
def g2_size(ctx: dict) -> list[str]:
    got = ctx["create"]["report"]["bytes"]
    if got >= FULL_FONT_BYTES:
        return [f"G2 the generated document is {got} bytes, which is the whole "
                f"unsubset face — subset_fonts() did not run or did not take"]
    return []


def squeeze(s: str) -> str:
    """Drop every space and line break.

    Laid-out text is not the string that went in: wrapping puts a newline inside a
    CJK run and turns the space between two Latin words into one. Comparing the raw
    strings reports a defect on every paragraph long enough to wrap — which is how
    the first version of G3 failed on correct output.
    """
    return "".join(s.split())


@check("G3", "the spec's content all lands, and long documents paginate themselves")
def g3_content(ctx: dict) -> list[str]:
    out = []
    text = squeeze("\n".join(ctx["create"]["text_by_page"]))
    for needle in ctx["create"]["needles"]:
        if squeeze(needle) not in text:
            out.append(f"G3 the spec asked for {needle[:40]!r} and it is not in the output")
    if ctx["create"]["report"]["pages"] < 2:
        out.append("G3 the spec carries an explicit pagebreak but the output is 1 page")
    # No pagebreak block at all: the writer has to notice the bottom margin itself.
    if ctx["create"]["long_pages"] < 2:
        out.append(f"G3 a document of {ctx['create']['long_blocks']} paragraphs came out "
                   f"as {ctx['create']['long_pages']} page(s) — nothing paginated it")
    return out


@check("G4", "nothing the generator draws escapes the margins")
def g4_margins(ctx: dict) -> list[str]:
    out = []
    for page in ctx["create"]["page_boxes"]:
        m, w, h = DOC_MARGIN, page["width"], page["height"]
        box = page["text_bbox"]
        if box is None:
            continue
        for label, over in (("left", m - box[0]), ("top", m - box[1]),
                            ("right", box[2] - (w - m)), ("bottom", box[3] - (h - m))):
            if over > 0.5:
                out.append(f"G4 page {page['number']}: text runs past the {label} "
                           f"margin by {over:.1f}pt")
    return out


@check("G5", "a character the font cannot draw is refused, and forcing it is worse")
def g5_coverage(ctx: dict) -> list[str]:
    out = []
    cov = ctx["create"]["coverage"]
    if cov["refusal_exit"] == 0:
        out.append("G5 a document containing a character the face has no glyph for "
                   "was generated without complaint — missing glyphs raise no error "
                   "of their own, so nothing downstream would ever notice")
    if cov.get("forced_findings") is None:
        # Reported through ctx["skips"], never as a finding: a skip written into the
        # findings list makes the "real output stays silent" case fail, which is how
        # this file used to go red everywhere except macOS.
        pass
    elif not cov["forced_findings"]:
        # If forcing it through produced a perfectly good document, the refusal is
        # protecting nobody and should be dropped rather than kept as ceremony.
        out.append("G5 forcing a Latin-only face onto Chinese text produced a document "
                   "L2 accepts — then the refusal in G5's first half guards nothing")
    return out


@check("T1", "a ruled table is read exactly, and reported as reliable")
def t1_ruled(ctx: dict) -> list[str]:
    out = []
    page = next((p for p in ctx["ops"]["tables"]["pages"] if p["number"] == 1), None)
    if page is None or not page["tables"]:
        return ["T1 no table found on the ruled page at all"]
    t = page["tables"][0]
    if t["strategy"] != "lines" or not t["reliable"]:
        out.append(f"T1 the ruled page was read with strategy {t['strategy']!r} "
                   f"(reliable={t['reliable']}) — a drawn grid is evidence and should "
                   f"never fall back to guessing")
    if t["cells"] != TABLE_CELLS:
        out.append(f"T1 cells {t['cells']} != the fixture's {TABLE_CELLS}")
    if t["header"] != TABLE_CELLS[0]:
        out.append(f"T1 header {t['header']} != {TABLE_CELLS[0]}")
    return out


@check("T2", "a guessed table is never presented as if it were read")
def t2_guessed(ctx: dict) -> list[str]:
    """The unruled page holds the identical data and is detected differently.

    Measured: it comes back 7x3 with blank rows interleaved, against a real 4x3.
    The point is not that the guess is bad — it is that the report must SAY it is a
    guess, because a caller cannot tell from the cells alone.
    """
    out = []
    page = next((p for p in ctx["ops"]["tables"]["pages"] if p["number"] == 2), None)
    if page is None or not page["tables"]:
        return ["T2 nothing was detected on the unruled page — the fallback did not run"]
    t = page["tables"][0]
    if t["strategy"] == "lines" or t["reliable"]:
        out.append(f"T2 the unruled page claims strategy {t['strategy']!r} "
                   f"reliable={t['reliable']}, but it has no ruling lines to read")
    if ctx["ops"]["tables"]["unreliable_count"] < 1:
        out.append("T2 the summary counts 0 unreliable tables while one was guessed")
    return out


@check("T3", "each table is also written as CSV that reads back identically")
def t3_csv(ctx: dict) -> list[str]:
    out = []
    rows = ctx["ops"]["csv"]
    if not rows:
        return ["T3 no CSV was written"]
    if rows.get("page001-table1.csv") != TABLE_CELLS:
        out.append(f"T3 the ruled table's CSV reads back as "
                   f"{rows.get('page001-table1.csv')}, expected {TABLE_CELLS}")
    if not ctx["ops"]["csv_has_bom"]:
        out.append("T3 the CSV has no UTF-8 BOM — Excel opens Chinese CSV without one "
                   "as mojibake, which is the whole reason for exporting it")
    return out


@check("N1", "a merge keeps every input's pages, in order")
def n1_merge(ctx: dict) -> list[str]:
    out = []
    merge = ctx["ops"]["merge"]
    want = sum(len(t) for t in merge["input_texts"])
    if merge["pages"] != want:
        out.append(f"N1 merged to {merge['pages']} pages from inputs totalling {want}")
    flat = [t for texts in merge["input_texts"] for t in texts]
    for i, (before, after) in enumerate(zip(flat, merge["out_texts"]), 1):
        if squeeze(before) != squeeze(after):
            out.append(f"N1 merged page {i} does not match the input page it came from")
    return out


@check("N2", "extract/delete keep exactly the pages they name")
def n2_select(ctx: dict) -> list[str]:
    out = []
    src = ctx["ops"]["source_texts"]
    ext = ctx["ops"]["extract"]
    want = [src[n - 1] for n in ext["kept_pages"]]
    if [squeeze(t) for t in ext["out_texts"]] != [squeeze(t) for t in want]:
        out.append(f"N2 extract of pages {ext['kept_pages']} did not return those pages")
    dele = ctx["ops"]["delete"]
    want = [t for i, t in enumerate(src, 1) if i not in dele["deleted_pages"]]
    if [squeeze(t) for t in dele["out_texts"]] != [squeeze(t) for t in want]:
        out.append(f"N2 delete of pages {dele['deleted_pages']} did not leave the rest")
    return out


@check("N3", "rotation is relative, applies only to the named page, and keeps the text")
def n3_rotate(ctx: dict) -> list[str]:
    out = []
    rot = ctx["ops"]["rotate"]
    for entry in rot["report"]["rotated"]:
        expected = (entry["from"] + rot["degrees"]) % 360
        if entry["to"] != expected:
            out.append(f"N3 page {entry['page']} went {entry['from']} -> {entry['to']}, "
                       f"expected {expected} (rotation must be relative, or applying it "
                       f"twice silently does nothing)")
    named = {e["page"] for e in rot["report"]["rotated"]}
    for i, (before, after) in enumerate(zip(ctx["ops"]["source_rotations"],
                                            rot["out_rotations"]), 1):
        if i not in named and before != after:
            out.append(f"N3 page {i} was not named but its rotation changed "
                       f"{before} -> {after}")
    if [squeeze(t) for t in ctx["ops"]["source_texts"]] != \
            [squeeze(t) for t in rot["out_texts"]]:
        out.append("N3 rotating changed the text layer — /Rotate is metadata and must "
                   "not rewrite content")
    return out


@check("N4", "split covers every source page exactly once")
def n4_split(ctx: dict) -> list[str]:
    out = []
    split = ctx["ops"]["split"]
    covered = []
    for part in split["report"]["parts"]:
        covered += list(range(part["from_page"], part["to_page"] + 1))
    expected = list(range(1, len(ctx["ops"]["source_texts"]) + 1))
    if sorted(covered) != expected:
        out.append(f"N4 the parts cover pages {sorted(covered)}, source has {expected}")
    for part, texts in zip(split["report"]["parts"], split["part_texts"]):
        want = ctx["ops"]["source_texts"][part["from_page"] - 1:part["to_page"]]
        if [squeeze(t) for t in texts] != [squeeze(t) for t in want]:
            out.append(f"N4 {part['file']} does not hold source pages "
                       f"{part['from_page']}-{part['to_page']}")
    return out


@check("K1", "setting a password really encrypts, and only that password opens it")
def k1_encrypt(ctx: dict) -> list[str]:
    out = []
    enc = ctx["ops"]["encrypt"]
    if not enc["report"]["encrypted"]:
        out.append("K1 the report claims the file is not encrypted after --set-password")
    if not enc["needs_pass"]:
        out.append("K1 the written file opens with no password at all — save() will "
                   "silently produce a plain file if the arguments do not line up, so "
                   "this is the failure the whole capability turns on")
    if not enc["right_password_opens"]:
        out.append("K1 the password that was just written does not open the file")
    if enc["wrong_password_opens"]:
        out.append("K1 a wrong password opens the file")
    return out


@check("K2", "the permission bits actually restrict the USER")
def k2_permissions(ctx: dict) -> list[str]:
    out = []
    perms = ctx["ops"]["encrypt"]["user_permissions"]
    for name in ("print", "copy"):
        if not perms.get(name):
            out.append(f"K2 {name} was granted but the file denies it")
    for name in ("modify", "annotate"):
        if perms.get(name):
            out.append(f"K2 {name} was NOT granted but the file allows it — measured "
                       f"once as the owner instead of the user, which reports every "
                       f"permission granted and confirms a restriction that is not there")
    return out


@check("K3", "removing a password needs that password, and keeps the document")
def k3_decrypt(ctx: dict) -> list[str]:
    out = []
    dec = ctx["ops"]["decrypt"]
    if dec["refusal_exit"] == 0:
        out.append("K3 a password was stripped from an encrypted file WITHOUT supplying "
                   "it — that is not an unlock feature, that is removing protection "
                   "from a file the caller cannot open")
    if dec["still_encrypted"]:
        out.append("K3 the output still asks for a password after --remove-password")
    if [squeeze(t) for t in dec["out_texts"]] != \
            [squeeze(t) for t in ctx["ops"]["source_texts"]]:
        out.append("K3 decrypting changed the document's text")
    return out


@check("K4", "a restriction that cannot hold is refused, not written")
def k4_owner_trap(ctx: dict) -> list[str]:
    if ctx["ops"]["encrypt"]["owner_equals_user_exit"] == 0:
        return ["K4 a restrictive --allow was accepted with the owner password equal to "
                "the user password; everyone who can open the file is then the owner "
                "and gets every permission, so the restriction is decoration"]
    return []


@check("O1", "stdout stays small on a big document, and the detail is still written")
def o1_stdout_bounded(ctx: dict) -> list[str]:
    """Everything on stdout is read by an agent and costs context — and under Team
    delegation it crosses the boundary a second time. Measured before this was
    bounded: pdf_info.py on a 300-page document printed 82KB."""
    out = []
    big = ctx["scale"]
    if big["stdout_bytes"] > STDOUT_BUDGET:
        out.append(f"O1 pdf_info printed {big['stdout_bytes']} bytes for a "
                   f"{big['pages']}-page document (budget {STDOUT_BUDGET}) — that is "
                   f"agent context spent on per-page geometry nobody asked for")
    if big["file_pages"] != big["pages"]:
        out.append(f"O1 the --out file holds {big['file_pages']} page entries for a "
                   f"{big['pages']}-page document — trimming stdout must not lose data")
    if big["small_doc_pages_inline"] != 3:
        out.append(f"O1 a 3-page document printed {big['small_doc_pages_inline']} page "
                   f"entries inline; small documents should still answer in full")
    return out


@check("O2", "every writer refuses to overwrite its own input, with a sentence")
def o2_in_place(ctx: dict) -> list[str]:
    """PyMuPDF answers this with a raw `ValueError: save to original must be
    incremental`. The input survives, so this is about the message: an agent that
    gets a traceback instead of one actionable line has to guess."""
    out = []
    for label, res in ctx["scale"]["in_place"].items():
        if res["exit"] == 0:
            out.append(f"O2 {label} accepted an output equal to its input")
        elif "Traceback" in res["stderr"] or "error:" not in res["stderr"]:
            out.append(f"O2 {label} refused, but not with the one-line contract every "
                       f"other failure here honours: {res['stderr'].strip()[:90]}")
    return out


@check("R6", "a filled AcroForm rasterizes differently from an empty one, and the "
             "form layer's state is always reported")
def r6_forms_render(ctx: dict) -> list[str]:
    """The values a user typed into a form live in the widget's /AP appearance
    stream, and PDFium paints those only once a form env exists. Without it the two
    documents come out byte-identical — so "the form is empty" and "the layer that
    draws it is off" are the same picture, in the one channel where an artifact is
    visible inside the app at all.

    Two halves, each with its own control: the pixels must differ, AND the report
    must say which state the form layer was in (a right picture with a lying note
    is still a report nobody can act on).
    """
    out = []
    fr = ctx["forms_render"]
    unfilled, filled, flat = fr["unfilled"]["ink"], fr["filled"]["ink"], fr["flat"]["ink"]
    # Observed values go in the message whether it fires or not: a threshold with no
    # measurement next to it costs a whole run to diagnose.
    if filled < unfilled * FORMS_INK_MARGIN:
        out.append(f"R6 filled form renders {filled} dark px vs {unfilled} empty "
                   f"(ratio {filled / unfilled:.3f}, need >= {FORMS_INK_MARGIN}) — the "
                   f"field values are not being painted")
    for key, want in (("unfilled", "initialised"), ("filled", "initialised"),
                      ("flat", "none")):
        got = fr[key]["forms"]
        if got != want:
            out.append(f"R6 {key} form reports forms={got!r}, expected {want!r} "
                       f"(ink {fr[key]['ink']})")
    return out


@check("N5", "a page op keeps a form document a form document")
def n5_pageops_form(ctx: dict) -> list[str]:
    """`add_page` brings the widgets, their /V and their /AP — and leaves the
    catalog's /AcroForm behind. Every value is still in the file and the form is
    gone: viewers that paint /AP directly (Preview, Acrobat) show it, viewers that
    go through the form module (PDFium ⇒ Chrome, and this skill's own renderer)
    show an empty page. Which one you happen to open decides whether you notice.

    Three halves, three controls: the form survives · its form-level keys survive ·
    two form documents are refused rather than silently fused.
    """
    out = []
    po = ctx["pageops_form"]
    base = po["standalone_ink"]
    for name, got in po["ops"].items():
        note, cat = got["note"] or {}, got["catalog"]
        if note.get("state") != "carried":
            out.append(f"N5 {name} reports acroform {note.get('state')!r}, expected "
                       f"'carried' ({note})")
        if not cat["present"] or cat["fields"] != EXPECT_FORM_FIELDS:
            out.append(f"N5 {name} output catalog: present={cat['present']} "
                       f"fields={cat['fields']}, expected {EXPECT_FORM_FIELDS}")
        # Half B: the form-level keys, not just /Fields. Measured against what the
        # input actually had — a fixed list would demand a key the source never carried.
        lost = [k for k in po["source_keys"] if k not in cat["keys"]]
        if lost:
            out.append(f"N5 {name} lost {', '.join(lost)} — input carried "
                       f"{po['source_keys']}, output carries {cat['keys']}")
        # Half A, at the pixel level: is it still a form to the form module?
        if got["ink"] is not None and got["ink"] < base * FORMS_INK_MARGIN_OP:
            out.append(f"N5 {name} renders {got['ink']} dark px vs {base} standalone "
                       f"(ratio {got['ink'] / base:.3f}, need >= {FORMS_INK_MARGIN_OP}) "
                       f"— the values are in the file but nothing paints them")
    if (po["plain_note"] or {}).get("state") != "none":
        out.append(f"N5 merging two form-less PDFs reported "
                   f"{(po['plain_note'] or {}).get('state')!r}, expected 'none'")
    # Half C: two forms with the same field names must be refused, and the message
    # has to name them — "merge failed" alone leaves the caller nothing to do.
    tf = po["two_forms"]
    if tf["exit"] != 2:
        out.append(f"N5 merging two AcroForm documents exited {tf['exit']}, expected 2 "
                   f"— identical field names become ONE field in a viewer")
    elif "applicant" not in tf["stderr"]:
        out.append(f"N5 the two-form refusal does not name a colliding field: "
                   f"{tf['stderr'].strip()[:120]!r}")
    return out


# ── collecting the real output ────────────────────────────────────────────────
NEEDLES = {1: ["季度经营分析报告", "Quarterly"], 2: ["科目", "营业收入"],
           3: ["第三页为横向版面"]}

# What fixtures/form-acroform.pdf holds (also spelled out in EXPECT_FIELDS above).
EXPECT_FORM_FIELDS = 5
# Measured 2026-08-05: a merged/extracted form renders 22291 dark px against the
# standalone 22291 — identical, because it is the same page. The margin only has to
# separate that from the broken implementation, which scores the EMPTY form (13540).
FORMS_INK_MARGIN_OP = 0.95

# Measured 2026-08-05 at RENDER_DPI: 6555 dark px unfilled vs 8078 filled = 1.232.
# The margin sits well below that and well above 1.0, which is what the broken
# implementation scores exactly (the two renders are the same file).
FORMS_INK_MARGIN = 1.05


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

    form = collect_form(work)
    create = collect_create(work)
    ops = collect_ops(work)
    scale = collect_scale(work)

    return {
        "scale": scale,
        "form": form,
        "create": create,
        "ops": ops,
        "forms_render": collect_forms_render(SKILL / "scripts", work, "real"),
        "pageops_form": collect_pageops_form(SKILL / "scripts", work, "real"),
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


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def collect_form(work: Path) -> dict:
    """Run the whole form pipeline: detect -> extract -> fill (both ways) -> check."""
    def must(name: str, *args) -> subprocess.CompletedProcess:
        r = run_script(name, *args)
        if r.returncode != 0:
            raise SystemExit(f"[setup] {name} failed: {r.stdout}{r.stderr}")
        return r

    must("pdf_form_inspect.py", "--in", FORM, "--summary", "--out", work / "sum-acro.json")
    must("pdf_form_inspect.py", "--in", FORM_FLAT, "--summary", "--out", work / "sum-flat.json")
    must("pdf_form_inspect.py", "--in", FORM, "--out", work / "fields.json")

    must("pdf_form_fill.py", "--in", FORM, "--out", work / "filled.pdf",
         "--values", FORM_VALUES, "--report", work / "fill.json")
    must("pdf_form_fill.py", "--in", FORM_FLAT, "--out", work / "flat.pdf",
         "--values", FORM_PLACEMENTS, "--mode", "overlay", "--report", work / "flat-fill.json")

    # Values the form cannot hold faithfully. Each one is a thing a filler is tempted
    # to do anyway — truncate, coerce, paint over — and each produces a file that
    # looks filled and is wrong.
    refusals = {}
    bad = {"a field that does not exist": ({"nope": "x"}, "auto"),
           "a value outside the combobox choices": ({"dept": "后勤部"}, "auto"),
           "a value longer than /MaxLen": ({"id_no": "1" * 22}, "auto"),
           "acroform mode on a form with no fields": ({"applicant": "x"}, "acroform")}
    for i, (label, (values, mode)) in enumerate(bad.items()):
        vf = work / f"bad{i}.json"
        vf.write_text(json.dumps(values, ensure_ascii=False), encoding="utf-8")
        src = FORM_FLAT if mode == "acroform" else FORM
        refusals[label] = run_script("pdf_form_fill.py", "--in", src, "--out",
                                     work / f"bad{i}.pdf", "--values", vf,
                                     "--mode", mode).returncode
    for i, (label, item) in enumerate({
            "an anchor that is not on the page": {"text": "x", "anchor": "不存在的标签"},
            "an anchor that appears more than once": {"text": "x", "anchor": "："},
            "text that cannot fit the box it was given":
                {"name": "n", "text": "远超出方框容量的很长很长很长的中文说明文字",
                 "page": 1, "rect": [122, 256, 180, 268]}}.items()):
        vf = work / f"badp{i}.json"
        vf.write_text(json.dumps({"placements": [item]}, ensure_ascii=False), encoding="utf-8")
        refusals[label] = run_script("pdf_form_fill.py", "--in", FORM_FLAT, "--out",
                                     work / f"badp{i}.pdf", "--values", vf,
                                     "--mode", "overlay").returncode

    must("pdf_form_check.py", "--in", FORM_FILLED, "--out", work / "check-clean.json")

    # The overflowing case is built here, not committed: a fixture carrying a known
    # defect could not also be handed to the L2 artifact gate as a good sample.
    long_values = work / "long.json"
    long_values.write_text(json.dumps(
        {"applicant": "张国强",
         "remark": "入职材料齐全，包括身份证复印件、学历学位证书、离职证明、体检报告、"
                   "银行卡信息以及紧急联系人信息，均已交由人力资源部门归档保存备查"},
        ensure_ascii=False), encoding="utf-8")
    must("pdf_form_fill.py", "--in", FORM, "--out", work / "long.pdf",
         "--values", long_values)
    must("pdf_form_check.py", "--in", work / "long.pdf", "--out", work / "check-long.json",
         "--proof", work / "proof.pdf")

    check_long = _json(work / "check-long.json")
    return {
        "summary_acro": _json(work / "sum-acro.json"),
        "summary_flat": _json(work / "sum-flat.json"),
        "fields": _json(work / "fields.json")["fields"],
        "values": _json(FORM_VALUES),
        "fill_report": _json(work / "fill.json"),
        "placements": _json(FORM_PLACEMENTS)["placements"],
        "overlay_report": _json(work / "flat-fill.json"),
        "refusals": refusals,
        "check_clean": _json(work / "check-clean.json"),
        "check_overflow": check_long,
        # The proof sheet is drawn from the overflowing run on purpose: it is the only
        # one carrying all three verdicts, so a single-colour proof cannot pass M6.
        "proof_pdf": str(work / "proof.pdf"),
        # A COPY, not the same list: the proof sheet was drawn from these verdicts at
        # the time it was drawn. Aliasing them let a flaw injected into the check
        # report rewrite history, so "the checker mis-verdicted" also lit M6 — a
        # cascade that cannot happen in reality, where the proof would simply carry
        # the same wrong verdict.
        "proof_of": copy.deepcopy(check_long["fields"]),
    }


def collect_create(work: Path) -> dict:
    """Generate documents and measure what came out."""
    import fitz

    def must(*args) -> subprocess.CompletedProcess:
        r = run_script("pdf_create.py", *args)
        if r.returncode != 0:
            raise SystemExit(f"[setup] pdf_create.py failed: {r.stdout}{r.stderr}")
        return r

    out_pdf, report_path = work / "doc.pdf", work / "fonts.json"
    must("--in", DOC_SPEC, "--out", out_pdf, "--font-report", report_path)
    report = _json(report_path)

    spec = _json(DOC_SPEC)
    needles = [b["text"] for b in spec["blocks"] if b.get("text")]
    needles += [i for b in spec["blocks"] for i in b.get("items", [])]

    pages, boxes = [], []
    doc = fitz.open(out_pdf)
    with doc:
        for i, page in enumerate(doc, 1):
            pages.append(page.get_text())
            spans = [fitz.Rect(sp["bbox"]) for b in page.get_text("dict")["blocks"]
                     for l in b.get("lines", []) for sp in l["spans"] if sp["text"].strip()]
            union = None
            for r in spans:
                union = r if union is None else union | r
            boxes.append({"number": i, "width": page.rect.width,
                          "height": page.rect.height,
                          "text_bbox": [round(v, 2) for v in union] if union else None})

    # No pagebreak block anywhere: if the writer does not watch the bottom margin
    # itself, this comes out as one page with text running off it.
    long_spec, n = work / "long.json", 24
    para = "本季度营业收入同比增长，毛利率保持稳定，费用结构持续优化，销售费用率下降。" * 3
    long_spec.write_text(json.dumps(
        {"blocks": [{"type": "paragraph", "text": f"{i + 1}. {para}"} for i in range(n)]},
        ensure_ascii=False), encoding="utf-8")
    long_report = json.loads(must("--in", long_spec, "--out", work / "long.pdf").stdout)

    # Coverage: U+20BB7 is outside the shipped face, so this must be refused.
    rare = work / "rare.json"
    rare.write_text(json.dumps({"blocks": [{"type": "paragraph", "text": "生僻字 𠮷"}]},
                               ensure_ascii=False), encoding="utf-8")
    coverage = {"refusal_exit": run_script("pdf_create.py", "--in", rare,
                                           "--out", work / "rare.pdf").returncode,
                "forced_findings": None, "skips": []}
    forced = work / "forced.pdf"
    r = run_script("pdf_create.py", "--in", DOC_SPEC, "--out", forced,
                   "--font", LATIN_ONLY_FONT, "--allow-missing-glyphs")
    if r.returncode != 0:
        coverage["skips"].append(
            f"G5: forcing {LATIN_ONLY_FONT} onto CJK text did not even run "
            f"({r.stderr.strip()[:120]}), so the second half of G5 is unproven here")
    else:
        if True:
            import importlib.util
            spec_l2 = importlib.util.spec_from_file_location(
                "l2", REPO / "scripts" / "office-skills-selftest.py")
            l2 = importlib.util.module_from_spec(spec_l2)
            spec_l2.loader.exec_module(l2)
            findings, _, _ = l2.run_checks(forced, {"contains": ["季度经营分析报告"]},
                                           allow_missing=frozenset({"soffice", "xsd"}))
            coverage["forced_findings"] = findings

    return {"report": report, "pdf": str(out_pdf), "needles": needles,
            "text_by_page": pages, "page_boxes": boxes,
            "long_pages": long_report["pages"], "long_blocks": n,
            "coverage": coverage}


def page_texts(path: Path, password: str | None = None) -> list[str]:
    import fitz
    doc = fitz.open(path)
    with doc:
        if doc.needs_pass and password:
            doc.authenticate(password)
        return [p.get_text() for p in doc]


def collect_ops(work: Path) -> dict:
    """Tables, page operations and encryption, run for real on the fixtures."""
    import csv as csvmod
    import fitz

    def must(script: str, *args) -> subprocess.CompletedProcess:
        r = run_script(script, *args)
        if r.returncode != 0:
            raise SystemExit(f"[setup] {script} failed: {r.stdout}{r.stderr}")
        return r

    # ---- P3 ----
    tables_json, csv_dir = work / "tables.json", work / "csv"
    must("pdf_tables.py", "--in", TABLE_GRID, "--out", tables_json, "--csv-dir", csv_dir)
    rows = {}
    has_bom = False
    for f in sorted(csv_dir.glob("*.csv")):
        raw = f.read_bytes()
        has_bom = has_bom or raw.startswith(b"\xef\xbb\xbf")
        rows[f.name] = list(csvmod.reader(raw.decode("utf-8-sig").splitlines()))

    # ---- P11 ----
    src_texts = page_texts(REPORT)
    with fitz.open(REPORT) as d:
        src_rotations = [p.rotation for p in d]

    merged, merge_report = work / "merged.pdf", work / "merge.json"
    must("pdf_pages.py", "--op", "merge", "--in", REPORT, FORM_FLAT,
         "--out", merged, "--report", merge_report)

    extracted, extract_report = work / "sub.pdf", work / "extract.json"
    must("pdf_pages.py", "--op", "extract", "--in", REPORT, "--pages", "1,3",
         "--out", extracted, "--report", extract_report)

    deleted, delete_report = work / "fewer.pdf", work / "delete.json"
    must("pdf_pages.py", "--op", "delete", "--in", REPORT, "--pages", "2",
         "--out", deleted, "--report", delete_report)

    rotated, rotate_report, degrees = work / "rot.pdf", work / "rotate.json", 90
    must("pdf_pages.py", "--op", "rotate", "--in", REPORT, "--pages", "1",
         "--degrees", degrees, "--out", rotated, "--report", rotate_report)
    with fitz.open(rotated) as d:
        out_rotations = [p.rotation for p in d]

    parts_dir, split_report = work / "parts", work / "split.json"
    must("pdf_pages.py", "--op", "split", "--in", REPORT, "--out", parts_dir,
         "--every", "2", "--report", split_report)
    split_data = _json(split_report)
    part_texts = [page_texts(parts_dir / p["file"]) for p in split_data["parts"]]

    # ---- P12 ----
    locked, enc_report = work / "locked.pdf", work / "encrypt.json"
    must("pdf_encrypt.py", "--in", REPORT, "--out", locked,
         "--set-password", ENC_USER_PW, "--owner-password", ENC_OWNER_PW,
         "--allow", "print,copy", "--report", enc_report)
    with fitz.open(locked) as d:
        needs_pass = bool(d.needs_pass)
        right = bool(d.authenticate(ENC_USER_PW))
        user_bits = int(d.permissions)
    with fitz.open(locked) as d:
        wrong = bool(d.authenticate("definitely-not-it"))
    user_permissions = {n: bool(user_bits & getattr(fitz, f"PDF_PERM_{n.upper()}"))
                        for n in ("print", "copy", "modify", "annotate")}

    # The trap: restrictive --allow while the owner password defaults to the user's.
    owner_trap = run_script("pdf_encrypt.py", "--in", REPORT, "--out", work / "trap.pdf",
                            "--set-password", ENC_USER_PW, "--allow", "print,copy")

    plain = work / "plain.pdf"
    refusal = run_script("pdf_encrypt.py", "--in", locked, "--out", work / "nope.pdf",
                         "--remove-password")
    must("pdf_encrypt.py", "--in", locked, "--out", plain,
         "--password", ENC_USER_PW, "--remove-password")
    with fitz.open(plain) as d:
        still_encrypted = bool(d.needs_pass)

    return {
        "tables": _json(tables_json), "csv": rows, "csv_has_bom": has_bom,
        "source_texts": src_texts, "source_rotations": src_rotations,
        "merge": {"report": _json(merge_report), "pages": len(page_texts(merged)),
                  "out_texts": page_texts(merged),
                  "input_texts": [src_texts, page_texts(FORM_FLAT)]},
        "extract": {"kept_pages": _json(extract_report)["kept_pages"],
                    "out_texts": page_texts(extracted)},
        "delete": {"deleted_pages": _json(delete_report)["deleted_pages"],
                   "out_texts": page_texts(deleted)},
        "rotate": {"report": _json(rotate_report), "degrees": degrees,
                   "out_rotations": out_rotations, "out_texts": page_texts(rotated)},
        "split": {"report": split_data, "part_texts": part_texts},
        "encrypt": {"report": _json(enc_report), "needs_pass": needs_pass,
                    "right_password_opens": right, "wrong_password_opens": wrong,
                    "user_permissions": user_permissions,
                    "owner_equals_user_exit": owner_trap.returncode},
        "decrypt": {"refusal_exit": refusal.returncode,
                    "still_encrypted": still_encrypted,
                    "out_texts": page_texts(plain)},
    }


def collect_scale(work: Path) -> dict:
    """How the scripts behave on a document far bigger than the fixtures."""
    import fitz

    big = work / "big.pdf"
    doc = fitz.open()
    with doc:
        for i in range(SCALE_PAGES):
            page = doc.new_page(width=595, height=842)
            page.insert_text((60, 80), f"Page {i + 1}", fontsize=13)
        doc.save(str(big))

    # Every script that writes a PDF, pointed at its own input.
    victim = work / "victim.pdf"
    shutil.copy(REPORT, victim)
    in_place = {}
    for label, args in (
            ("pdf_pages.py --out", ("pdf_pages.py", "--op", "rotate", "--in", victim,
                                    "--pages", "1", "--out", victim)),
            ("pdf_encrypt.py --out", ("pdf_encrypt.py", "--in", victim, "--out", victim,
                                      "--set-password", "a", "--allow",
                                      ",".join(("print", "modify", "copy", "annotate",
                                                "form", "accessibility", "assemble",
                                                "print_hq")))),
            ("pdf_extract.py --overlay", ("pdf_extract.py", "--in", victim, "--out",
                                          work / "v.json", "--overlay", victim)),
            ("pdf_tables.py --overlay", ("pdf_tables.py", "--in", victim, "--out",
                                         work / "vt.json", "--overlay", victim)),
            ("pdf_form_fill.py --out", ("pdf_form_fill.py", "--in", victim, "--out",
                                        victim, "--values", FORM_VALUES)),
            ("pdf_form_check.py --proof", ("pdf_form_check.py", "--in", victim,
                                           "--proof", victim))):
        r = run_script(*args)
        in_place[label] = {"exit": r.returncode, "stderr": r.stderr}

    bare = run_script("pdf_info.py", "--in", big)
    with_file = work / "big-info.json"
    run_script("pdf_info.py", "--in", big, "--out", with_file)
    small = json.loads(run_script("pdf_info.py", "--in", REPORT).stdout)
    return {"pages": SCALE_PAGES, "in_place": in_place,
            "stdout_bytes": len(bare.stdout.encode("utf-8")),
            "file_pages": len(_json(with_file)["pages"]),
            "small_doc_pages_inline": len(small.get("pages") or [])}


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


# --- form family: each flaw is the shortcut a filler is tempted to take ---
def flaw_form_always_fillable(ctx, work):
    """`is_form_pdf` truth-tested instead of compared: a flat PDF reads as a form."""
    ctx["form"]["summary_flat"]["has_acroform"] = True
    return ctx


def flaw_form_forgets_choices(ctx, work):
    """Type reported, options dropped — the caller then invents a value."""
    for f in ctx["form"]["fields"]:
        if f["type"] == "combobox":
            f["choices"] = None
    return ctx


def flaw_form_ignores_maxlen(ctx, work):
    for f in ctx["form"]["fields"]:
        f["max_length"] = None
    return ctx


def flaw_fill_accepts_anything(ctx, work):
    """The tempting filler: write what you were given, let the viewer sort it out."""
    for label in ctx["form"]["refusals"]:
        ctx["form"]["refusals"][label] = 0
    return ctx


def flaw_fill_drops_a_value(ctx, work):
    for item in ctx["form"]["fill_report"]["filled"]:
        if item["name"] == "id_no":
            item["text"] = item["text"][:18][:10]      # quietly truncated
    return ctx


def flaw_overlay_fixed_position(ctx, work):
    """Anchor ignored, everything written at one hard-coded spot on the left."""
    for item in ctx["form"]["overlay_report"]["filled"]:
        item["rect"] = [20.0, 120.0, 170.0, 137.0]
    return ctx


def flaw_check_misses_overflow(ctx, work):
    """Width-only checking: it cannot see a multiline value spilling out the bottom."""
    for f in ctx["form"]["check_overflow"]["fields"]:
        if f["verdict"] == "overflows":
            f["verdict"] = "fits"
    ctx["form"]["check_overflow"]["overflowing"] = 0
    return ctx


def flaw_check_cries_wolf(ctx, work):
    ctx["form"]["check_clean"]["fields"][0]["verdict"] = "overflows"
    ctx["form"]["check_clean"]["overflowing"] = 1
    return ctx


def flaw_proof_all_green(ctx, work):
    """A proof sheet that draws every box the same colour proves nothing.

    Drawn on the blank form, not over the real proof: the first version of this
    control painted green boxes on top of the correctly coloured ones and M6 passed,
    because both boxes were present and M6 only asked whether SOME box at that spot
    had the right colour. The control was wrong AND the check was too lenient.
    """
    import fitz
    src, dst = fitz.open(FORM), work / "proof-green.pdf"
    with src:
        for res in ctx["form"]["proof_of"]:
            src[res["page"] - 1].draw_rect(fitz.Rect(res["rect"]),
                                           color=(0.13, 0.55, 0.24), width=0.9)
        src.save(str(dst))
    ctx["form"]["proof_pdf"] = str(dst)
    return ctx


def flaw_proof_skips_a_field(ctx, work):
    import fitz
    src, dst = fitz.open(FORM), work / "proof-empty.pdf"
    with src:
        src.save(str(dst))
    ctx["form"]["proof_pdf"] = str(dst)
    return ctx


# --- generation: the shortcut is to NAME a font instead of carrying it ---
def flaw_create_names_the_font(ctx, work):
    """The exact thing the fixtures did before P14: insert_text(fontname='china-s').

    Not a hand-edited report — a real document built the tempting way, measured by
    the same reader. It renders perfectly on this machine.
    """
    import fitz
    dst = work / "named-font.pdf"
    doc = fitz.open()
    # Two pages, matching the real document's shape: a control that is also SMALLER
    # than what it replaces trips the vacuity guard, and then it is unclear which
    # difference the check reacted to.
    for _ in range(2):
        page = doc.new_page(width=595, height=842)
        page.insert_text((56, 100), "季度经营分析报告", fontname="china-s", fontsize=20)
    doc.save(str(dst))
    fonts = []
    with fitz.open(dst) as check:
        for number in range(check.page_count):
            for entry in check[number].get_fonts(full=True):
                _, ext, ftype, basefont, alias, encoding = entry[:6]
                fonts.append({"page": number + 1, "basefont": basefont, "alias": alias,
                              "type": ftype, "encoding": encoding,
                              "embedded": ext != "n/a", "file_ext": ext})
    ctx["create"]["report"]["fonts"] = fonts
    ctx["create"]["report"]["all_embedded"] = all(f["embedded"] for f in fonts)
    return ctx


def flaw_create_skips_subsetting(ctx, work):
    """Embedded, but the whole 3.5MB face went along with it."""
    ctx["create"]["report"]["bytes"] = 3_569_129
    for f in ctx["create"]["report"]["fonts"]:
        f["basefont"] = f["basefont"].split("+")[-1]
    return ctx


def flaw_create_loses_a_block(ctx, work):
    ctx["create"]["text_by_page"] = [t.replace("主要指标", "")
                                     for t in ctx["create"]["text_by_page"]]
    return ctx


def flaw_create_never_paginates(ctx, work):
    """One tall page instead of breaking: everything past the margin is off-paper."""
    ctx["create"]["long_pages"] = 1
    return ctx


def flaw_create_runs_off_the_page(ctx, work):
    box = ctx["create"]["page_boxes"][0]
    box["text_bbox"] = [box["text_bbox"][0], box["text_bbox"][1],
                        box["width"] - 10, box["text_bbox"][3]]
    return ctx


def flaw_create_ignores_coverage(ctx, work):
    ctx["create"]["coverage"]["refusal_exit"] = 0
    return ctx


# --- tables / page ops / encryption: the shortcut in each case ---
def flaw_tables_claim_reliable(ctx, work):
    """The guess presented as a reading — the caller cannot tell from the cells."""
    for page in ctx["ops"]["tables"]["pages"]:
        for t in page["tables"]:
            t["strategy"], t["reliable"] = "lines", True
    ctx["ops"]["tables"]["unreliable_count"] = 0
    return ctx


def flaw_tables_wrong_cells(ctx, work):
    ctx["ops"]["tables"]["pages"][0]["tables"][0]["cells"][1][1] = "9,999"
    return ctx


def flaw_csv_no_bom(ctx, work):
    """A plain UTF-8 CSV: opens as mojibake in Excel, which is where these go."""
    ctx["ops"]["csv_has_bom"] = False
    return ctx


def flaw_merge_drops_input(ctx, work):
    m = ctx["ops"]["merge"]
    keep = len(m["input_texts"][0])
    m["out_texts"] = m["out_texts"][:keep]
    m["pages"] = keep
    return ctx


def flaw_merge_wrong_order(ctx, work):
    m = ctx["ops"]["merge"]
    m["out_texts"] = m["out_texts"][::-1]
    return ctx


def flaw_extract_off_by_one(ctx, work):
    """`--pages 1,3` answered with pages 1 and 2 — counts still match."""
    src = ctx["ops"]["source_texts"]
    ctx["ops"]["extract"]["out_texts"] = [src[0], src[1]]
    return ctx


def flaw_delete_removes_wrong_page(ctx, work):
    src = ctx["ops"]["source_texts"]
    ctx["ops"]["delete"]["out_texts"] = [src[1], src[2]]
    return ctx


def flaw_rotate_absolute(ctx, work):
    """set_rotation(degrees) instead of (current + degrees): applying 90 to a page
    already at 90 becomes a no-op, and nothing about the page count notices."""
    for entry in ctx["ops"]["rotate"]["report"]["rotated"]:
        entry["from"], entry["to"] = 90, 90
    return ctx


def flaw_rotate_touches_other_pages(ctx, work):
    ctx["ops"]["rotate"]["out_rotations"] = [
        (r + 90) % 360 for r in ctx["ops"]["source_rotations"]]
    return ctx


def flaw_rotate_rewrites_text(ctx, work):
    ctx["ops"]["rotate"]["out_texts"] = [t.replace("季度", "")
                                         for t in ctx["ops"]["rotate"]["out_texts"]]
    return ctx


def flaw_split_loses_a_page(ctx, work):
    sp = ctx["ops"]["split"]
    sp["report"]["parts"] = sp["report"]["parts"][:1]
    sp["part_texts"] = sp["part_texts"][:1]
    return ctx


def flaw_encrypt_writes_plain(ctx, work):
    """save(encryption=...) silently producing an unprotected file."""
    ctx["ops"]["encrypt"]["needs_pass"] = False
    return ctx


def flaw_encrypt_any_password(ctx, work):
    ctx["ops"]["encrypt"]["wrong_password_opens"] = True
    return ctx


def flaw_permissions_measured_as_owner(ctx, work):
    """Reading permissions after authenticating as the OWNER: everything granted."""
    ctx["ops"]["encrypt"]["user_permissions"] = {n: True for n in
                                                 ("print", "copy", "modify", "annotate")}
    return ctx


def flaw_decrypt_without_password(ctx, work):
    ctx["ops"]["decrypt"]["refusal_exit"] = 0
    return ctx


def flaw_owner_trap_accepted(ctx, work):
    ctx["ops"]["encrypt"]["owner_equals_user_exit"] = 0
    return ctx


def flaw_stdout_dumps_everything(ctx, work):
    """Printing the full per-page list: what it did before, measured at 82KB."""
    ctx["scale"]["stdout_bytes"] = 81899
    return ctx


def flaw_trimming_loses_data(ctx, work):
    """Trimming stdout by dropping the data instead of routing it to the file."""
    ctx["scale"]["file_pages"] = 20
    return ctx


def flaw_in_place_allowed(ctx, work):
    ctx["scale"]["in_place"]["pdf_pages.py --out"] = {"exit": 0, "stderr": ""}
    return ctx


def flaw_in_place_raw_traceback(ctx, work):
    """What the library does on its own: a wall of Python instead of a sentence."""
    ctx["scale"]["in_place"]["pdf_encrypt.py --out"] = {
        "exit": 1, "stderr": "Traceback (most recent call last):\n  ...\n"
                             "ValueError: save to original must be incremental\n"}
    return ctx


def flaw_live_no_form_env(ctx, work):
    """The implementation that shipped until 2026-08-05: open, never init_forms.

    Not a mutation of the numbers above — the real pdf_render.py runs again from a
    copy with that one line backed out, so what R5 sees is what the old code would
    actually have produced.
    """
    scripts = patched_scripts(work, FORMS_ANCHOR,
                              "doc.uw_forms_note = FORMS_NONE", "noforms")
    ctx["forms_render"] = collect_forms_render(scripts, work, "noforms")
    return ctx


def flaw_live_forms_note_lies(ctx, work):
    """Pixels right, report wrong. Controls R5's second half on its own: without it
    the note assertions could be deleted and every row would stay green."""
    scripts = patched_scripts(work, FORMS_ANCHOR,
                              "doc.init_forms()\n        doc.uw_forms_note = FORMS_NONE",
                              "notelies")
    ctx["forms_render"] = collect_forms_render(scripts, work, "notelies")
    return ctx


def flaw_live_no_acroform_carry(ctx, work):
    """The implementation that shipped until 2026-08-05: every op builds a fresh
    writer, copies the pages in, and leaves the catalog's /AcroForm behind."""
    scripts = patched_scripts(work, CARRY_ANCHOR,
                              '    note = {"state": "none", "detail": "not carried"}',
                              "nocarry")
    ctx["pageops_form"] = collect_pageops_form(scripts, work, "nocarry")
    return ctx


def flaw_live_fields_only(ctx, work):
    """Carries /Fields and nothing else. The pixels come out right, so only the
    form-level keys tell it apart — which is exactly why N5 asserts them separately."""
    scripts = patched_scripts(work, KEYS_ANCHOR, "ACROFORM_KEYS = ()", "fieldsonly")
    ctx["pageops_form"] = collect_pageops_form(scripts, work, "fieldsonly")
    return ctx


def flaw_live_fuses_two_forms(ctx, work):
    """Takes the first form and merges anyway. The output opens, looks filled, and
    two unrelated fields now share one value the moment anybody types."""
    scripts = patched_scripts(work, REFUSE_ANCHOR, "    if False:", "fusetwo")
    ctx["pageops_form"] = collect_pageops_form(scripts, work, "fusetwo")
    return ctx


FLAWS = [
    ("writer-overwrites-its-own-input", flaw_in_place_allowed, {"O2"}, ""),
    ("writer-fails-with-a-raw-traceback", flaw_in_place_raw_traceback, {"O2"}, ""),
    ("stdout-dumps-every-page", flaw_stdout_dumps_everything, {"O1"}, ""),
    ("trimming-drops-the-data-instead-of-filing-it", flaw_trimming_loses_data, {"O1"}, ""),
    ("tables-present-a-guess-as-a-reading", flaw_tables_claim_reliable, {"T2"}, ""),
    ("tables-misread-a-cell", flaw_tables_wrong_cells, {"T1"}, ""),
    ("csv-written-without-a-bom", flaw_csv_no_bom, {"T3"}, ""),
    ("merge-drops-its-second-input", flaw_merge_drops_input, {"N1"}, ""),
    ("merge-concatenates-in-the-wrong-order", flaw_merge_wrong_order, {"N1"}, ""),
    ("extract-returns-the-wrong-pages", flaw_extract_off_by_one, {"N2"}, ""),
    ("delete-removes-the-wrong-page", flaw_delete_removes_wrong_page, {"N2"}, ""),
    ("rotate-sets-an-absolute-angle", flaw_rotate_absolute, {"N3"}, ""),
    ("rotate-turns-pages-it-was-not-asked-to", flaw_rotate_touches_other_pages, {"N3"}, ""),
    ("rotate-rewrites-the-text-layer", flaw_rotate_rewrites_text, {"N3"}, ""),
    ("split-loses-a-page", flaw_split_loses_a_page, {"N4", "V0"},
     "V0 also fires: dropping a part leaves fewer than the two the vacuity guard "
     "needs, which is honest — with one part there is nothing left to check coverage on"),
    ("encrypt-writes-an-unprotected-file", flaw_encrypt_writes_plain, {"K1"}, ""),
    ("encrypt-accepts-any-password", flaw_encrypt_any_password, {"K1"}, ""),
    ("permissions-measured-as-the-owner", flaw_permissions_measured_as_owner, {"K2"}, ""),
    ("decrypt-strips-protection-without-the-password", flaw_decrypt_without_password,
     {"K3"}, ""),
    ("owner-password-trap-accepted", flaw_owner_trap_accepted, {"K4"}, ""),

    ("create-names-the-font-instead-of-embedding", flaw_create_names_the_font, {"G1"}, ""),
    ("create-embeds-without-subsetting", flaw_create_skips_subsetting, {"G1", "G2"},
     "G1 also fires: dropping the subset tag is how an unsubset face presents itself, "
     "and both checks read the same basefont string"),
    ("create-drops-a-heading", flaw_create_loses_a_block, {"G3"}, ""),
    ("create-never-breaks-a-page", flaw_create_never_paginates, {"G3"}, ""),
    ("create-draws-past-the-margin", flaw_create_runs_off_the_page, {"G4"}, ""),
    ("create-writes-glyphs-the-font-lacks", flaw_create_ignores_coverage, {"G5"}, ""),

    ("form-reports-every-pdf-as-fillable", flaw_form_always_fillable, {"M1"}, ""),
    ("form-omits-the-combobox-choices", flaw_form_forgets_choices, {"M2"}, ""),
    ("form-omits-the-length-limit", flaw_form_ignores_maxlen, {"M2"}, ""),
    ("fill-writes-values-the-form-cannot-hold", flaw_fill_accepts_anything, {"M3"}, ""),
    ("fill-truncates-a-value-silently", flaw_fill_drops_a_value, {"M3"}, ""),
    ("overlay-uses-a-fixed-position", flaw_overlay_fixed_position, {"M4"}, ""),
    ("check-measures-width-only", flaw_check_misses_overflow, {"M5"}, ""),
    ("check-reports-a-fitting-value-as-overflow", flaw_check_cries_wolf, {"M5"}, ""),
    ("proof-draws-every-box-green", flaw_proof_all_green, {"M6"}, ""),
    ("proof-draws-nothing", flaw_proof_skips_a_field, {"M6"}, ""),

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
    ("LIVE: pdf_render as it shipped until 2026-08-05 (no form env)",
     flaw_live_no_form_env, {"R6"}, ""),
    ("LIVE: form env is up but the report says it is not",
     flaw_live_forms_note_lies, {"R6"}, ""),
    ("LIVE: page ops as they shipped until 2026-08-05 (no /AcroForm carry)",
     flaw_live_no_acroform_carry, {"N5"}, ""),
    ("LIVE: carries /Fields and drops the form-level keys",
     flaw_live_fields_only, {"N5"}, ""),
    ("LIVE: merges two form documents instead of refusing",
     flaw_live_fuses_two_forms, {"N5"}, ""),
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
        skips = base["create"]["coverage"].get("skips", [])

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
        print(json.dumps({"results": results, "matrix": matrix, "skips": skips,
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
    if skips:
        # Named out loud, never folded into the pass count: "skipped" and "passed"
        # must not look the same from the outside.
        print("\n[skipped] claims this host could not exercise:")
        for note in skips:
            print(f"  - {note}")
    print(f"\n[pdf-skill] {len(results) - len(failed)} passed, {len(failed)} failed, "
          f"{len(CHECKS)} assertions" + (f", {len(skips)} skipped" if skips else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
