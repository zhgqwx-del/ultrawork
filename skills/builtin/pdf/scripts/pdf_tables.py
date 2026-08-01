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
          fixtures/report-cjk.pdf, whose table has horizontal rules but no vertical
          ones, `lines` finds nothing and `text` returns a 7x3 table for a table
          that is really 4x3 — it swallows the heading above it.

`--strategy auto` (default) tries lines first and falls back to text, and every
table in the output carries the `strategy` that found it plus `reliable`. A caller
that treats a guessed grid as ground truth is the failure this reports around, so
the report never hides which one it was.
"""
from __future__ import annotations

import argparse
import contextlib
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import ensure_distinct, fail, open_pdf, parse_pages, run, write_json  # noqa: E402

STRATEGIES = ("auto", "lines", "text")
BOX_COLOR = {"lines": (0.10, 0.45, 0.85), "text": (0.85, 0.45, 0.10)}


def find(page, strategy: str):
    """Returns (tables, strategy_used). `auto` prefers a drawn grid."""
    order = ["lines", "text"] if strategy == "auto" else [strategy]
    for name in order:
        try:
            # find_tables prints an advisory ("Consider using the pymupdf_layout
            # package…") on STDOUT, which lands in the middle of this script's JSON
            # and breaks anything that pipes it. There is no switch for it —
            # mupdf_display_errors/warnings cover a different channel — so the call
            # is fenced and whatever it says is forwarded to stderr where library
            # chatter belongs.
            with contextlib.redirect_stdout(sys.stderr):
                found = page.find_tables(strategy=name)
        except Exception as e:  # noqa: BLE001 - the finder raises on odd geometry
            fail(f"table detection failed on page {page.number + 1} "
                 f"with strategy {name!r}: {type(e).__name__}: {e}")
        if found.tables:
            return list(found.tables), name
    return [], order[-1]


def describe(table, index: int, strategy: str) -> dict:
    cells = [[("" if c is None else str(c)) for c in row] for row in table.extract()]
    header = table.header
    return {
        "index": index,
        "strategy": strategy,
        # Only a drawn grid is evidence; a text-aligned guess is a hypothesis.
        "reliable": strategy == "lines",
        "bbox": [round(float(v), 2) for v in table.bbox],
        "rows": len(cells),
        "cols": max((len(r) for r in cells), default=0),
        "header": list(header.names) if header and header.names else None,
        "header_external": bool(header.external) if header else None,
        "cells": cells,
    }


def extract(src: Path, pages: str | None, strategy: str, password: str | None,
            overlay: Path | None, csv_dir: Path | None) -> dict:
    import fitz

    doc = open_pdf(src, password)
    with doc:
        wanted = parse_pages(pages, doc.page_count)
        result = {"source": str(src), "requested_strategy": strategy,
                  "page_count": doc.page_count, "pages": [], "table_count": 0,
                  "unreliable_count": 0}
        for i in wanted:
            page = doc[i]
            tables, used = find(page, strategy)
            described = [describe(t, n, used) for n, t in enumerate(tables)]
            result["pages"].append({"number": i + 1, "strategy": used,
                                    "tables": described})
            result["table_count"] += len(described)
            result["unreliable_count"] += sum(1 for t in described if not t["reliable"])
            if overlay is not None:
                for t in described:
                    page.draw_rect(fitz.Rect(t["bbox"]),
                                   color=BOX_COLOR.get(t["strategy"], (0.5, 0.5, 0.5)),
                                   width=0.7)
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
            overlay.parent.mkdir(parents=True, exist_ok=True)
            doc.save(str(overlay), garbage=4, deflate=True, no_new_id=True)
            result["overlay"] = str(overlay)
        return result


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
