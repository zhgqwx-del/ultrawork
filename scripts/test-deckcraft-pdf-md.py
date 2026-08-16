#!/usr/bin/env python3
"""Behaviour tests for deckcraft's pdf_to_md.py + pdfsource.py (discussions/059 S3.5).

    python3 scripts/test-deckcraft-pdf-md.py
    python3 scripts/test-deckcraft-pdf-md.py --json

WHY THIS EXISTS
---------------
`pdf_to_md.py` is 1100 lines that shipped for a year with no test of any kind, and
S3.5 replaces the library underneath all of it (PyMuPDF -> pdfplumber / pypdf /
pypdfium2, to get AGPL out of a commercially distributed tree). A swap with no
ruler is not a swap, it is a hope. So the ruler came first.

Every assertion runs twice: once against the real output of the real script (must
stay silent) and once against a state carrying exactly the defect it hunts (must
fire). Four of the controls are not fabricated numbers — they re-run the real
extraction with the real constant moved, because those four are the places where
a plausible implementation is a WORKING implementation that is quietly worse:

    crop-flipped-vertically     the y-flip between PDF and top-left frames
    gap-threshold-too-low       letter-spacing read as word breaks
    gap-threshold-too-high      separate columns glued into one word
    semibold-not-treated-as-bold  the one deliberate behaviour change

⚠️ The vertical-flip control is why "the crop has ink in it" is NOT the assertion.
Measured on this file's own fixture, the WRONG crop is more inked than the right
one (0.587 vs 0.399) because it lands on the photo. Ink proves the crop is not on
blank paper; only comparing against the same region of a full-page render proves
it is the right region.

Lives outside skills/builtin/ so it is not packed into skills-builtin.zip.
Exit 0 = every assertion behaved, 1 = something did not.
"""
from __future__ import annotations

import argparse
import copy
import importlib
import io
import json
import random
import subprocess
import sys
import tempfile
import unicodedata
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
SKILL = REPO / "skills" / "builtin" / "deckcraft"
SRC = SKILL / "scripts" / "source_to_md"
CONVERTER = SRC / "pdf_to_md.py"
DECK = SKILL / "examples" / "ai-coding-pilot" / "export" / "deck.pdf"
PY = sys.executable

W, H = 612.0, 792.0
VECTOR_DPI = 180

# What the fixtures are drawn to contain. Spelled out here rather than read back
# from the PDFs: an expectation derived from the artifact it checks agrees with
# itself no matter what the artifact says.
STYLE_HEADINGS = [(1, "Quarterly Engineering Review"),
                  (2, "Adoption Metrics"),
                  (3, "Rollout Detail")]
BOLD_RUN = "**thirty eight percent**"
ITALIC_RUN = "*appendix two*"
BOLD_ITALIC_RUN = "***Draft only, do not circulate***"
CODE_LINE = "def weekly_total(rows):"
LIST_ITEMS = ["- seed users embedded in each team", "1. connect the agent"]
MERGED_SENTENCE = ("The rollout plan splits the population into four cohorts of "
                   "roughly equal size.")
TABLE_CELLS = [["Cohort", "Throughput", "Rework"], ["Pilot", "1240", "0.8"],
               ["Control", "1103", "1.2"], ["Delta", "137", "-0.4"]]
NOISE_HEADER, NOISE_FOOTER = "ACME INTERNAL REVIEW", "confidential draft"
HEADFOOT_PAGES = 5

# Where the bar chart is actually drawn on figure.pdf, in the top-left frame the
# converter reports. Bars span x 134..406 and y 472..651; the caption sits below
# at y~674. A detected figure region has to live inside this and be big enough to
# be the chart rather than one bar.
FIGURE_BOUNDS = (110.0, 455.0, 460.0, 685.0)
FIGURE_MIN_SIZE = (200.0, 140.0)

# Crop alignment: mean absolute grey difference between the figure PNG the
# converter wrote and the same rectangle cut out of a full-page render.
# Measured 2026-08-02: correct frame 0.00, vertically flipped frame 66.13.
# 8.0 sits far from both and leaves room for the half-pixel rounding that a
# scaled crop and a scaled-then-cropped page do not share.
CROP_ALIGN_MAX = 8.0
DARK = 200            # grey value counted as ink, same cutoff as the L2 gate
CROP_INK_MIN = 0.05

# The gap-to-font-size band that _SPACE_GAP_RATIO has to sit in, measured over
# deck.pdf's 1044 adjacent character pairs. Below: CSS letter-spacing, which must
# NOT become a space. Above: genuinely separate runs, which must.
#     letter-spacing .... 225 pairs, max 0.2500
#     empty ............... 0 pairs, 5.17x wide
#     real separations ... 34 pairs, min 1.2934
LETTERSPACE_MAX = 0.25
SEPARATION_MIN = 1.2934

# stdout budget: these scripts run under an agent and, in Team mode, their output
# crosses the delegation boundary. Same number the pdf skill uses.
STDOUT_BUDGET = 4096

# deck.pdf is TEN pages. The task brief that commissioned this said 24; the file
# and its own "N / 10" footers say 10, and P1 is why that got checked instead of
# copied.
# The real corpus is NOT in git: .gitignore excludes skills/builtin/*/examples/*/
# export/, and deck.pdf is 610 KB of generated output that would also ship inside
# skills-builtin.zip to every user. So this gate could only ever run on the author's
# machine — measured on CI, where it exited 1 with "real corpus missing" the first
# time this branch was ever pushed. Adding a gate to CI is not the same as that gate
# being able to RUN there.
#
# Handling follows the rule this repo already applies to LibreOffice (059 §7): when
# the corpus is absent these assertions are SKIPPED AND NAMED, never folded into the
# pass count — and so are the negative controls that could not fire, because a
# control nobody ran is not a control. The synthetic half still runs everywhere.
DECK_CHECKS = {"V0", "O1", "H2", "T2", "G1", "G2", "K1", "P1", "X1"}
SKIPS: list[str] = []

DECK_PAGES = 10
DECK_HEADINGS = ["## AI编程助手 落地实践", "### 为什么 是现在", "### 试点怎么做的"]
DECK_LETTERSPACED = "ENGINEERING PRODUCTIVITY REVIEW"
DECK_SEPARATED = "+31% -24% 83%"
DECK_CJK_SAMPLES = ["压力", "同比", "人力", "工具", "行动", "使用时长"]

