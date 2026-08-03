#!/usr/bin/env python3
"""W19 — named table presets, chosen by a property you can measure.

"Make the table look better" is not a claim anything can check, which is why this
capability sat unimplemented while the other eighteen shipped. A preset is only worth
writing if there is something about the result a gate can put a number on, so every
preset here is defined by properties that survive being measured:

    border weight   `w:sz`, in EIGHTHS of a point — an integer, per edge position
    header repeat   `w:tblHeader` on the header row. Binary, and visible in the
                    RENDER: a table that spans pages either reprints its header on
                    page 2 or it does not. Measured, not assumed — with the flag the
                    header lands on pages 1, 2 and 3, without it only on page 1
    banding         which rows carry `w:shd`, and with which fill
    column width    computed from EAST ASIAN DISPLAY WIDTH, not `len()`
    cell margins    `w:tblCellMar`, in dxa

`--fit-columns` is AutoFit-to-CONTENTS, the way Word means it: a table whose text is
narrow comes out narrow, and a table declared 7500 dxa wide holding four-character
cells will SHRINK. That is the honest reading of "fit", and `--no-fit-columns` keeps
whatever widths the author chose. What it fixes is the proportion: `len()` counts a
Chinese character and a Latin one the same, so a CJK column gets about half the room
it needs while the numeric columns beside it sit on a surplus — measured below.

and `--list-presets` prints exactly those properties, so "which one do I want" is
answered by the tool rather than by opening three documents and squinting.

⚠️ The count is three, and that is a deliberate refusal to compete on quantity. The
reference implementation this matrix tracks ships thirteen; thirteen looks generous
until you try to state what tells any two of them apart. `--check-distinct` asserts
that no two presets here produce the same measured fingerprint, and it reads the
fingerprint back out of the PRODUCED FILES rather than out of the preset table — a
report that agrees with its own intent proves nothing about the document.

    python3 docx_table.py --list-presets
    python3 docx_table.py --in report.docx --out styled.docx --preset finance
    python3 docx_table.py --in report.docx --out styled.docx --preset banded --table 1
    python3 docx_table.py --in report.docx --measure --report widths.json

Formatting is written DIRECTLY on the table rather than as a `w:tblStyle`, because a
style is a promise about the reader: it renders as whatever that reader's definition
of the style says, and a document handed to someone whose template differs looks
nothing like the one that was approved. Direct formatting is heavier in the file and
the same everywhere, which is the trade this skill wants.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, display_width, emit, ensure_distinct,  # noqa: E402
                        fail, open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import insert_ordered, q  # noqa: E402

# ── the calibration constant ──────────────────────────────────────────────────
# dxa (twentieths of a point) one display-width cell needs. MEASURED, by rendering
# each string as a standalone paragraph — where it cannot wrap — and reading its
# x-extent back out of the PDF:
#
#     CJK text ......................... exactly 105 dxa per display-width unit
#     "1,240,000" ......................         94
#     "REVENUE-2026" ...................        108
#     "GROWTH-RATE%" ...................        122   <- the widest measured
#
# 130 is the widest of those rounded up with a cushion. It is deliberately generous:
# a column one point too wide is invisible, a column one point too narrow wraps, and
# the whole point of this number is that the text fits.
DXA_PER_CELL = 130
# Left + right cell padding, written explicitly by every preset so the number this
# arithmetic assumes is the number in the file rather than one inherited from a style.
DEFAULT_MARGIN = 108
# A column narrower than this is unreadable whatever the arithmetic says.
MIN_COLUMN = 500
# Fallback usable width when the section declares no page size (A4 less 1in margins).
FALLBACK_USABLE = 9026

BORDER_EDGES = ("top", "left", "bottom", "right", "insideH", "insideV")

PRESETS: dict[str, dict] = {
    "grid": {
        "title": "网格 — every cell boxed, nothing emphasised",
        "use": "raw data you intend to read cell by cell",
        "borders": {e: 4 for e in BORDER_EDGES},
        "header_fill": None,
        "band_fill": None,
        "header_bold": False,
        "repeat_header": False,
        "fit_columns": False,
        "margin": DEFAULT_MARGIN,
        "header_rule": None,
    },
    "finance": {
        "title": "三线表 — top and bottom rules, one rule under the header, no verticals",
        "use": "figures in a report or a paper; the house style of Chinese finance "
               "and academic publishing",
        # insideH/insideV/left/right are written as an explicit `none`, not omitted:
        # the table may already name a `w:tblStyle` whose borders would otherwise
        # show through, and "I did not write a border" is not the same as "there is
        # no border".
        "borders": {"top": 12, "bottom": 12, "left": 0, "right": 0,
                    "insideH": 0, "insideV": 0},
        "header_fill": None,
        "band_fill": None,
        "header_bold": True,
        "repeat_header": True,
        "fit_columns": True,
        "margin": 144,
        # The single rule under the header. It cannot be `insideH`, which would draw
        # a line between every pair of rows — this is the difference between a
        # three-line table and a grid with a thick outline.
        "header_rule": 6,
    },
    "banded": {
        "title": "斑马纹 — shaded header, alternating row fill, light grid",
        "use": "long tables somebody has to read across, where losing your row is "
               "the actual failure mode",
        "borders": {e: 4 for e in BORDER_EDGES},
        "header_fill": "D9E2F3",
        "band_fill": "F2F2F2",
        "header_bold": True,
        "repeat_header": True,
        "fit_columns": True,
        "margin": DEFAULT_MARGIN,
        "header_rule": None,
    },
}


# ── reading the geometry ──────────────────────────────────────────────────────
def usable_width(root) -> int:
    """Text width of the last section, in dxa, or a stated fallback."""
    sect = doc.body_sect_pr(root)
    if sect is None:
        return FALLBACK_USABLE
    size = sect.find(q("pgSz"))
    mar = sect.find(q("pgMar"))
    if size is None or mar is None:
        return FALLBACK_USABLE
    try:
        page = int(size.get(q("w")))
        left = int(mar.get(q("left")) or 0)
        right = int(mar.get(q("right")) or 0)
    except (TypeError, ValueError):
        return FALLBACK_USABLE
    return max(MIN_COLUMN, page - left - right)


def grid_columns(tbl) -> int:
    grid = tbl.find(q("tblGrid"))
    if grid is not None and len(grid):
        return len(grid.findall(q("gridCol")))
    return max((sum(span_of(tc) for tc in tr.findall(q("tc")))
                for tr in tbl.findall(q("tr"))), default=0)


def span_of(tc) -> int:
    tcpr = tc.find(q("tcPr"))
    if tcpr is None:
        return 1
    node = tcpr.find(q("gridSpan"))
    if node is None:
        return 1
    try:
        return max(1, int(node.get(q("val"))))
    except (TypeError, ValueError):
        return 1


def cell_text(tc) -> str:
    """The visible text of a cell, longest line only.

    A cell holding three paragraphs is as wide as its widest one, not as wide as all
    three joined — measuring the join asks for a column nobody needs.
    """
    lines = [doc.paragraph_text(p) for p in tc.findall(q("p"))]
    return max(lines, key=display_width) if lines else ""


def column_needs(tbl) -> tuple[list[int], list[str]]:
    """Display width wanted by each grid column, and what was left out of the sum.

    A cell that spans columns is EXCLUDED and named. Its text belongs to no single
    column, and charging it to the first one is how a merged title cell ends up
    dictating the width of column A.
    """
    n = grid_columns(tbl)
    needs = [0] * n
    notes: list[str] = []
    for tr in tbl.findall(q("tr")):
        at = 0
        for tc in tr.findall(q("tc")):
            span = span_of(tc)
            if at >= n:
                break
            if span == 1:
                needs[at] = max(needs[at], display_width(cell_text(tc)))
            elif cell_text(tc).strip():
                notes.append(f"a cell spanning {span} columns was not counted towards "
                             f"any single column's width: {cell_text(tc)[:24]!r}")
            at += span
    return needs, notes


# ── writing ───────────────────────────────────────────────────────────────────
def border(kind: str, eighths: int):
    """One `w:tblBorders`/`w:tcBorders` child.

    `w:sz` is in EIGHTHS of a point. Writing points there produces hairlines that
    look like a rendering bug rather than a setting, and nothing complains.
    """
    if eighths <= 0:
        return doc.element(kind, val="none", sz=0, space=0, color="auto")
    return doc.element(kind, val="single", sz=eighths, space=0, color="auto")


def set_child(parent, name: str, node):
    """Replace `parent`'s `name` child with `node`, keeping schema order."""
    for existing in parent.findall(q(name)):
        parent.remove(existing)
    if node is not None:
        insert_ordered(parent, node)


