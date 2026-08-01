#!/usr/bin/env python3
"""P13 + P14 — build a PDF from a document spec, with the font actually embedded.

    python3 pdf_create.py --in doc.json --out report.pdf
    python3 pdf_create.py --in doc.json --out report.pdf --font-report fonts.json
    python3 pdf_create.py --in doc.json --out report.pdf --font ~/fonts/MyBrand.ttf

doc.json:

    {"page": {"size": "A4", "orientation": "portrait", "margin": 56},
     "font_size": 11,
     "blocks": [
       {"type": "heading",   "text": "季度经营分析报告", "level": 1},
       {"type": "paragraph", "text": "本季度营业收入…"},
       {"type": "bullets",   "items": ["第一条", "第二条"]},
       {"type": "table",     "header": ["科目", "本季度"],
                             "rows": [["营业收入", "1,240"]]},
       {"type": "spacer",    "height": 12},
       {"type": "pagebreak"}]}

Pages break automatically when a block runs past the bottom margin.

The font is EMBEDDED and then subset (see pdfwrite.py): a generated document that
names a font instead of carrying it looks perfect here and turns into empty boxes
on a machine without that font. Characters the font cannot draw are refused before
anything is written, because a missing glyph produces no error of its own — pass
--allow-missing-glyphs to write anyway and have them listed in the report.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import fail, run, write_json  # noqa: E402
from pdfwrite import Typeface, embed, font_report, wrap  # noqa: E402

ALIAS = "UWF"
PAPER = {"a4": (595, 842), "letter": (612, 792), "a5": (420, 595), "a3": (842, 1191)}
HEADING_SCALE = {1: 1.9, 2: 1.5, 3: 1.25}
LINE_RATIO = 1.5           # leading as a multiple of the font size
BULLET = "• "
CELL_PAD = 5
RULE = (0.62, 0.62, 0.62)


def page_size(spec: dict) -> tuple[float, float]:
    size = str(spec.get("size", "A4")).lower()
    if size not in PAPER:
        fail(f"unknown page size {spec.get('size')!r}; known: {', '.join(sorted(PAPER))}")
    w, h = PAPER[size]
    if str(spec.get("orientation", "portrait")).lower() == "landscape":
        w, h = h, w
    return w, h


def collect_text(blocks: list[dict]) -> str:
    """Every character the document will draw — the input to the coverage check."""
    parts = []
    for b in blocks:
        parts.append(str(b.get("text", "")))
        parts += [str(i) for i in b.get("items", [])]
        parts += [str(c) for c in b.get("header", [])]
        parts += [str(c) for row in b.get("rows", []) for c in row]
    return "\n".join(parts)


class Writer:
    """Places lines top-down and starts a new page when the margin is reached."""

    def __init__(self, doc, width, height, margin, face, size):
        self.doc, self.w, self.h = doc, width, height
        self.margin, self.face, self.size = margin, face, size
        self.page = None
        self.y = 0.0
        self.new_page()

    @property
    def text_width(self) -> float:
        return self.w - 2 * self.margin

    def new_page(self) -> None:
        self.page = self.doc.new_page(width=self.w, height=self.h)
        embed(self.page, ALIAS, self.face)
        self.y = self.margin

    def room_for(self, height: float) -> bool:
        return self.y + height <= self.h - self.margin

    def ensure(self, height: float) -> None:
        # A block taller than a whole page must not loop forever asking for room it
        # can never get; it starts on a fresh page and is allowed to run over.
        if not self.room_for(height) and self.y > self.margin:
            self.new_page()

    def line(self, text: str, size: float, x: float | None = None,
             color=(0, 0, 0)) -> None:
        leading = size * LINE_RATIO
        self.ensure(leading)
        # insert_text takes the BASELINE, so the ascent has to be added or the first
        # line of every page sits half outside the top margin.
        self.page.insert_text((self.margin if x is None else x, self.y + size),
                              text, fontname=ALIAS, fontsize=size, color=color)
        self.y += leading

    def paragraph(self, text: str, size: float, indent: float = 0.0) -> None:
        for ln in wrap(text, self.face, size, self.text_width - indent):
            self.line(ln, size, x=self.margin + indent)

    def table(self, header: list, rows: list[list], size: float) -> None:
        cols = max([len(header)] + [len(r) for r in rows]) if (header or rows) else 0
        if not cols:
            return
        avail = self.text_width
        # Column width from the widest cell, then scaled to fit — never wider than
        # the page, and never so narrow that a cell cannot hold one character.
        wants = []
        for c in range(cols):
            cells = ([str(header[c])] if c < len(header) else []) + \
                    [str(r[c]) for r in rows if c < len(r)]
            wants.append(max([self.face.width(t, size) for t in cells] or [0]) + 2 * CELL_PAD)
        total = sum(wants) or 1
        widths = [max(size + 2 * CELL_PAD, w * avail / total) for w in wants] \
            if total > avail else wants
        leading = size * LINE_RATIO

        def row(cells: list, bold_rule: bool) -> None:
            wrapped = [wrap(str(cells[c]) if c < len(cells) else "", self.face, size,
                            widths[c] - 2 * CELL_PAD) for c in range(cols)]
            height = max(len(w) for w in wrapped) * leading + CELL_PAD
            self.ensure(height + 2)
            top = self.y
            x = self.margin
            for c in range(cols):
                for i, ln in enumerate(wrapped[c]):
                    self.page.insert_text((x + CELL_PAD, top + size + i * leading), ln,
                                          fontname=ALIAS, fontsize=size)
                x += widths[c]
            self.y = top + height
            import fitz
            self.page.draw_line(fitz.Point(self.margin, self.y),
                                fitz.Point(self.margin + sum(widths), self.y),
                                color=RULE, width=1.0 if bold_rule else 0.5)
            self.y += 2

        if header:
            row(header, True)
        for r in rows:
            row(r, False)


def build(spec: dict, out: Path, font: str | None, allow_missing: bool) -> dict:
    import fitz

    blocks = spec.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        fail("the spec has no \"blocks\" list to draw")
    face = Typeface(font)
    text = collect_text(blocks)
    missing = face.missing_glyphs(text)
    if missing and not allow_missing:
        fail(f"{face.name} has no glyph for {len(missing)} character(s): "
             f"{''.join(missing[:20])} — they would come out as blanks with no error "
             f"anywhere. Use --font with a fuller face, or --allow-missing-glyphs.")

    w, h = page_size(spec.get("page") or {})
    margin = float((spec.get("page") or {}).get("margin", 56))
    size = float(spec.get("font_size", 11))
    doc = fitz.open()
    writer = Writer(doc, w, h, margin, face, size)

    for i, block in enumerate(blocks):
        kind = block.get("type", "paragraph")
        if kind == "heading":
            level = int(block.get("level", 1))
            if level not in HEADING_SCALE:
                fail(f"block #{i}: heading level {level}, supported: 1-3")
            writer.y += size * 0.6
            writer.paragraph(str(block.get("text", "")), size * HEADING_SCALE[level])
            writer.y += size * 0.3
        elif kind == "paragraph":
            writer.paragraph(str(block.get("text", "")), size)
            writer.y += size * 0.4
        elif kind == "bullets":
            for item in block.get("items", []):
                writer.paragraph(BULLET + str(item), size, indent=0)
            writer.y += size * 0.4
        elif kind == "table":
            writer.table(list(block.get("header", [])),
                         [list(r) for r in block.get("rows", [])], size)
            writer.y += size * 0.6
        elif kind == "spacer":
            writer.y += float(block.get("height", size))
        elif kind == "pagebreak":
            writer.new_page()
        else:
            fail(f"block #{i}: unknown type {kind!r}; supported: heading, paragraph, "
                 f"bullets, table, spacer, pagebreak")

    # Subsetting is what makes embedding affordable: the full CJK face is ~3.5MB and
    # only the glyphs used are needed. Measured 3,569,129 -> 10,675 bytes.
    doc.subset_fonts()
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out), garbage=4, deflate=True, no_new_id=True)
    report = font_report(doc, face, text)
    report.update({"out": str(out), "pages": doc.page_count,
                   "bytes": out.stat().st_size})
    doc.close()
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="spec", required=True, type=Path,
                    help="document spec (JSON)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--font", default=None,
                    help="TTF/OTF path, or a built-in name (helv, cour, tiro, "
                         "china-s...). Default: the CJK face PyMuPDF ships")
    ap.add_argument("--font-report", type=Path, default=None,
                    help="write what a reader on another machine will get")
    ap.add_argument("--allow-missing-glyphs", action="store_true")
    args = ap.parse_args()

    if not args.spec.is_file():
        fail(f"no such spec file: {args.spec}")
    try:
        spec = json.loads(args.spec.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"{args.spec.name} is not valid JSON: {e}")

    report = build(spec, args.out, args.font, args.allow_missing_glyphs)
    if args.font_report:
        write_json(args.font_report, report)
    print(json.dumps({k: v for k, v in report.items() if k != "fonts"},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(run(main))
