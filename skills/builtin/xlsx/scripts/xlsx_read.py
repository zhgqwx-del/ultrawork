#!/usr/bin/env python3
"""X1 — read cells, sheets and ranges out of a workbook.

Reads two views of every cell because a spreadsheet has two, and confusing them is
the classic mistake:

    value   — what the last application to calculate the file left behind (the
              CACHED result; absent in a file written by a library)
    formula — the expression itself

`openpyxl.load_workbook(data_only=True)` gives the first and `data_only=False` the
second, and neither alone is the truth. A file this skill wrote has formulas and no
cached values at all, so a reader that only asks for values reports an empty sheet
and every downstream conclusion is drawn from nothing.

    python3 xlsx_read.py --in book.xlsx                       # sheet inventory
    python3 xlsx_read.py --in book.xlsx --sheet 利润表 --range A1:D12
    python3 xlsx_read.py --in book.xlsx --cells B4 C4 --out cells.json
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from xlsxcommon import XlsxError, emit, fail, has_cjk, run  # noqa: E402

MAX_SCAN_CELLS = 200_000


def load_pair(path: Path):
    import openpyxl
    if not path.is_file():
        fail(f"no such file: {path}")
    try:
        formulas = openpyxl.load_workbook(path, data_only=False)
        values = openpyxl.load_workbook(path, data_only=True)
    except Exception as e:  # noqa: BLE001 - openpyxl raises several unrelated types
        fail(f"cannot open {path.name} as a workbook: {type(e).__name__}: {e}")
    return formulas, values


def cell_entry(fws, vws, ref: str) -> dict:
    from openpyxl.utils.cell import coordinate_from_string
    try:
        coordinate_from_string(ref)
    except Exception as e:  # noqa: BLE001
        fail(f"{ref!r} is not a cell reference (expected e.g. B4): {e}")
    f, v = fws[ref].value, vws[ref].value
    is_formula = isinstance(f, str) and f.startswith("=")
    return {
        "ref": ref,
        "value": v,
        "formula": f if is_formula else None,
        # An agent that sees `value: null` on a formula cell needs to be told the
        # difference between "the answer is empty" and "nobody has calculated this
        # file yet" — the second is normal for anything a library wrote.
        "uncalculated": bool(is_formula and v is None),
    }


def sheet_inventory(fwb, vwb) -> list[dict]:
    out = []
    for ws in fwb.worksheets:
        vws = vwb[ws.title]
        formulas = uncalculated = 0
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    formulas += 1
                    if vws[cell.coordinate].value is None:
                        uncalculated += 1
        out.append({
            "name": ws.title, "state": ws.sheet_state,
            "rows": ws.max_row, "columns": ws.max_column,
            "dimensions": ws.dimensions,
            "formulas": formulas, "uncalculated_formulas": uncalculated,
            "has_cjk": any(has_cjk(str(c.value)) for r in ws.iter_rows() for c in r
                           if isinstance(c.value, str)),
        })
    return out


def read_range(fws, vws, ref: str) -> list[dict]:
    from openpyxl.utils.cell import range_boundaries
    try:
        c0, r0, c1, r1 = range_boundaries(ref)
    except Exception as e:  # noqa: BLE001
        fail(f"{ref!r} is not a range (expected e.g. A1:D12): {e}")
    if None in (c0, r0, c1, r1):
        fail(f"{ref!r} is an open-ended range; give both corners, e.g. A1:D12")
    span = (c1 - c0 + 1) * (r1 - r0 + 1)
    if span > MAX_SCAN_CELLS:
        fail(f"range {ref} covers {span} cells; ask for a smaller window "
             f"(limit {MAX_SCAN_CELLS}) or use --sheet without --range for a summary")
    from openpyxl.utils import get_column_letter
    return [cell_entry(fws, vws, f"{get_column_letter(c)}{r}")
            for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--sheet", help="sheet name; default = the first one")
    ap.add_argument("--range", dest="area", help="e.g. A1:D12")
    ap.add_argument("--cells", nargs="+", metavar="REF", help="e.g. B4 C4")
    ap.add_argument("--out", type=Path, help="write the full report here")
    args = ap.parse_args()

    def entry():
        fwb, vwb = load_pair(args.src)
        sheets = sheet_inventory(fwb, vwb)
        payload = {"file": args.src.name, "sheets": sheets}
        if args.area or args.cells:
            name = args.sheet or fwb.sheetnames[0]
            if name not in fwb.sheetnames:
                fail(f"no sheet named {name!r} (have: {', '.join(fwb.sheetnames)})")
            fws, vws = fwb[name], vwb[name]
            cells = read_range(fws, vws, args.area) if args.area else \
                [cell_entry(fws, vws, r) for r in args.cells]
            payload["sheet"] = name
            payload["cells"] = cells
        elif args.sheet:
            if args.sheet not in fwb.sheetnames:
                fail(f"no sheet named {args.sheet!r} (have: {', '.join(fwb.sheetnames)})")
            payload["sheet"] = args.sheet
        emit(payload, args.out, "cells", "sheets")
        fwb.close()
        vwb.close()

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