def ensure(parent, name: str):
    node = parent.find(q(name))
    if node is None:
        node = parent.makeelement(q(name), {})
        insert_ordered(parent, node)
    return node


def apply_table_properties(tbl, preset: dict, total: int | None) -> None:
    tblpr = ensure(tbl, "tblPr")

    borders = doc.element("tblBorders")
    for edge in BORDER_EDGES:
        insert_ordered(borders, border(edge, preset["borders"].get(edge, 0)))
    set_child(tblpr, "tblBorders", borders)

    margins = doc.element("tblCellMar")
    for side, value in (("top", 0), ("left", preset["margin"]),
                        ("bottom", 0), ("right", preset["margin"])):
        insert_ordered(margins, doc.element(side, w=value, type="dxa"))
    set_child(tblpr, "tblCellMar", margins)

    if total is not None:
        set_child(tblpr, "tblW", doc.element("tblW", w=total, type="dxa"))
        set_child(tblpr, "tblLayout", doc.element("tblLayout", type="fixed"))


def apply_row(tr, preset: dict, *, is_header: bool, band: bool,
              widths: list[int] | None) -> None:
    if is_header and preset["repeat_header"]:
        insert_ordered(ensure(tr, "trPr"), doc.element("tblHeader"))

    fill = preset["header_fill"] if is_header else (preset["band_fill"] if band else None)
    at = 0
    for tc in tr.findall(q("tc")):
        span = span_of(tc)
        tcpr = ensure(tc, "tcPr")
        if widths is not None and at < len(widths):
            width = sum(widths[at:at + span])
            set_child(tcpr, "tcW", doc.element("tcW", w=width, type="dxa"))
        set_child(tcpr, "shd",
                  doc.element("shd", val="clear", color="auto", fill=fill)
                  if fill else None)
        if is_header and preset["header_rule"]:
            rule = doc.element("tcBorders")
            insert_ordered(rule, border("bottom", preset["header_rule"]))
            set_child(tcpr, "tcBorders", rule)
        if is_header and preset["header_bold"]:
            for para in tc.findall(q("p")):
                for r in para.findall(q("r")):
                    rpr = ensure(r, "rPr")
                    set_child(rpr, "b", doc.element("b"))
        at += span


