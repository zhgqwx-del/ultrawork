#!/usr/bin/env python3
"""P3 — extract tables, and say how confident the detection was.

    python3 pdf_tables.py --in report.pdf --out tables.json
    python3 pdf_tables.py --in report.pdf --out tables.json --csv-dir ./csv
    python3 pdf_tables.py --in report.pdf --out tables.json --overlay boxes.pdf

Two detection strategies, and the difference matters enough to report per table:

  lines   the grid is drawn in the page. Reliable — the cell boundaries are facts
          in the file, not inferences.
  text    no usable ruling lines, so columns are guessed from where words line up.
          Works on many real documents and is wrong on some: measured on
          fixtures/table-grid.pdf, which holds the SAME table ruled on page 1 and
          unruled on page 2, `lines` reads page 1 as exactly 4x3 while `text` turns
          page 2 into 7x3 — the identical data, three phantom rows.

`--strategy auto` (default) tries lines first and falls back to text, and every
table in the output carries the `strategy` that found it plus `reliable`. A caller
that treats a guessed grid as ground truth is the failure this reports around, so
the report never hides which one it was.

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

STRATEGIES = ("auto", "lines", "text")
BOX_COLOR = {"lines": (0.10, 0.45, 0.85), "text": (0.85, 0.45, 0.10)}
SETTINGS = {
    "lines": {"vertical_strategy": "lines", "horizontal_strategy": "lines"},
    "text": {"vertical_strategy": "text", "horizontal_strategy": "text"},
}


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


def find(page, strategy: str):
    """Returns (tables, strategy_used). `auto` prefers a drawn grid."""
    order = ["lines", "text"] if strategy == "auto" else [strategy]
    for name in order:
        try:
            found = page.find_tables(SETTINGS[name])
        except Exception as e:  # noqa: BLE001 - the finder raises on odd geometry
            fail(f"table detection failed on page {page.page_number} "
                 f"with strategy {name!r}: {type(e).__name__}: {e}")
        if found:
            return list(found), name
    return [], order[-1]


def describe(table, index: int, strategy: str, rot: int, w: float, h: float) -> dict:
    cells = [[("" if c is None else str(c).replace("\n", " ")) for c in row]
             for row in table.extract()]
    return {
        "index": index,
        "strategy": strategy,
        # Only a drawn grid is evidence; a text-aligned guess is a hypothesis.
        "reliable": strategy == "lines",
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
                  "unreliable_count": 0}
        overlay_boxes: dict[int, list] = {}
        for i in wanted:
            page = pdf.pages[i]
            rot = int(page.rotation or 0) % 360
            w, h = float(page.width), float(page.height)
            tables, used = find(page, strategy)
            described = [describe(t, n, used, rot, w, h)
                         for n, t in enumerate(tables)]
            result["pages"].append({"number": i + 1, "strategy": used,
                                    "tables": described})
            result["table_count"] += len(described)
            result["unreliable_count"] += sum(1 for t in described if not t["reliable"])
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
