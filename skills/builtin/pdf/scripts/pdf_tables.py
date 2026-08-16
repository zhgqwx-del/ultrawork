#!/usr/bin/env python3
"""P3 — extract tables, and say how confident the detection was.

    python3 pdf_tables.py --in report.pdf --out tables.json
    python3 pdf_tables.py --in report.pdf --out tables.json --csv-dir ./csv
    python3 pdf_tables.py --in report.pdf --out tables.json --overlay boxes.pdf

Three detection strategies, and the difference matters enough to report per table:

  lines   the grid is drawn in the page. Reliable — the cell boundaries are facts
          in the file, not inferences.
  rules   horizontal rules and no verticals — the commonest Chinese business table.
          The rules say where the table IS and how its rows divide; the columns are
          then inferred INSIDE that region, where the surrounding prose is not there
          to drown out the gutters. Rows drawn, columns inferred.
  text    no usable ruling lines at all, so both rows and columns are guessed from
          where words line up.

`--strategy auto` (default) tries them in that order — drawn beats half-drawn beats
guessed — and every table carries the `strategy` that found it, `reliable` (a drawn
grid or not) and `evidence` saying which half was read and which half was inferred.
A caller that treats a guessed grid as ground truth is the failure this reports
around, so the report never hides which one it was.

⚠️ The guess is not always visibly wrong, which is the point of reporting it:
measured on fixtures/table-grid.pdf, which holds the SAME table ruled on page 1 and
unruled on page 2, both pages now come back 4x3 with byte-identical cells. Nothing
in the data says one of them was inferred — only the flag does.

Why `rules` had to exist, measured on a real quarterly report: rules under every row
and no verticals. `lines` needs both and found nothing, so `text` ran over the whole
page, where prose has no vertical gutters, and swept it into a 65x1 "table" whose
first cell was the document title — written out as a CSV and reported as a table.
A one-column result is now rejected outright: it is a paragraph, not a table.

KNOWN DEGRADATION vs the PyMuPDF build this replaces: `header_external` is always
null. PyMuPDF detected whether a table's header row was drawn above the grid rather
than inside it; pdfplumber has no such notion, so `header` here is simply the first
extracted row. That is the right answer for a ruled table and a guess for an
unruled one — which `reliable` already says.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import (draw_boxes_overlay, ensure_distinct, fail,  # noqa: E402
                       parse_pages, run, to_page_space, write_json)

STRATEGIES = ("auto", "lines", "rules", "text")
BOX_COLOR = {"lines": (0.10, 0.45, 0.85), "rules": (0.20, 0.60, 0.35),
             "text": (0.85, 0.45, 0.10)}
SETTINGS = {
    "lines": {"vertical_strategy": "lines", "horizontal_strategy": "lines"},
    # The row pass of the `rules` strategy: horizontal rules bound the rows, and
    # nothing is asked of the columns yet.
    "rules": {"vertical_strategy": "text", "horizontal_strategy": "lines"},
    "text": {"vertical_strategy": "text", "horizontal_strategy": "text"},
}
# What each strategy actually KNOWS, as opposed to how confident it feels. `reliable`
# stays a bool (a drawn grid or not) because callers and L2 read it; this says which
# half of the grid was drawn and which half was inferred, because for the commonest
# Chinese business table the honest answer is "one of each".
EVIDENCE = {
    "lines": {"rows": "drawn", "columns": "drawn"},
    "rules": {"rows": "drawn", "columns": "inferred"},
    "text": {"rows": "inferred", "columns": "inferred"},
}
MIN_COLS = 2        # see `extract`: a one-column "table" is a paragraph


def open_plumber(src: Path, password: str | None):
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect
    if not src.is_file():
        fail(f"no such file: {src}")
    try:
        return pdfplumber.open(str(src), password=password or "")
    except PDFPasswordIncorrect:
        if password is None:
            fail(f"{src.name} is password-protected: pass --password")
        fail(f"the supplied --password was rejected by {src.name}")
    except Exception as e:  # noqa: BLE001 - pdfminer raises several unrelated types
        fail(f"cannot open {src.name} as a PDF: {type(e).__name__}: {e}")


def _rule_bands(page) -> list[tuple[float, float, list[float]]]:
    """Groups of horizontal rules that share an x span: (x0, x1, sorted ys).

    The rules are read straight off the page rather than asked for from
    `find_tables`. That was the first design and it was wrong: pdfplumber's
    horizontal-lines/vertical-text mode still derives its VERTICAL edges from
    page-wide text alignment, which is exactly the thing that fails on a page of
    prose — it happened to work on the report this came from and found nothing at
    all on a fixture built to reproduce it. The rules are the evidence; they should
    be the thing that locates the table.
    """
    bands: dict[tuple[float, float], set] = {}
    for obj in list(page.lines) + list(page.rects):
        if abs(float(obj["top"]) - float(obj["bottom"])) > 1.5:
            continue        # a vertical, or a filled box
        key = (round(float(obj["x0"]), 0), round(float(obj["x1"]), 0))
        if key[1] - key[0] < 40:
            continue        # a rule too short to bound a table
        bands.setdefault(key, set()).add(round(float(obj["top"]), 1))
    # One rule is an underline or a divider; a table has at least a top and a bottom.
    out = []
    for (x0, x1), ys in bands.items():
        for run in _split_runs(sorted(ys)):
            if len(run) >= 2:
                out.append((x0, x1, run))
    return out


def _split_runs(ys: list[float]) -> list[list[float]]:
    """Break one x-span's rules where the spacing says a new table started.

    Two tables of the SAME width on one page share an x span, so grouping by span
    alone welds them into one — measured: two 3-row tables 160pt apart came back as
    a single 6x3 whose fourth row was the second table's HEADER. The row pitch
    inside a table is regular and the gap between two tables is not, so the split is
    made where a gap runs past a multiple of the median — a threshold read off the
    document rather than chosen.
    """
    import statistics

    if len(ys) < 3:
        return [ys]
    gaps = [b - a for a, b in zip(ys, ys[1:])]
    limit = statistics.median(gaps) * 2.5
    runs, current = [], [ys[0]]
    for gap, y in zip(gaps, ys[1:]):
        if gap > limit:
            runs.append(current)
            current = [y]
        else:
            current.append(y)
    runs.append(current)
    return runs


def _header_line(page, x0: float, x1: float, rules: list[float], columns: list[float]):
    """The table's header row, if the line above the topmost rule is one.

    In the commonest Chinese business table the rules sit UNDER each row, so the
    topmost rule is below the header and a region taken from the rules alone starts
    at the first DATA row — the header is simply lost. Measured on a real report:
    rules at y=312.6…430.1 every 23.5pt, header at 292.7-303.7.

    Three tests, all derived from the table rather than from constants:
      * the line sits within the rules' own x span (the prose above it runs to
        x=532 where the rules end at 351);
      * no further above the top rule than the table's own median row pitch;
      * ⚠️ and its words do not STRADDLE the column boundaries the data rows
        produced. That third one is what tells a header from a caption: measured on
        fixtures/report-cjk.pdf, the line above the rules is the table's TITLE
        («主要财务指标（单位：万元）»), it passes both geometric tests, and taking it
        as a header split it across three columns as '主要财务指标（单位：万元' / '）'
        / ''. A header lines up with its columns; a sentence does not.
    """
    import statistics

    gaps = [b - a for a, b in zip(rules, rules[1:])]
    reach = statistics.median(gaps) if gaps else 0.0
    interior = columns[1:-1]
    for line in page.extract_text_lines():
        if not (x0 - 4 <= float(line["x0"]) and float(line["x1"]) <= x1 + 4):
            continue
        if not rules[0] - reach <= float(line["bottom"]) <= rules[0]:
            continue
        band = page.crop((x0 - 2, float(line["top"]) - 1, x1 + 2,
                          float(line["bottom"]) + 1))
        if any(float(w["x0"]) < edge - 0.5 < float(w["x1"])
               for w in band.extract_words() for edge in interior):
            continue        # a word crosses a column: a caption, not a header
        return float(line["top"])
    return None


def _rule_tables(page) -> list:
    """Tables whose ROWS are drawn and whose columns have to be inferred.

    The gap this fills, measured on a real quarterly report: rules under every row
    and no verticals at all. `lines` needs both and finds nothing; `text` then runs
    over the WHOLE page, where a page of prose has no vertical gutters, and sweeps
    everything into a single column — that produced a 65x1 "table" whose first cell
    was the document title, dutifully written out as a CSV.

    The rules say WHERE the table is; the columns are only looked for INSIDE it,
    where the prose is not there to drown the gutters out.
    """
    out = []
    for x0, x1, rules in _rule_bands(page):
        def crop(top: float, bottom: float):
            return page.crop((max(0.0, x0 - 2), max(0.0, top),
                              min(float(page.width), x1 + 2),
                              min(float(page.height), bottom)))

        # Pass one runs on the DATA rows alone — between the rules, where every band
        # is a row of the table. The rules are handed over as the row edges rather
        # than re-derived: they ARE the rows, which is the whole claim
        # `evidence.rows = "drawn"` makes. Letting a text pass split the rows too
        # produced 11 rows for a 6-row table, the blank bands counting as rows.
        found = crop(rules[0] - 1, rules[-1] + 2).find_tables(
            {"horizontal_strategy": "explicit", "explicit_horizontal_lines": rules,
             "vertical_strategy": "text"})
        if not found:
            continue
        first = max(found, key=lambda t: len(t.columns or []))
        inferred = sorted({round(float(c.bbox[0]), 1) for c in first.columns} |
                          {round(float(first.columns[-1].bbox[2]), 1)})
        if len(inferred) < MIN_COLS + 1:
            continue
        xs = [x0] + inferred[1:-1] + [x1]
        # The column boundaries the data rows produced. Two things need them: the
        # header test below, and the final pass — text-derived vertical edges only
        # span the rows whose words made them, so the LAST row of a table whose
        # final line is shaped differently ("合计 1,284.6" against "硬件配套 160.4")
        # has no vertical edge crossing it and silently drops out (measured: 5 rows
        # returned for a 6-row table, the total missing).
        # The OUTER edges are the drawn rules, not the data: a header is routinely
        # wider than the values under it («收入占比» over «46.2%»), and an outer edge
        # taken from the widest DATA cell clips it — measured, the header came back
        # as '收入占'. Only the interior boundaries are inferred.
        header_top = _header_line(page, x0, x1, rules, xs)
        edges = ([header_top - 1] if header_top is not None else []) + rules
        settled = crop((header_top - 1) if header_top is not None else rules[0] - 1,
                       rules[-1] + 2).find_tables(
            {"horizontal_strategy": "explicit", "explicit_horizontal_lines": edges,
             "vertical_strategy": "explicit", "explicit_vertical_lines": xs})
        out.append(max(settled, key=lambda t: len(t.columns or [])) if settled
                   else first)
    return out


def find(page, strategy: str):
    """Returns (tables, strategy_used). `auto` prefers whatever is DRAWN.

    Order matters and is not arbitrary: a full grid is evidence, rules-only is half
    evidence, and text alignment is a guess. Trying `rules` before `text` is what
    stops the commonest Chinese table from falling all the way through to the guess.
    """
    order = ["lines", "rules", "text"] if strategy == "auto" else [strategy]
    dropped = 0
    for name in order:
        try:
            found = _rule_tables(page) if name == "rules" \
                else list(page.find_tables(SETTINGS[name]))
        except Exception as e:  # noqa: BLE001 - the finder raises on odd geometry
            fail(f"table detection failed on page {page.page_number} "
                 f"with strategy {name!r}: {type(e).__name__}: {e}")
        # A single column is a paragraph with a box drawn round it; taking it as a
        # table is what let a page of prose out of the door as a CSV. Rejecting here
        # rather than after means `auto` carries on to the next strategy instead of
        # stopping at a result it is about to throw away.
        usable = [t for t in found if len(t.columns or []) >= MIN_COLS]
        dropped += len(found) - len(usable)
        if usable:
            return usable, name, dropped
    return [], order[-1], dropped


def describe(table, index: int, strategy: str, rot: int, w: float, h: float) -> dict:
    cells = [[("" if c is None else str(c).replace("\n", " ")) for c in row]
             for row in table.extract()]
    # Empty rows are dropped only where the rows were INFERRED. On a drawn grid an
    # empty row is a fact about the document and throwing it away would lose real
    # structure; under `text` and `rules` it is an artefact of the inference — the
    # unruled half of fixtures/table-grid.pdf came back with three of them
    # interleaved through data that has none.
    if EVIDENCE[strategy]["rows"] == "inferred":
        cells = [row for row in cells if any(c.strip() for c in row)] or cells
    return {
        "index": index,
        "strategy": strategy,
        # Only a drawn grid is evidence; a text-aligned guess is a hypothesis.
        "reliable": strategy == "lines",
        # Which half of the grid was read and which half was inferred. `reliable`
        # alone cannot say "the rows are facts and the columns are a guess", which
        # is exactly what a rules-only table is.
        "evidence": EVIDENCE[strategy],
        "bbox": [round(float(v), 2)
                 for v in to_page_space(table.bbox, rot, w, h)],
        "bbox_display": [round(float(v), 2) for v in table.bbox],
        "rows": len(cells),
        "cols": max((len(r) for r in cells), default=0),
        "header": cells[0] if len(cells) > 1 else None,
        # pdfplumber cannot tell an external header from the first row; see the
        # module docstring. Reported as null rather than guessed.
        "header_external": None,
        "cells": cells,
    }


def extract(src: Path, pages: str | None, strategy: str, password: str | None,
            overlay: Path | None, csv_dir: Path | None) -> dict:
    pdf = open_plumber(src, password)
    try:
        page_count = len(pdf.pages)
        wanted = parse_pages(pages, page_count)
        result = {"source": str(src), "requested_strategy": strategy,
                  "page_count": page_count, "pages": [], "table_count": 0,
                  "unreliable_count": 0, "rejected_single_column": 0}
        overlay_boxes: dict[int, list] = {}
        for i in wanted:
            page = pdf.pages[i]
            rot = int(page.rotation or 0) % 360
            w, h = float(page.width), float(page.height)
            tables, used, dropped = find(page, strategy)
            described = [describe(t, n, used, rot, w, h)
                         for n, t in enumerate(tables)]
            result["pages"].append({"number": i + 1, "strategy": used,
                                    "tables": described})
            result["table_count"] += len(described)
            result["unreliable_count"] += sum(1 for t in described if not t["reliable"])
            # Counted, not silently swallowed: "0 tables found" and "everything found
            # was a paragraph" are different facts about a document, and a caller
            # deciding whether to look by hand needs to know which one it is.
            result["rejected_single_column"] += dropped
            if overlay is not None and described:
                overlay_boxes[i] = [
                    (t["bbox"], BOX_COLOR.get(t["strategy"], (0.5, 0.5, 0.5)))
                    for t in described]
            if csv_dir is not None:
                csv_dir.mkdir(parents=True, exist_ok=True)
                for t in described:
                    target = csv_dir / f"page{i + 1:03d}-table{t['index'] + 1}.csv"
                    with target.open("w", encoding="utf-8-sig", newline="") as fh:
                        # utf-8-sig: Excel reads a plain UTF-8 CSV of Chinese as
                        # mojibake, and the BOM is what makes it open correctly.
                        csv.writer(fh).writerows(t["cells"])
                    t["csv"] = target.name
        if overlay is not None:
            draw_boxes_overlay(src, overlay, overlay_boxes, password, width=0.7)
            result["overlay"] = str(overlay)
        return result
    finally:
        pdf.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path, help="JSON file to write")
    ap.add_argument("--pages", default=None, help="1-based, e.g. 1-3,7 (default: all)")
    ap.add_argument("--strategy", default="auto", choices=list(STRATEGIES))
    ap.add_argument("--password", default=None)
    ap.add_argument("--overlay", type=Path, default=None,
                    help="write a copy with each detected table boxed")
    ap.add_argument("--csv-dir", type=Path, default=None,
                    help="also write one CSV per table")
    args = ap.parse_args()

    if args.overlay:
        ensure_distinct(args.src, args.overlay, "--overlay")
    result = extract(args.src, args.pages, args.strategy, args.password,
                     args.overlay, args.csv_dir)
    write_json(args.out, result)
    print(json.dumps({k: v for k, v in result.items() if k != "pages"},
                     ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(run(main))