# The name -> (bold, italic) rule, and the one entry that is a deliberate change
# of behaviour rather than a translation of one. PyMuPDF answered flags=0 for
# every Chinese glyph in the deck because Chrome emits them as Type3 fonts, which
# carry no descriptor; pdfminer resolves the same fonts by name, so weight is
# recoverable here and was not there.
FONT_RULE = [
    ("Helvetica", False, False),
    ("Helvetica-Bold", True, False),
    ("Helvetica-Oblique", False, True),
    ("Helvetica-BoldOblique", True, True),
    ("AAAAAA+HelveticaNeue-Bold", True, False),     # subset tag stripped
    ("PingFangSC-Semibold", True, False),           # <- the deliberate change
    ("PingFangSC-Thin", False, False),
    ("Courier", False, False),
]

RADICAL_PAIRS = [("⼒", "力"), ("⽐", "比"), ("⼈", "人"), ("⼯", "工"),
                 ("⾏", "行"), ("⻓", "长"), ("⻅", "见"), ("⻛", "风")]
# Component-only radicals that are deliberately NOT folded: they are parts of
# characters, not characters, and rewriting them would assert something the
# document did not say.
RADICAL_UNTOUCHED = ["⺅", "⻌", "⻈", "⺰"]


def _imports_fitz(path: Path) -> bool:
    """Whether a module actually imports fitz, by parsing it rather than grepping."""
    import ast

    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(a.name.split(".")[0] == "fitz" for a in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] == "fitz":
                return True
    return False


def run_converter(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([PY, str(CONVERTER), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=300)


# ── fixtures ──────────────────────────────────────────────────────────────────
BODY = (
    "The pilot ran for eight weeks across two business units with matched cohorts. "
    "Every request was logged, reviewed under one rubric, and counted the same way. "
    "Numbers below are illustrative and should not be quoted as measured results. "
    "Reviewers recorded rework rounds per change and the wall clock time to merge. "
    "The control group kept its existing toolchain for the whole of the pilot period. "
)


def _styles(path: Path) -> None:
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=(W, H), initialFontName="Helvetica")
    c.setFont("Helvetica-Bold", 24)
    c.drawString(56, H - 80, STYLE_HEADINGS[0][1])
    y = H - 120
    c.setFont("Helvetica", 10)
    for chunk in [BODY[i:i + 92] for i in range(0, len(BODY), 92)]:
        c.drawString(56, y, chunk)
        y -= 14
    c.setFont("Helvetica-Bold", 18)
    c.drawString(56, y - 20, STYLE_HEADINGS[1][1])
    y -= 50
    c.setFont("Helvetica", 10)
    c.drawString(56, y, "Throughput rose ")
    x = 56 + c.stringWidth("Throughput rose ", "Helvetica", 10)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x, y, "thirty eight percent")
    x += c.stringWidth("thirty eight percent", "Helvetica-Bold", 10)
    c.setFont("Helvetica", 10)
    c.drawString(x, y, " year over year.")
    y -= 16
    c.drawString(56, y, "Method notes live in ")
    x = 56 + c.stringWidth("Method notes live in ", "Helvetica", 10)
    c.setFont("Helvetica-Oblique", 10)
    c.drawString(x, y, "appendix two")
    x += c.stringWidth("appendix two", "Helvetica-Oblique", 10)
    c.setFont("Helvetica", 10)
    c.drawString(x, y, " of the report.")
    y -= 16
    c.setFont("Helvetica-BoldOblique", 10)
    c.drawString(56, y, "Draft only, do not circulate")
    y -= 24
    c.setFont("Helvetica-Bold", 14)
    c.drawString(56, y, STYLE_HEADINGS[2][1])
    y -= 24
    c.setFont("Courier", 10)
    for line in (CODE_LINE, "    return sum(r.points for r in rows)"):
        c.drawString(56, y, line)
        y -= 13
    y -= 12
    c.setFont("Helvetica", 10)
    for line in ("- seed users embedded in each team",
                 "- weekly retro with the tooling group",
                 "1. connect the agent", "2. record the baseline"):
        c.drawString(56, y, line)
        y -= 14
    y -= 10
    # Two lines that must merge: the first does not end a sentence.
    c.drawString(56, y, "The rollout plan splits the population into four cohorts of")
    c.drawString(56, y - 14, "roughly equal size.")
    c.showPage()
    c.save()


def _table(path: Path) -> None:
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=(W, H), initialFontName="Helvetica")
    c.setFont("Helvetica-Bold", 16)
    c.drawString(56, H - 70, "Cohort Results")
    x0, y0, cw, rh = 56.0, H - 260.0, 140.0, 28.0
    c.setLineWidth(0.8)
    for i in range(len(TABLE_CELLS) + 1):
        c.line(x0, y0 + i * rh, x0 + 3 * cw, y0 + i * rh)
    for j in range(4):
        c.line(x0 + j * cw, y0, x0 + j * cw, y0 + len(TABLE_CELLS) * rh)
    c.setFont("Helvetica", 10)
    for r, row in enumerate(TABLE_CELLS):
        for col, cell in enumerate(row):
            c.drawString(x0 + col * cw + 8,
                         y0 + (len(TABLE_CELLS) - r - 1) * rh + 10, cell)
    c.showPage()
    c.save()


def _bordered_card(path: Path) -> None:
    """A slide-style card: a bordered box with text in it, and NO table.

    This is the shape that made pdfplumber report a 1x1 "table" on four of the
    deck's pages, whose Markdown was `||` over `|---|` and which swallowed the
    real text inside it because the converter drops blocks overlapping a table.
    """
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=(W, H), initialFontName="Helvetica")
    c.setLineWidth(1.0)
    c.rect(56, H - 300, 460, 200, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(76, H - 140, "Route A")
    c.setFont("Helvetica", 10)
    c.drawString(76, H - 170, "Roll out to all three hundred engineers at once.")
    c.drawString(76, H - 190, "Cheapest to administer and fastest to show effect.")
    c.showPage()
    c.save()


def _headfoot(path: Path) -> None:
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=(W, H), initialFontName="Helvetica")
    for n in range(1, HEADFOOT_PAGES + 1):
        c.setFont("Helvetica", 9)
        c.drawString(56, H - 40, NOISE_HEADER)
        c.drawString(56, 30, NOISE_FOOTER)
        c.setFont("Helvetica", 11)
        c.drawString(56, H - 200, f"Section {n} covers the {n}th stage of the rollout.")
        c.drawString(56, H - 220, f"Unique marker for page {n} is zeta{n}.")
        c.showPage()
    c.save()