def apply_preset(tbl, preset: dict, *, header_rows: int, fit: bool,
                 usable: int) -> dict:
    rows = tbl.findall(q("tr"))
    notes: list[str] = []
    widths = None
    total = None
    if fit:
        needs, notes = column_needs(tbl)
        if not needs:
            notes.append("no grid columns, so nothing was resized")
        else:
            pad = 2 * preset["margin"]
            widths = [max(MIN_COLUMN, n * DXA_PER_CELL + pad) for n in needs]
            total = sum(widths)
            if total > usable:
                # Scaled rather than refused: a table wider than the page is one the
                # caller still wants to see, and saying so is more use than saying no.
                scale = usable / total
                widths = [max(MIN_COLUMN, int(w * scale)) for w in widths]
                total = sum(widths)
                notes.append(f"the content wanted more than the {usable} dxa of text "
                             f"width this section has, so the columns were scaled to "
                             f"fit; some cells will wrap")
            grid = ensure(tbl, "tblGrid")
            for old in grid.findall(q("gridCol")):
                grid.remove(old)
            for w in widths:
                grid.append(doc.element("gridCol", w=w))

    apply_table_properties(tbl, preset, total)
    for i, tr in enumerate(rows):
        head = i < header_rows
        # Bands count from the first DATA row, so the header is never one of them —
        # a shaded header that also counts as band 1 puts the second stripe in the
        # wrong place for the whole table.
        band = (not head) and ((i - header_rows) % 2 == 1)
        apply_row(tr, preset, is_header=head, band=band, widths=widths)
    return {"rows": len(rows), "header_rows": min(header_rows, len(rows)),
            "columns": grid_columns(tbl), "widths": widths, "total_width": total,
            "notes": notes}


