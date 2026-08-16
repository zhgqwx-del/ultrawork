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
       {"type": "ordered",   "items": ["订阅制转型",
                                       {"text": "应收账款",
                                        "items": ["账龄 90 天以上 11.3%"]}]},
       {"type": "table",     "header": ["科目", "本季度"],
                             "rows": [["营业收入", "1,240"]]},
       {"type": "spacer",    "height": 12},
       {"type": "pagebreak"}]}

Pages break automatically when a block runs past the bottom margin.

`bullets` and `ordered` nest: an item may be a string, or an object with `text` and
its own `items` (which inherit the parent's kind unless the object names a `type`).
An ordered item is numbered by its PATH — 1., 1.1, 1.1.1 — because a nested list
rendered as a flat one loses both the number and the level, and a reader cannot get
either back. Wrapped lines hang under the text, not under the marker.

The font is EMBEDDED, subset (see pdfwrite.py): a generated document that names a
font instead of carrying it looks perfect here and turns into empty boxes on a
machine without that font. The default is a CJK face found on this machine; the
document that comes out is portable, only the machine generating it needs a font.
Characters the font cannot draw are refused before anything is written, because a
missing glyph produces no error of its own — pass --allow-missing-glyphs to write
anyway and have them listed in the report.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import fail, run, write_json  # noqa: E402
from pdfwrite import Typeface, font_report, wrap  # noqa: E402

PAPER = {"a4": (595, 842), "letter": (612, 792), "a5": (420, 595), "a3": (842, 1191)}
HEADING_SCALE = {1: 1.9, 2: 1.5, 3: 1.25}
LINE_RATIO = 1.5           # leading as a multiple of the font size
# One per nesting level, deepest repeated. Every one of these is passed through
# Typeface.marker() before it is drawn, because a face that lacks the character
# draws it as .notdef — a blank on the page and an error nowhere. That is not
# hypothetical: macOS Songti's Black face has no U+2022, it was the face this skill
# picked, and every bullet it ever wrote was invisible.
BULLETS = ("•", "–", "·")
CELL_PAD = 5
RULE = (0.62, 0.62, 0.62)
INDENT_RATIO = 1.8         # per nesting level, as a multiple of the font size


def _width(face, text: str, size: float, font: str | None) -> float:
    """Width of `text` at `size` in `font`, falling back to the face's own."""
    from reportlab.pdfbase import pdfmetrics
    return pdfmetrics.stringWidth(text, font or face.name, size)


def page_size(spec: dict) -> tuple[float, float]:
    size = str(spec.get("size", "A4")).lower()
    if size not in PAPER:
        fail(f"unknown page size {spec.get('size')!r}; known: {', '.join(sorted(PAPER))}")
    w, h = PAPER[size]
    if str(spec.get("orientation", "portrait")).lower() == "landscape":
        w, h = h, w
    return w, h


def item_parts(item, inherited: str) -> tuple[str, list, str]:
    """One list entry as (text, children, kind-of-children).

    A plain string is a leaf. An object may carry `items` of its own, and may name
    a `type` for them; when it does not, children are the same kind as their parent
    — a nested list under an ordered one is ordered unless the spec says otherwise.
    """
    if isinstance(item, dict):
        kind = str(item.get("type", inherited))
        return str(item.get("text", "")), list(item.get("items", []) or []), kind
    return str(item), [], inherited


def walk_items(items: list, inherited: str):
    """Every leaf text in a (possibly nested) list, depth-first."""
    for item in items or []:
        text, children, kind = item_parts(item, inherited)
        yield text
        yield from walk_items(children, kind)


def collect_text(blocks: list[dict]) -> str:
    """Every character the document will draw — the input to the coverage check.

    ⚠️ "Every character" has to include the ones the LAYOUT adds, not just the ones
    the caller wrote. This function used to collect text/items/header/rows and stop,
    so the bullet glyph — which the writer supplies itself — was never checked. It
    was missing from the chosen face, drew as .notdef, and the report said
    `missing_glyphs: []`. The guard was there; its input was short by exactly the
    characters no caller would ever think to declare.
    """
    parts = []
    for b in blocks:
        kind = str(b.get("type", "paragraph"))
        parts.append(str(b.get("text", "")))
        parts += list(walk_items(b.get("items", []), kind))
        parts += [str(c) for c in b.get("header", [])]
        parts += [str(c) for row in b.get("rows", []) for c in row]
    return "\n".join(parts)


def marker_charset(blocks: list[dict], face) -> str:
    """The characters the writer draws on its own behalf, for the same check.

    A superset on purpose — every bullet level plus the digits and the dot an
    ordered marker is built from — rather than a second walk of the tree that could
    drift out of step with the one that does the drawing.
    """
    if not any(str(b.get("type", "")) in ("bullets", "ordered") for b in blocks):
        return ""
    return "".join(face.marker(m) for m in BULLETS) + "0123456789. "


class Writer:
    """Places lines top-down and starts a new page when the margin is reached.

    The cursor `y` counts DOWN from the top of the page, the way every box this
    skill reports does; reportlab's canvas counts up from the bottom. The single
    conversion lives in `line`, because doing it per call site is how half a
    document ends up mirrored.
    """

    def __init__(self, canvas, width, height, margin, face, size):
        self.c, self.w, self.h = canvas, width, height
        self.margin, self.face, self.size = margin, face, size
        self.y = margin

    @property
    def text_width(self) -> float:
        return self.w - 2 * self.margin

    def new_page(self) -> None:
        self.c.showPage()
        self.y = self.margin

    def room_for(self, height: float) -> bool:
        return self.y + height <= self.h - self.margin

    def ensure(self, height: float) -> None:
        # A block taller than a whole page must not loop forever asking for room it
        # can never get; it starts on a fresh page and is allowed to run over.
        if not self.room_for(height) and self.y > self.margin:
            self.new_page()

    def line(self, text: str, size: float, x: float | None = None,
             color=(0, 0, 0), font: str | None = None) -> None:
        leading = size * LINE_RATIO
        self.ensure(leading)
        self.c.setFont(font or self.face.name, size)
        self.c.setFillColorRGB(*color)
        # drawString takes the BASELINE, so the ascent has to be added or the first
        # line of every page sits half outside the top margin.
        self.c.drawString(self.margin if x is None else x,
                          self.h - (self.y + size), text)
        self.y += leading

    def hang(self, marker: str, text: str, size: float, indent: float) -> None:
        """One list entry: marker at the indent, text hanging clear of it.

        Wrapped lines line up under the TEXT, not under the marker. Drawing them at
        the same x as the marker is what the previous version did (indent=0), and a
        three-line bullet then reads as three separate bullets.
        """
        width = self.face.width(marker, size)
        lines = wrap(text, self.face, size, self.text_width - indent - width) or [""]
        for i, ln in enumerate(lines):
            leading = size * LINE_RATIO
            self.ensure(leading)
            self.c.setFont(self.face.name, size)
            self.c.setFillColorRGB(0, 0, 0)
            baseline = self.h - (self.y + size)
            if i == 0:
                self.c.drawString(self.margin + indent, baseline, marker)
            self.c.drawString(self.margin + indent + width, baseline, ln)
            self.y += leading

    def list_block(self, items: list, kind: str, size: float,
                   level: int = 0, path: tuple[int, ...] = ()) -> None:
        """A bullet or ordered list, nested to any depth.

        An ordered item is numbered by its path (1., 1.1, 1.1.1). Flattening a
        nested list to one level — which is all this skill could do before — throws
        away both the number and the depth, and neither is recoverable from the PDF.
        """
        for n, item in enumerate(items or [], 1):
            text, children, child_kind = item_parts(item, kind)
            here = path + (n,)
            # 1. at the top level, 1.1 and 1.1.1 below it — the trailing dot belongs
            # to a single number, not to a dotted path (Word's own convention, and
            # "1.1." reads as an unfinished third level).
            marker = ((".".join(str(p) for p in here) + ("." if level == 0 else ""))
                      + " ") if kind == "ordered" \
                else self.face.marker(BULLETS[min(level, len(BULLETS) - 1)]) + " "
            self.hang(marker, text, size, level * size * INDENT_RATIO)
            if children:
                self.list_block(children, child_kind, size, level + 1, here)

    def rule(self, x0: float, x1: float, width: float) -> None:
        self.c.setStrokeColorRGB(*RULE)
        self.c.setLineWidth(width)
        self.c.line(x0, self.h - self.y, x1, self.h - self.y)

    def paragraph(self, text: str, size: float, indent: float = 0.0,
                  font: str | None = None) -> None:
        # Wrapped with the face it is DRAWN with: measuring a heading in the regular
        # weight and painting it in the bold one puts the last word past the margin.
        for ln in wrap(text, self.face, size, self.text_width - indent, font=font):
            self.line(ln, size, x=self.margin + indent, font=font)

    def table(self, header: list, rows: list[list], size: float) -> None:
        cols = max([len(header)] + [len(r) for r in rows]) if (header or rows) else 0
        if not cols:
            return
        avail = self.text_width
        # Column width from the widest cell, then scaled to fit — never wider than
        # the page, and never so narrow that a cell cannot hold one character.
        head_font = self.face.bold_name or self.face.name
        wants = []
        for c in range(cols):
            # The header is DRAWN in the bold companion, so it has to be MEASURED in
            # it too; measuring every cell in the regular weight makes the header the
            # one row guaranteed to be too wide for its column.
            widths_seen = [_width(self.face, str(header[c]), size, head_font)] \
                if c < len(header) else []
            widths_seen += [_width(self.face, str(r[c]), size, None)
                            for r in rows if c < len(r)]
            wants.append(max(widths_seen or [0]) + 2 * CELL_PAD)
        total = sum(wants) or 1
        widths = [max(size + 2 * CELL_PAD, w * avail / total) for w in wants] \
            if total > avail else wants
        leading = size * LINE_RATIO

        def row(cells: list, bold_rule: bool) -> None:
            font = (self.face.bold_name or self.face.name) if bold_rule \
                else self.face.name
            wrapped = [wrap(str(cells[c]) if c < len(cells) else "", self.face, size,
                            widths[c] - 2 * CELL_PAD, font=font) for c in range(cols)]
            height = max(len(w) for w in wrapped) * leading + CELL_PAD
            self.ensure(height + 2)
            top = self.y
            x = self.margin
            self.c.setFont(font, size)
            self.c.setFillColorRGB(0, 0, 0)
            for c in range(cols):
                for i, ln in enumerate(wrapped[c]):
                    self.c.drawString(x + CELL_PAD,
                                      self.h - (top + size + i * leading), ln)
                x += widths[c]
            self.y = top + height
            self.rule(self.margin, self.margin + sum(widths),
                      1.0 if bold_rule else 0.5)
            self.y += 2

        if header:
            row(header, True)
        for r in rows:
            row(r, False)


def build(spec: dict, out: Path, font: str | None, allow_missing: bool) -> dict:
    from reportlab.pdfgen import canvas

    blocks = spec.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        fail("the spec has no \"blocks\" list to draw")
    face = Typeface(font)
    # marker_charset() resolves the markers first (substituting any the face cannot
    # draw), so what lands in `text` is what will actually be painted — the whole
    # point being that the coverage check sees the layout's own characters too.
    text = collect_text(blocks) + "\n" + marker_charset(blocks, face)
    missing = face.missing_glyphs(text)
    if missing and not allow_missing:
        fail(f"{face.name} has no glyph for {len(missing)} character(s): "
             f"{''.join(missing[:20])} — they would come out as blanks with no error "
             f"anywhere. Use --font with a fuller face, or --allow-missing-glyphs.")

    w, h = page_size(spec.get("page") or {})
    margin = float((spec.get("page") or {}).get("margin", 56))
    size = float(spec.get("font_size", 11))
    out.parent.mkdir(parents=True, exist_ok=True)
    # initialFontName: without it reportlab writes a Helvetica the document never
    # draws with into every page's resources, and "is every font in this file
    # embedded" then answers no for a reason that has nothing to do with the text.
    c = canvas.Canvas(str(out), pagesize=(w, h), initialFontName=face.name,
                      initialFontSize=size)
    writer = Writer(c, w, h, margin, face, size)

    for i, block in enumerate(blocks):
        kind = block.get("type", "paragraph")
        if kind == "heading":
            level = int(block.get("level", 1))
            if level not in HEADING_SCALE:
                fail(f"block #{i}: heading level {level}, supported: 1-3")
            writer.y += size * 0.6
            # The bold companion when the family ships one. Without it a heading is
            # distinguishable only by size, which reads flat at h3 (1.25x body).
            writer.paragraph(str(block.get("text", "")), size * HEADING_SCALE[level],
                             font=face.bold_name)
            writer.y += size * 0.3
        elif kind == "paragraph":
            writer.paragraph(str(block.get("text", "")), size)
            writer.y += size * 0.4
        elif kind in ("bullets", "ordered"):
            writer.list_block(list(block.get("items", []) or []), kind, size)
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
                 f"bullets, ordered, table, spacer, pagebreak")

    # Subsetting is what makes embedding affordable, and reportlab does it as it
    # writes: only the glyphs actually drawn go into the file. Measured Songti.ttc
    # 66,933,080 bytes on disk -> a 17KB document, still embedded, still extractable.
    c.save()
    from pypdf import PdfReader
    report = font_report(out, face, text)
    # Counted out of the file, not off the writer's own tally: a spec ending in a
    # pagebreak asks for a page nothing is ever drawn on, and reportlab does not
    # write it. Reporting the request rather than the result is a report that
    # disagrees with its own artifact.
    report.update({"out": str(out), "pages": len(PdfReader(str(out)).pages),
                   "bytes": out.stat().st_size})
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="spec", required=True, type=Path,
                    help="document spec (JSON)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--font", default=None,
                    help="TrueType path to embed, or a standard face name (helv, "
                         "cour, tiro...) for a Latin-only document. Default: a CJK "
                         "face found on this machine and embedded, subset")
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