def _figure(path: Path) -> Path:
    """A raster photo and a captioned vector chart, well apart on one page."""
    from PIL import Image
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader

    rnd = random.Random(7)
    im = Image.new("RGB", (400, 300))
    im.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256))
                for _ in range(400 * 300)])
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    buf.seek(0)
    source_png = path.parent / "figure-source.png"
    im.save(str(source_png))

    c = canvas.Canvas(str(path), pagesize=(W, H), initialFontName="Helvetica")
    c.setFont("Helvetica-Bold", 16)
    c.drawString(56, H - 70, "Figures")
    c.drawImage(ImageReader(buf), 56, H - 420, width=300, height=225)
    bx, by = 120.0, 140.0
    c.setLineWidth(1.0)
    c.setStrokeColorRGB(0, 0, 0)
    c.line(bx, by, bx + 300, by)
    c.line(bx, by, bx, by + 180)
    c.setFillColorRGB(0.15, 0.3, 0.7)
    for i, hgt in enumerate((40, 95, 70, 150, 120, 165)):
        c.rect(bx + 14 + i * 48, by + 1, 32, hgt, stroke=1, fill=1)
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica", 9)
    c.drawString(bx, by - 22, "Figure 1: Throughput over time")
    c.showPage()
    c.save()
    return source_png


def _rotated(src: Path, dest: Path) -> None:
    """styles.pdf with /Rotate 90 — the only case where the two frames differ."""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(str(src))
    writer = PdfWriter()
    for page in reader.pages:
        page.rotate(90)
        writer.add_page(page)
    with dest.open("wb") as fh:
        writer.write(fh)


def build_fixtures(work: Path) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    paths = {n: work / f"{n}.pdf" for n in
             ("styles", "table", "card", "headfoot", "figure", "rotated")}
    _styles(paths["styles"])
    _table(paths["table"])
    _bordered_card(paths["card"])
    _headfoot(paths["headfoot"])
    paths["figure_source"] = _figure(paths["figure"])
    _rotated(paths["styles"], paths["rotated"])
    return paths


# ── raster helpers ────────────────────────────────────────────────────────────
def _full_page_grey(pdf: Path, index: int, dpi: int):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(pdf))
    try:
        return doc[index].render(scale=dpi / 72.0).to_pil().convert("L")
    finally:
        doc.close()


def _ink(image) -> float:
    px = list(image.convert("L").getdata())
    return sum(1 for v in px if v < DARK) / len(px) if px else 0.0


def _mean_abs_diff(a, b) -> float:
    from PIL import ImageChops

    a = a.convert("L")
    b = b.convert("L").resize(a.size)
    px = list(ImageChops.difference(a, b).getdata())
    return sum(px) / len(px) if px else 0.0


def crop_alignment(pdf: Path, page_index: int, bbox, png: Path, dpi: int) -> float:
    """How far the written crop is from the same rectangle of a full-page render.

    The reference path does no PDF coordinate arithmetic at all — a rendered page
    is already top-left and y-down, so the box is used as-is. That is what makes
    it independent of the conversion being checked.
    """
    from PIL import Image

    scale = dpi / 72.0
    full = _full_page_grey(pdf, page_index, dpi)
    x0, y0, x1, y1 = bbox
    ref = full.crop((round(x0 * scale), round(y0 * scale),
                     round(x1 * scale), round(y1 * scale)))
    return _mean_abs_diff(Image.open(png), ref)


# ── measurement ───────────────────────────────────────────────────────────────
def headings_of(md: str) -> list[tuple[int, str]]:
    out = []
    for line in md.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            hashes = len(stripped) - len(stripped.lstrip("#"))
            out.append((hashes, stripped[hashes:].strip()))
    return out


def radical_count(text: str) -> int:
    return sum(1 for c in text if 0x2E80 <= ord(c) <= 0x2FD5)


def _load_modules():
    """Import the skill's own modules so controls can drive the real code."""
    if str(SRC) not in sys.path:
        sys.path.insert(0, str(SRC))
    if str(SKILL / "scripts") not in sys.path:
        sys.path.insert(0, str(SKILL / "scripts"))
    pdfsource = importlib.import_module("pdfsource")
    pdf_to_md = importlib.import_module("pdf_to_md")
    return pdfsource, pdf_to_md


def convert_in_process(pdf: Path, out: Path, **kw) -> str:
    _, pdf_to_md = _load_modules()
    return pdf_to_md.extract_pdf_to_markdown(str(pdf), str(out), **kw)


def measure_gap_ratio(pdf: Path, work: Path, ratio: float) -> str:
    """Re-run the real extraction with the space threshold moved.

    Not a fabricated string: this is the same code path with one constant at a
    different value, which is precisely what "a plausible alternative
    implementation" means here.
    """
    pdfsource, _ = _load_modules()
    original = pdfsource._SPACE_GAP_RATIO
    try:
        pdfsource._SPACE_GAP_RATIO = ratio
        out = work / f"gap-{ratio}.md"
        return convert_in_process(pdf, out)
    finally:
        pdfsource._SPACE_GAP_RATIO = original