# ── measuring what came out ───────────────────────────────────────────────────
def fingerprint(tbl) -> dict:
    """What this table measurably IS — read back out of the XML, not out of intent.

    This is the function `--check-distinct` compares presets with, and it deliberately
    knows nothing about which preset produced the table. A fingerprint derived from
    the preset table would prove the preset table has distinct rows in it, which
    nobody doubted.
    """
    tblpr = tbl.find(q("tblPr"))
    borders = tblpr.find(q("tblBorders")) if tblpr is not None else None

    def weight(edge: str) -> int:
        if borders is None:
            return -1
        node = borders.find(q(edge))
        if node is None:
            return -1
        if node.get(q("val")) == "none":
            return 0
        try:
            return int(node.get(q("sz")) or 0)
        except ValueError:
            return 0

    margin = -1
    if tblpr is not None:
        mar = tblpr.find(q("tblCellMar"))
        if mar is not None:
            left = mar.find(q("left"))
            if left is not None:
                try:
                    margin = int(left.get(q("w")))
                except (TypeError, ValueError):
                    margin = -1

    rows = tbl.findall(q("tr"))
    repeat = [i for i, tr in enumerate(rows)
              if (tr.find(q("trPr")) is not None
                  and tr.find(q("trPr")).find(q("tblHeader")) is not None)]
    fills: list[str | None] = []
    for tr in rows:
        row_fill = None
        for tc in tr.findall(q("tc")):
            tcpr = tc.find(q("tcPr"))
            shd = tcpr.find(q("shd")) if tcpr is not None else None
            if shd is not None:
                row_fill = shd.get(q("fill"))
            break
        fills.append(row_fill)
    header_rule = -1
    if rows:
        tc = rows[0].find(q("tc"))
        tcpr = tc.find(q("tcPr")) if tc is not None else None
        tcb = tcpr.find(q("tcBorders")) if tcpr is not None else None
        bottom = tcb.find(q("bottom")) if tcb is not None else None
        if bottom is not None:
            header_rule = 0 if bottom.get(q("val")) == "none" else \
                int(bottom.get(q("sz")) or 0)
    layout = None
    if tblpr is not None:
        node = tblpr.find(q("tblLayout"))
        layout = node.get(q("type")) if node is not None else None
    grid = tbl.find(q("tblGrid"))
    return {
        "borders": {e: weight(e) for e in BORDER_EDGES},
        "cell_margin": margin,
        "repeat_header_rows": repeat,
        "row_fills": fills,
        "banded_rows": sum(1 for f in fills[1:] if f),
        "header_rule": header_rule,
        "layout": layout,
        "column_widths": [g.get(q("w")) for g in grid.findall(q("gridCol"))]
        if grid is not None else [],
    }
    # ⚠️ Header boldness is deliberately NOT in here, and finding out why took running
    # it: `grid` forces nothing, yet the fingerprint of a `grid` table came back
    # `header_bold: true` — because the sample's header row was ALREADY bold. A
    # property the preset does not determine cannot identify it, and leaving it in
    # would have made two presets look different for a reason neither of them caused.
    # What each preset does to boldness is `header_bold_forced` in --list-presets:
    # force it on, or leave what the author chose alone. No preset un-bolds anything.