def measure_flipped_crop(pdf: Path, bbox, work: Path) -> tuple[float, float]:
    """Render the figure region with the vertical flip a translation gets wrong."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(pdf))
    try:
        page = doc[0]
        pw, ph = page.get_size()
        x0, y0, x1, y1 = bbox
        # left, bottom, right, top — with bottom/top read as if the box were
        # already in the PDF's own bottom-left frame.
        crop = (max(0.0, x0), max(0.0, y0), max(0.0, pw - x1), max(0.0, ph - y1))
        image = page.render(scale=VECTOR_DPI / 72.0, crop=crop).to_pil()
    finally:
        doc.close()
    dest = work / "flipped-crop.png"
    image.save(str(dest))
    return crop_alignment(pdf, 0, bbox, dest, VECTOR_DPI), _ink(image)


def collect(work: Path) -> dict:
    fx = build_fixtures(work / "fx")
    out = work / "out"
    out.mkdir(parents=True, exist_ok=True)
    ctx: dict = {"runs": {}}

    for name in ("styles", "table", "card", "headfoot", "rotated"):
        md_path = out / f"{name}.md"
        proc = run_converter(fx[name], "-o", md_path)
        ctx["runs"][name] = {
            "exit": proc.returncode,
            "stdout": proc.stdout,
            "md": md_path.read_text(encoding="utf-8") if md_path.is_file() else "",
        }

    fig_md = out / "figure.md"
    proc = run_converter(fx["figure"], "-o", fig_md, "--render-vector-figures",
                         "--vector-figure-dpi", str(VECTOR_DPI))
    ctx["runs"]["figure"] = {"exit": proc.returncode, "stdout": proc.stdout,
                             "md": fig_md.read_text(encoding="utf-8")
                             if fig_md.is_file() else ""}

    deck_md = out / "deck.md"
    if DECK.is_file():
        proc = run_converter(DECK, "-o", deck_md)
        ctx["runs"]["deck"] = {"exit": proc.returncode, "stdout": proc.stdout,
                               "md": deck_md.read_text(encoding="utf-8")
                               if deck_md.is_file() else ""}
    else:
        # An empty result, so the derived values below still compute. Every check
        # that reads them is in DECK_CHECKS and is skipped by name in main().
        ctx["runs"]["deck"] = {"exit": 0, "stdout": "", "md": ""}
    ctx["deck_available"] = DECK.is_file()

    # -- headings, formatting, structure ------------------------------------
    ctx["headings"] = {n: headings_of(r["md"]) for n, r in ctx["runs"].items()}
    ctx["deck_radicals"] = radical_count(ctx["runs"]["deck"]["md"])
    ctx["deck_page_markers"] = ctx["runs"]["deck"]["md"].count("<!-- Page ")
    ctx["deck_cjk_present"] = [s for s in DECK_CJK_SAMPLES
                               if s in ctx["runs"]["deck"]["md"]]

    # -- tables --------------------------------------------------------------
    ctx["table_rows"] = [line for line in ctx["runs"]["table"]["md"].splitlines()
                         if line.startswith("|")]
    ctx["card_table_rows"] = [line for line in ctx["runs"]["card"]["md"].splitlines()
                              if line.startswith("|")]
    ctx["card_text_kept"] = "Roll out to all three hundred engineers at once." in \
        ctx["runs"]["card"]["md"]
    ctx["deck_table_rows"] = [line for line in ctx["runs"]["deck"]["md"].splitlines()
                              if line.startswith("|")]

    # -- headers / footers ---------------------------------------------------
    hf = ctx["runs"]["headfoot"]["md"]
    ctx["noise"] = {
        "header_occurrences": hf.count(NOISE_HEADER),
        "footer_occurrences": hf.count(NOISE_FOOTER),
        "unique_markers": sum(1 for n in range(1, HEADFOOT_PAGES + 1)
                              if f"zeta{n}" in hf),
    }

    # -- figures -------------------------------------------------------------
    manifest_path = out / "figure_files" / "image_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) \
        if manifest_path.is_file() else []
    ctx["manifest"] = manifest
    vector = next((m for m in manifest if m["source_kind"] == "pdf_vector_figure"), None)
    raster = next((m for m in manifest if m["source_kind"] == "pdf_image"), None)
    ctx["figure"] = {"vector": None, "raster": None}
    if vector:
        png = out / "figure_files" / vector["filename"]
        from PIL import Image
        ctx["figure"]["vector"] = {
            "bbox": vector["bbox"],
            "align": crop_alignment(fx["figure"], 0, vector["bbox"], png, VECTOR_DPI),
            "ink": _ink(Image.open(png)),
            "pixels": (vector["pixel_width"], vector["pixel_height"]),
        }
    if raster:
        from PIL import Image
        png = out / "figure_files" / raster["filename"]
        got, want = Image.open(png).convert("RGB"), \
            Image.open(fx["figure_source"]).convert("RGB")
        ctx["figure"]["raster"] = {
            "size": got.size,
            "matches_source": list(got.getdata()) == list(want.getdata()),
            "bbox": raster["bbox"],
        }

    # -- unit-level facts about the extraction layer -------------------------
    pdfsource, _ = _load_modules()
    ctx["font_rule"] = {
        name: (bool(pdfsource.font_flags(name) & pdfsource.FLAG_BOLD),
               bool(pdfsource.font_flags(name) & pdfsource.FLAG_ITALIC))
        for name, _b, _i in FONT_RULE}
    ctx["radical_map"] = {a: pdfsource.normalize_glyphs(a) for a, _ in RADICAL_PAIRS}
    ctx["radical_untouched"] = {c: pdfsource.normalize_glyphs(c)
                                for c in RADICAL_UNTOUCHED}
    ctx["nfkc_safe"] = {s: pdfsource.normalize_glyphs(s)
                        for s in ("①", "％", "Ａ", "ﬁ")}
    ctx["gap_ratio"] = pdfsource._SPACE_GAP_RATIO
    ctx["deck_letterspaced_ok"] = DECK_LETTERSPACED in ctx["runs"]["deck"]["md"]
    ctx["deck_separated_ok"] = DECK_SEPARATED in ctx["runs"]["deck"]["md"]
    # Parsed, not grepped: this very file and pdfsource's docstring both contain
    # the words "import fitz" while importing nothing. A substring test called the
    # tree dirty on its own explanation of why it is clean.
    ctx["fitz_importers"] = sorted(str(p.relative_to(REPO)) for p in SKILL.rglob("*.py")
                                   if _imports_fitz(p))
    ctx["fitz_free"] = not ctx["fitz_importers"]
    return ctx


# ── the assertions ────────────────────────────────────────────────────────────
CHECKS: dict[str, dict] = {}


def check(cid: str, title: str):
    def deco(fn):
        CHECKS[cid] = {"id": cid, "title": title, "fn": fn}
        return fn
    return deco


@check("V0", "the fixtures actually give every assertion something to look at")
def v0_not_vacuous(ctx: dict) -> list[str]:
    """A silent check and a check with no subject look identical from outside."""
    out = []
    need = (
        ("style headings", len(ctx["headings"]["styles"]), 4),
        ("deck headings", len(ctx["headings"]["deck"]), 10),
        ("table rows rendered", len(ctx["table_rows"]),
         len(TABLE_CELLS) + 1),          # rows + the header rule
        ("manifest entries", len(ctx["manifest"]), 2),
        ("unique headfoot markers", ctx["noise"]["unique_markers"], HEADFOOT_PAGES),
        ("deck page markers", ctx["deck_page_markers"], DECK_PAGES - 1),
        ("font rule cases", len(ctx["font_rule"]), len(FONT_RULE)),
        ("CJK samples found in the deck", len(ctx["deck_cjk_present"]),
         len(DECK_CJK_SAMPLES)),
    )
    for label, got, want in need:
        if got < want:
            out.append(f"{label}: {got} < {want}")
    if ctx["figure"]["vector"] is None:
        out.append("no vector figure was detected — R1/R2 have no subject")
    if ctx["figure"]["raster"] is None:
        out.append("no raster image was extracted — R3 has no subject")
    for name, run in ctx["runs"].items():
        if run["exit"] != 0:
            out.append(f"{name}: converter exited {run['exit']}")
    return out


@check("O1", "converting a document does not flood stdout")
def o1_stdout_budget(ctx: dict) -> list[str]:
    """These scripts run under an agent, and in Team mode their stdout crosses the
    delegation boundary — every line is context spent.

    Measured before the guard existed: pdfminer narrated "Could not get FontBBox
    from font descriptor" once per embedded Type3 face, 168 times for the 10-page
    example deck — 14,775 bytes where the PyMuPDF build printed 328. The budget is
    the pdf skill's own STDOUT_BUDGET, and the floor is here because a converter
    that says nothing at all has lost its progress reporting.
    """
    out = []
    for name in ("deck", "figure"):
        size = len(ctx["runs"][name]["stdout"].encode("utf-8"))
        if size > STDOUT_BUDGET:
            out.append(f"{name}: printed {size} bytes to stdout (budget {STDOUT_BUDGET})")
    if not ctx["runs"]["deck"]["stdout"].strip():
        out.append("deck: printed nothing at all — progress reporting is gone")
    return out


@check("A1", "the skill carries no AGPL dependency")
def a1_no_fitz(ctx: dict) -> list[str]:
    """The whole point of S3.5. A behaviour suite that passes on a tree that still
    imports fitz would be measuring the wrong thing entirely."""
    return [] if ctx["fitz_free"] else \
        [f"still imports fitz: {', '.join(ctx['fitz_importers'])}"]


@check("H1", "heading levels follow font size")
def h1_headings(ctx: dict) -> list[str]:
    got = ctx["headings"]["styles"]
    out = []
    for level, text in STYLE_HEADINGS:
        if (level, text) not in got:
            out.append(f"expected an H{level} {text!r}, got {got}")
    return out


@check("H2", "the real corpus keeps its heading structure")
def h2_deck_headings(ctx: dict) -> list[str]:
    md = ctx["runs"]["deck"]["md"]
    return [f"missing {h!r}" for h in DECK_HEADINGS if h not in md]


@check("B1", "a bold run becomes **bold**")
def b1_bold(ctx: dict) -> list[str]:
    return [] if BOLD_RUN in ctx["runs"]["styles"]["md"] else \
        [f"{BOLD_RUN!r} not in the output"]


@check("B2", "an italic run becomes *italic*")
def b2_italic(ctx: dict) -> list[str]:
    return [] if ITALIC_RUN in ctx["runs"]["styles"]["md"] else \
        [f"{ITALIC_RUN!r} not in the output"]


@check("B3", "a bold-italic run becomes ***both***")
def b3_bold_italic(ctx: dict) -> list[str]:
    return [] if BOLD_ITALIC_RUN in ctx["runs"]["styles"]["md"] else \
        [f"{BOLD_ITALIC_RUN!r} not in the output"]


@check("B4", "monospace text is left unmarked")
def b4_mono(ctx: dict) -> list[str]:
    md = ctx["runs"]["styles"]["md"]
    if CODE_LINE not in md:
        return [f"{CODE_LINE!r} not in the output"]
    return [f"the code line picked up emphasis markers: "
            f"{[l for l in md.splitlines() if CODE_LINE in l]}"] \
        if any("*" in l for l in md.splitlines() if CODE_LINE in l) else []


@check("B5", "bold/italic are derived from the font name, semibold included")
def b5_font_rule(ctx: dict) -> list[str]:
    out = []
    for name, bold, italic in FONT_RULE:
        got = ctx["font_rule"].get(name)
        if got != (bold, italic):
            out.append(f"{name}: expected bold={bold} italic={italic}, got {got}")
    return out


@check("T1", "a ruled table is read cell for cell")
def t1_table(ctx: dict) -> list[str]:
    want = ["|" + "|".join(TABLE_CELLS[0]) + "|",
            "|" + "|".join(["---"] * 3) + "|"] + \
           ["|" + "|".join(r) + "|" for r in TABLE_CELLS[1:]]
    return [] if ctx["table_rows"] == want else \
        [f"expected {want}, got {ctx['table_rows']}"]


@check("T2", "a bordered box is not reported as a table")
def t2_no_border_tables(ctx: dict) -> list[str]:
    out = []
    if ctx["card_table_rows"]:
        out.append(f"a bordered card produced table rows: {ctx['card_table_rows']}")
    if not ctx["card_text_kept"]:
        out.append("the card's body text was dropped — a phantom table swallowed it")
    degenerate = [r for r in ctx["deck_table_rows"] if r in ("||", "|---|")]
    if degenerate:
        out.append(f"the deck produced {len(degenerate)} degenerate table row(s)")
    return out


@check("G1", "letter-spacing is not read as word breaks")
def g1_letterspacing(ctx: dict) -> list[str]:
    return [] if ctx["deck_letterspaced_ok"] else \
        [f"{DECK_LETTERSPACED!r} not in the deck output — spaced-out kicker text "
         f"was split into single letters"]


@check("G2", "runs separated across the page do not get glued together")
def g2_separation(ctx: dict) -> list[str]:
    return [] if ctx["deck_separated_ok"] else \
        [f"{DECK_SEPARATED!r} not in the deck output — separate figures ran together"]


@check("G3", "the space threshold sits inside its measured empty band")
def g3_band(ctx: dict) -> list[str]:
    r = ctx["gap_ratio"]
    if not (LETTERSPACE_MAX < r < SEPARATION_MIN):
        return [f"_SPACE_GAP_RATIO={r} is outside the measured band "
                f"({LETTERSPACE_MAX}, {SEPARATION_MIN})"]
    return []


@check("N1", "repeated headers and footers are removed")
def n1_noise(ctx: dict) -> list[str]:
    out = []
    if ctx["noise"]["header_occurrences"]:
        out.append(f"the header survived {ctx['noise']['header_occurrences']} time(s)")
    if ctx["noise"]["footer_occurrences"]:
        out.append(f"the footer survived {ctx['noise']['footer_occurrences']} time(s)")
    return out


@check("N2", "removing noise does not remove the page's own content")
def n2_content_kept(ctx: dict) -> list[str]:
    got = ctx["noise"]["unique_markers"]
    return [] if got == HEADFOOT_PAGES else \
        [f"only {got}/{HEADFOOT_PAGES} pages kept their unique marker"]


@check("R1", "a rendered figure is the region it claims to be")
def r1_crop_aligned(ctx: dict) -> list[str]:
    v = ctx["figure"]["vector"]
    if v is None:
        return []
    out = []
    if v["align"] > CROP_ALIGN_MAX:
        out.append(f"the figure PNG differs from that region of the page by "
                   f"{v['align']:.1f} grey levels (limit {CROP_ALIGN_MAX})")
    x0, y0, x1, y1 = v["bbox"]
    bx0, by0, bx1, by1 = FIGURE_BOUNDS
    if not (bx0 <= x0 and x1 <= bx1 and by0 <= y0 and y1 <= by1):
        out.append(f"the figure box {v['bbox']} is outside the drawn chart "
                   f"{FIGURE_BOUNDS}")
    if x1 - x0 < FIGURE_MIN_SIZE[0] or y1 - y0 < FIGURE_MIN_SIZE[1]:
        out.append(f"the figure box {v['bbox']} is smaller than the chart")
    return out


@check("R2", "a rendered figure is not blank paper")
def r2_crop_ink(ctx: dict) -> list[str]:
    v = ctx["figure"]["vector"]
    if v is None:
        return []
    return [] if v["ink"] >= CROP_INK_MIN else \
        [f"the figure PNG is {v['ink']:.3f} inked (floor {CROP_INK_MIN})"]


@check("R3", "an extracted raster image is the image that was embedded")
def r3_raster(ctx: dict) -> list[str]:
    r = ctx["figure"]["raster"]
    if r is None:
        return []
    out = []
    if r["size"] != (400, 300):
        out.append(f"extracted image is {r['size']}, embedded one was (400, 300)")
    if not r["matches_source"]:
        out.append("the extracted image's pixels differ from the embedded source")
    return out


@check("L1", "list items keep their markers")
def l1_lists(ctx: dict) -> list[str]:
    md = ctx["runs"]["styles"]["md"]
    return [f"missing list item {item!r}" for item in LIST_ITEMS if item not in md]


@check("M1", "a sentence split across two lines is rejoined")
def m1_merge(ctx: dict) -> list[str]:
    return [] if MERGED_SENTENCE in ctx["runs"]["styles"]["md"] else \
        ["the two halves of the closing sentence were not merged"]


@check("K1", "radical lookalikes are folded onto real characters")
def k1_radicals(ctx: dict) -> list[str]:
    out = []
    if ctx["deck_radicals"]:
        out.append(f"{ctx['deck_radicals']} radical-block codepoint(s) survived "
                   f"into the deck output")
    for src, want in RADICAL_PAIRS:
        got = ctx["radical_map"].get(src)
        if got != want:
            out.append(f"{src!r} folded to {got!r}, expected {want!r}")
    missing = [s for s in DECK_CJK_SAMPLES if s not in ctx["deck_cjk_present"]]
    if missing:
        out.append(f"the deck lost these words entirely: {missing}")
    return out


@check("K2", "the fold does not rewrite characters the document meant")
def k2_fold_scope(ctx: dict) -> list[str]:
    """Blanket NFKC would turn ① into 1 and ％ into %. Component radicals are
    parts of characters, not characters, and must survive untouched too."""
    out = []
    for src, got in ctx["nfkc_safe"].items():
        if got != src:
            out.append(f"{src!r} was rewritten to {got!r} — the fold is too wide")
    for src, got in ctx["radical_untouched"].items():
        if got != src:
            out.append(f"component radical {src!r} was rewritten to {got!r}")
    return out


@check("P1", "every page of the real corpus is represented")
def p1_pages(ctx: dict) -> list[str]:
    got = ctx["deck_page_markers"]
    return [] if got == DECK_PAGES - 1 else \
        [f"{got} page markers, expected {DECK_PAGES - 1}"]


@check("X1", "a rotated page still yields its text")
def x1_rotated(ctx: dict) -> list[str]:
    """The one case where display space and page space differ. On an unrotated
    page a frame mix-up is invisible — both frames are the same numbers."""
    md = ctx["runs"]["rotated"]["md"]
    out = []
    for level, text in STYLE_HEADINGS:
        if (level, text) not in ctx["headings"]["rotated"]:
            out.append(f"rotated page lost its H{level} {text!r}")
    if BOLD_RUN not in md:
        out.append(f"rotated page lost {BOLD_RUN!r}")
    return out


# ── negative controls ─────────────────────────────────────────────────────────
def flaw_heading_flattened(ctx, work):
    """Reading every span as body text: the commonest way a rewrite loses structure."""
    ctx["headings"]["styles"] = [(1, "styles")]
    ctx["runs"]["styles"]["md"] = ctx["runs"]["styles"]["md"].replace("## ", "")
    return ctx


def flaw_deck_headings_lost(ctx, work):
    for h in DECK_HEADINGS:
        ctx["runs"]["deck"]["md"] = ctx["runs"]["deck"]["md"].replace(h, h.lstrip("# "))
    return ctx


def flaw_bold_dropped(ctx, work):
    """flags gone, every span plain — what a naive port produces."""
    ctx["runs"]["styles"]["md"] = ctx["runs"]["styles"]["md"].replace(BOLD_RUN,
                                                                     "thirty eight percent")
    return ctx


def flaw_italic_dropped(ctx, work):
    ctx["runs"]["styles"]["md"] = ctx["runs"]["styles"]["md"].replace(ITALIC_RUN,
                                                                     "appendix two")
    return ctx


def flaw_bold_italic_split(ctx, work):
    ctx["runs"]["styles"]["md"] = ctx["runs"]["styles"]["md"].replace(
        BOLD_ITALIC_RUN, f"**{BOLD_ITALIC_RUN.strip('*')}**")
    return ctx


def flaw_mono_gets_emphasis(ctx, work):
    ctx["runs"]["styles"]["md"] = ctx["runs"]["styles"]["md"].replace(
        CODE_LINE, f"**{CODE_LINE}**")
    return ctx


def flaw_semibold_not_bold(ctx, work):
    """The alternative reading of the one deliberate behaviour change.

    PyMuPDF called every Chinese glyph in the deck non-bold because Chrome emits
    them as Type3 fonts with no descriptor. Matching that answer by excluding
    "semibold" from the bold test is the plausible other choice, and B5 is where
    that choice is written down instead of drifting.
    """
    ctx["font_rule"]["PingFangSC-Semibold"] = (False, False)
    return ctx


def flaw_subset_tag_kept(ctx, work):
    """Not stripping the `AAAAAA+` prefix. Substring tests still pass, so this
    only shows up where names are compared."""
    ctx["font_rule"]["AAAAAA+HelveticaNeue-Bold"] = (False, False)
    return ctx


def flaw_table_cell_wrong(ctx, work):
    ctx["table_rows"][2] = "|Pilot|9999|0.8|"
    return ctx


def flaw_table_header_missing(ctx, work):
    ctx["table_rows"] = [r for r in ctx["table_rows"] if not r.startswith("|---")]
    return ctx


def flaw_bordered_box_is_a_table(ctx, work):
    """pdfplumber's own answer before the 2x2 floor: a card becomes a 1x1 table
    and the caller then drops the text inside it as table content."""
    ctx["card_table_rows"] = ["||", "|---|",
                              "|Route A Roll out to all three hundred engineers|"]
    ctx["card_text_kept"] = False
    ctx["deck_table_rows"] = ["||", "|---|"] + ctx["deck_table_rows"]
    return ctx


def flaw_noise_kept(ctx, work):
    ctx["noise"]["header_occurrences"] = HEADFOOT_PAGES
    ctx["noise"]["footer_occurrences"] = HEADFOOT_PAGES
    return ctx


def flaw_noise_eats_content(ctx, work):
    """Too low a threshold: 'repeated' starts matching the body text as well."""
    ctx["noise"]["unique_markers"] = 1
    return ctx


def flaw_crop_whole_page(ctx, work):
    """Ignoring the clip and rendering the entire page: still an image, still
    inked, still plausible in a manifest."""
    v = ctx["figure"]["vector"]
    v["bbox"] = [0.0, 0.0, W, H]
    v["align"] = 41.0
    return ctx


def flaw_crop_blank(ctx, work):
    ctx["figure"]["vector"]["ink"] = 0.001
    return ctx


def flaw_raster_reencoded_wrong(ctx, work):
    ctx["figure"]["raster"]["matches_source"] = False
    return ctx


def flaw_lists_flattened(ctx, work):
    md = ctx["runs"]["styles"]["md"]
    for item in LIST_ITEMS:
        md = md.replace(item, item.split(" ", 1)[1])
    ctx["runs"]["styles"]["md"] = md
    return ctx


def flaw_lines_not_merged(ctx, work):
    ctx["runs"]["styles"]["md"] = ctx["runs"]["styles"]["md"].replace(
        MERGED_SENTENCE,
        "The rollout plan splits the population into four cohorts of\n\nroughly equal size.")
    return ctx


def flaw_radicals_left(ctx, work):
    """No fold at all: what pdfminer hands over, and it looks correct on screen."""
    ctx["deck_radicals"] = 8
    ctx["radical_map"]["⼒"] = "⼒"
    ctx["deck_cjk_present"] = [s for s in ctx["deck_cjk_present"]
                               if s not in ("压力", "人力", "使用时长")]
    return ctx


def flaw_blanket_nfkc(ctx, work):
    """Folding with NFKC over the whole string instead of per radical."""
    ctx["nfkc_safe"] = {s: unicodedata.normalize("NFKC", s)
                        for s in ctx["nfkc_safe"]}
    ctx["radical_untouched"] = {c: unicodedata.normalize("NFKC", c)
                                for c in ctx["radical_untouched"]}
    return ctx


def flaw_page_markers_lost(ctx, work):
    ctx["deck_page_markers"] = 0
    return ctx


def flaw_rotated_page_empty(ctx, work):
    """Clustering a rotated page's lines on the wrong matrix axis: every character
    lands in its own line, and nothing survives the heading heuristics."""
    ctx["headings"]["rotated"] = [(1, "rotated")]
    ctx["runs"]["rotated"]["md"] = "# rotated\n"
    return ctx


def flaw_stdout_flooded(ctx, work):
    """The real measurement from before the guard: pdfminer's per-font warning,
    168 times over. Not invented damage — this is what the tree actually did."""
    noise = ("Could not get FontBBox from font descriptor because None cannot be "
             "parsed as 4 floats\n") * 168
    ctx["runs"]["deck"]["stdout"] = noise + ctx["runs"]["deck"]["stdout"]
    return ctx


def flaw_stdout_silenced(ctx, work):
    """Silencing the noise by silencing everything — the over-correction."""
    ctx["runs"]["deck"]["stdout"] = ""
    return ctx


def flaw_still_imports_fitz(ctx, work):
    ctx["fitz_free"] = False
    ctx["fitz_importers"] = ["skills/builtin/deckcraft/scripts/source_to_md/pdf_to_md.py"]
    return ctx


def flaw_fixture_loses_the_figure(ctx, work):
    ctx["figure"]["vector"] = None
    ctx["manifest"] = ctx["manifest"][:1]
    return ctx


# -- controls that re-run the real code with a constant moved -----------------
def live_gap_too_low(ctx, work):
    """0.2 sits below the measured 0.2500 letter-spacing step, so the deck's
    kickers shatter into single letters again — which is what PyMuPDF did."""
    md = measure_gap_ratio(DECK, work, 0.2)
    ctx["runs"]["deck"]["md"] = md
    ctx["deck_letterspaced_ok"] = DECK_LETTERSPACED in md
    ctx["deck_separated_ok"] = DECK_SEPARATED in md
    ctx["gap_ratio"] = 0.2
    return ctx


def live_gap_too_high(ctx, work):
    """3.0 sits above the closest real separation: columns glue together."""
    md = measure_gap_ratio(DECK, work, 3.0)
    ctx["runs"]["deck"]["md"] = md
    ctx["deck_letterspaced_ok"] = DECK_LETTERSPACED in md
    ctx["deck_separated_ok"] = DECK_SEPARATED in md
    ctx["gap_ratio"] = 3.0
    return ctx


def live_crop_flipped(ctx, work):
    """The real y-flip, rendered for real — not a number typed into the context.

    This is the control that decides how R1 is written: the flipped crop is MORE
    inked than the correct one on this fixture, so an ink floor passes it.
    """
    v = ctx["figure"]["vector"]
    if v is None:
        return ctx
    align, ink = measure_flipped_crop(work / "fx" / "figure.pdf", v["bbox"], work)
    v["align"], v["ink"] = align, ink
    return ctx


FLAWS = [
    ("heading-levels-flattened", flaw_heading_flattened, {"H1", "V0"},
     "V0 also fires, and should: the injected defect destroys the very subject V0 counts, so the fixture genuinely no longer has one"),
    ("real-corpus-headings-lost", flaw_deck_headings_lost, {"H2"}, ""),
    ("bold-run-dropped", flaw_bold_dropped, {"B1"}, ""),
    ("italic-run-dropped", flaw_italic_dropped, {"B2"}, ""),
    ("bold-italic-read-as-bold", flaw_bold_italic_split, {"B3"}, ""),
    ("monospace-run-gets-emphasis", flaw_mono_gets_emphasis, {"B4"}, ""),
    ("semibold-not-treated-as-bold", flaw_semibold_not_bold, {"B5"}, ""),
    ("subset-tag-left-on-the-font-name", flaw_subset_tag_kept, {"B5"}, ""),
    ("table-misread-a-cell", flaw_table_cell_wrong, {"T1"}, ""),
    ("table-written-without-a-header-rule", flaw_table_header_missing, {"T1", "V0"},
     "V0 also fires, and should: the injected defect destroys the very subject V0 counts, so the fixture genuinely no longer has one"),
    ("bordered-box-reported-as-a-table", flaw_bordered_box_is_a_table, {"T2"}, ""),
    ("repeated-header-and-footer-kept", flaw_noise_kept, {"N1"}, ""),
    ("noise-removal-eats-the-page-body", flaw_noise_eats_content, {"N2", "V0"},
     "V0 also fires, and should: the injected defect destroys the very subject V0 counts, so the fixture genuinely no longer has one"),
    ("figure-crop-renders-the-whole-page", flaw_crop_whole_page, {"R1"}, ""),
    ("figure-crop-lands-on-blank-paper", flaw_crop_blank, {"R2"}, ""),
    ("extracted-image-is-not-the-embedded-one", flaw_raster_reencoded_wrong, {"R3"}, ""),
    ("list-markers-flattened", flaw_lists_flattened, {"L1"}, ""),
    ("wrapped-sentence-left-split", flaw_lines_not_merged, {"M1"}, ""),
    ("radical-lookalikes-left-in-place", flaw_radicals_left, {"K1", "V0"},
     "V0 also fires, and should: the injected defect destroys the very subject V0 counts, so the fixture genuinely no longer has one"),
    ("fold-applied-as-blanket-NFKC", flaw_blanket_nfkc, {"K2"}, ""),
    ("page-break-markers-lost", flaw_page_markers_lost, {"P1", "V0"},
     "V0 also fires, and should: the injected defect destroys the very subject V0 counts, so the fixture genuinely no longer has one"),
    ("rotated-page-clustered-on-the-wrong-axis", flaw_rotated_page_empty, {"X1"}, ""),
    ("tree-still-imports-fitz", flaw_still_imports_fitz, {"A1"}, ""),
    ("stdout-flooded-by-the-library's-own-warnings", flaw_stdout_flooded, {"O1"}, ""),
    ("progress-reporting-silenced-along-with-the-noise", flaw_stdout_silenced, {"O1"}, ""),

    ("LIVE: space threshold below the letter-spacing ceiling", live_gap_too_low,
     {"G1", "G3"}, "G3 also fires, and must: the ratio itself is now outside the "
                   "measured band, which is the same fact G1 observes downstream"),
    ("LIVE: space threshold above the nearest real separation", live_gap_too_high,
     {"G2", "G3"}, "G3 also fires for the same reason as the low case"),
    ("LIVE: figure crop flipped vertically", live_crop_flipped, {"R1"},
     "R2 deliberately does NOT fire: the flipped crop is MORE inked than the "
     "correct one, which is exactly why R1 cannot be an ink test"),

    ("CONTROL: fixture loses the vector figure", flaw_fixture_loses_the_figure,
     {"V0"}, ""),
]


def fired(ctx: dict, skip: set[str] = frozenset()) -> dict[str, list[str]]:
    out = {}
    for cid, c in CHECKS.items():
        if cid in skip:
            continue
        findings = c["fn"](ctx)
        if findings:
            out[cid] = findings
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    SKIPS.clear()
    have_deck = DECK.is_file()
    if not have_deck:
        SKIPS.append(f"the real corpus is not in this checkout ({DECK.name}); "
                     f"{len(DECK_CHECKS)} assertion(s) and their controls cannot run")

    results = []
    with tempfile.TemporaryDirectory(prefix="deckcraft-pdf-md-") as td:
        work = Path(td)
        base = collect(work)

        skip = set() if have_deck else DECK_CHECKS
        clean = fired(base, skip)
        results.append({"case": "real output of the real converter", "expect": "silence",
                        "ok": not clean,
                        "detail": [f"{k}: {v[0]}" for k, v in clean.items()]})

        matrix = []
        for name, mutate, expected, cascade in FLAWS:
            # Without the corpus a check in DECK_CHECKS cannot fire, so expecting it
            # to would make the suite red for a reason that has nothing to do with
            # the code. Subtract rather than test for a subset: several controls
            # expect a MIX (e.g. {"G1","G3"} — one needs the corpus, one does not),
            # and a subset test leaves those half-asserted and failing.
            expected = expected - skip
            if not expected:
                SKIPS.append(f"negative control {name!r}: needs the real corpus")
                continue
            ctx = mutate(copy.deepcopy(base), work)
            got = fired(ctx, skip)
            unexpected = set(got) - expected
            missing = expected - set(got)
            matrix.append({"flaw": name, "expected": sorted(expected),
                           "fired": sorted(got), "cascade_note": cascade})
            detail = []
            if missing:
                detail.append(f"expected {sorted(missing)} to fire and it did not")
            if unexpected and not cascade:
                detail.append(f"unexpected checks fired: {sorted(unexpected)} — either "
                              f"a real cascade that needs documenting, or a check "
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
        print(f"  {m['flaw']:<52} -> {', '.join(m['fired']) or '(nothing)'}{note}")
    if SKIPS:
        # Named one by one. A skip and a pass look identical at a glance, which is
        # exactly how a wrong expectation once sat unnoticed for a month (059 §7).
        print("\n[skipped] claims this checkout could not exercise:")
        for note in SKIPS:
            print(f"  - {note}")
    ran = len(CHECKS) - (0 if have_deck else len(DECK_CHECKS))
    print(f"\n[deckcraft-pdf-md] {len(results) - len(failed)} passed, "
          f"{len(failed)} failed, {ran} assertions"
          + (f", {len(SKIPS)} skipped" if SKIPS else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