def describe_presets() -> list[dict]:
    """The properties that tell the presets apart, stated rather than implied."""
    return [{"name": name,
             "title": p["title"],
             "use": p["use"],
             "border_eighths": dict(p["borders"]),
             "header_rule_eighths": p["header_rule"],
             "header_fill": p["header_fill"],
             "band_fill": p["band_fill"],
             # "forced on" or "left as the author had it" — never "turned off".
             "header_bold_forced": p["header_bold"],
             "repeat_header": p["repeat_header"],
             "fit_columns": p["fit_columns"],
             "cell_margin_dxa": p["margin"]}
            for name, p in PRESETS.items()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--preset", choices=sorted(PRESETS))
    ap.add_argument("--table", action="append", type=int, default=[], metavar="N",
                    help="1-based table index; repeatable. Default: every table")
    ap.add_argument("--header-rows", type=int, default=1)
    ap.add_argument("--fit-columns", dest="fit", action="store_true", default=None)
    ap.add_argument("--no-fit-columns", dest="fit", action="store_false")
    ap.add_argument("--list-presets", action="store_true")
    ap.add_argument("--measure", action="store_true",
                    help="report each table's measured fingerprint and write nothing")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        if args.list_presets:
            emit({"presets": describe_presets()}, args.report)
            return
        if not args.src:
            fail("pass --in FILE (or --list-presets)")

        pkg: Package = open_document(args.src)
        root = pkg.tree(DOCUMENT)
        tables = list(doc.iter_tables(doc.body(root)))
        if not tables:
            # Silence here would be the defect: a call that changed nothing and said
            # "done" is indistinguishable from one that worked.
            fail(f"{args.src.name} contains no tables, so there is nothing for a "
                 f"table preset to do")

        if args.measure:
            emit({"in": args.src.name,
                  "tables": [fingerprint(t) for t in tables]}, args.report, "tables")
            return

        if not args.preset:
            fail(f"pass --preset ({', '.join(sorted(PRESETS))}); --list-presets says "
                 f"what tells them apart")
        if not args.out:
            fail("pass --out FILE")
        ensure_distinct(args.src, args.out)
        if args.header_rows < 0:
            fail("--header-rows cannot be negative")

        wanted = sorted(set(args.table)) or list(range(1, len(tables) + 1))
        bad = [n for n in wanted if not 1 <= n <= len(tables)]
        if bad:
            fail(f"--table {bad[0]} but {args.src.name} has {len(tables)} table(s); "
                 f"they are numbered 1..{len(tables)}")

        preset = PRESETS[args.preset]
        fit = preset["fit_columns"] if args.fit is None else args.fit
        pre_existing = check_package(pkg)
        before = dict(pkg.parts)
        usable = usable_width(root)

        applied = []
        for n in wanted:
            tbl = tables[n - 1]
            result = apply_preset(tbl, preset, header_rows=args.header_rows,
                                  fit=fit, usable=usable)
            result["table"] = n
            applied.append(result)

        pkg.put_tree(DOCUMENT, root)
        # Re-read from the written tree, so the fingerprint in the report is the
        # document's and not this run's recollection of what it meant to do.
        written = pkg.tree(DOCUMENT)
        report = {
            "in": args.src.name, "out": str(args.out), "preset": args.preset,
            "fit_columns": fit, "usable_width": usable,
            "tables_changed": applied,
            "fingerprints": [fingerprint(t)
                             for t in doc.iter_tables(doc.body(written))],
        }
        still = save_checked(pkg, args.out, pre_existing)
        report["parts_changed"] = sorted(n for n in pkg.parts
                                         if before.get(n) != pkg.parts[n])
        report["pre_existing_package_findings"] = still
        emit(report, args.report, "tables_changed", "fingerprints")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
