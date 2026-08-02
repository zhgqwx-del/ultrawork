#!/usr/bin/env python3
"""X2 — write cells and append rows. X15 — column widths that count CJK properly.

This edits `xl/worksheets/sheetN.xml` inside the package and leaves every other
byte alone. It does NOT go through `openpyxl.load_workbook(...) → save()`, and the
reason is measured, not stylistic: that round trip on the repo's own `sample.xlsx`
drops `xl/metadata.xml` (904 bytes of dynamic-array metadata) and the
`<ignoredErrors>` element inside `sheet1.xml`, for a no-op edit. Charts, pivot
caches, macros, threaded comments and cell metadata are all in the same position —
present in the input, understood by nothing in the writer, gone from the output.

    python3 xlsx_write.py --in book.xlsx --out out.xlsx --set 利润表!B4=1240
    python3 xlsx_write.py --in book.xlsx --out out.xlsx \
            --set B4=1240 --set-formula D4=C4-B4 --sheet 利润表
    python3 xlsx_write.py --in book.xlsx --out out.xlsx --append-row 现金,1200,=B2*2
    python3 xlsx_write.py --in book.xlsx --out out.xlsx --autofit          # X15

`--autofit` is not cosmetic. A column holding 营业收入合计 at the 8.43 default is
displayed truncated, and a numeric column too narrow shows `####` — the value is
in the file and invisible on screen. Widths are computed in DISPLAY width, where a
Han character is two units; using `len()` produces a column that is half the size
it needs to be, which is the state every workbook the old doc-edit skill touched
was left in.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from office.formula import error_tokens_in, missing_sheets  # noqa: E402
from office.package import Package  # noqa: E402
from office.sheet import Workbook, col_to_index, index_to_col, parse_ref  # noqa: E402
from office.validate import check_package  # noqa: E402
from xlsxcommon import (  # noqa: E402
    XlsxError, emit, ensure_distinct, fail, has_cjk, needed_width, run,
)


def split_target(spec: str, default_sheet: str | None) -> tuple[str | None, str, str]:
    """'利润表!B4=1240' -> (sheet, ref, value); '=' inside the value is kept."""
    if "=" not in spec:
        fail(f"--set expects REF=VALUE, got {spec!r}")
    target, _, value = spec.partition("=")
    sheet = default_sheet
    if "!" in target:
        sheet, _, target = target.partition("!")
        sheet = sheet.strip("'")
    return sheet, target.strip(), value


def coerce(text: str):
    """Turn the command-line string into the type the cell should hold.

    A quoted value stays text no matter what it looks like — the escape hatch for
    order codes, phone numbers and anything else where 007 must not become 7.
    """
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    if text == "":
        return None
    low = text.strip().lower()
    if low in ("true", "false"):
        return low == "true"
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return text


def check_formula(expr: str, sheets: set[str], ref: str) -> None:
    """Refuse a formula that is already broken, before it reaches the file (X10).

    Both of these are stored without complaint by every library in this stack and
    only become visible when Excel opens the workbook — which is the worst possible
    moment, because by then nobody remembers which step wrote the cell.
    """
    gone = missing_sheets(expr, sheets)
    if gone:
        fail(f"{ref} refers to sheet {', '.join(repr(g) for g in gone)}, which this "
             f"workbook does not have (sheets: {', '.join(sorted(sheets))}). Writing "
             f"it would store a formula that becomes #REF! the moment Excel opens "
             f"the file")
    baked = error_tokens_in(expr)
    if baked:
        fail(f"{ref}: the formula text itself contains {', '.join(baked)} — that is "
             f"an error value, not an expression")


def autofit(src: Path, wb: Workbook, only_sheet: str | None,
            cjk_only: bool) -> list[dict]:
    """Give every column holding text an explicit width wide enough to show it.

    Values are read with openpyxl from the untouched input on disk — reading never
    rewrites a package — and the widths are then written surgically into the sheet
    XML this run is editing.
    """
    import openpyxl
    from contextlib import closing
    book = openpyxl.load_workbook(src, data_only=False)
    changes: list[dict] = []
    with closing(book):
        for ws in book.worksheets:
            if only_sheet and ws.title != only_sheet:
                continue
            if ws.title not in wb.sheets:
                continue
            # A title merged across A1:F1 is displayed across all six columns, so it
            # must not drive column A's width — Excel's own autofit ignores merged
            # cells for the same reason. A merge inside ONE column (a vertical merge)
            # buys no extra room and still counts.
            spanned = {c.coordinate for rng in ws.merged_cells.ranges
                       if rng.max_col > rng.min_col
                       for row in ws[rng.coord] for c in row}
            widest: dict[int, tuple[float, str]] = {}
            for row in ws.iter_rows():
                for cell in row:
                    v = cell.value
                    # A formula's own text is never displayed, so it must not drive
                    # the width — otherwise =SUM(利润表!B2:B20) demands 22 columns.
                    if not isinstance(v, str) or v.startswith("="):
                        continue
                    if cjk_only and not has_cjk(v):
                        continue
                    if cell.coordinate in spanned:
                        continue
                    want = needed_width(v)
                    if want > widest.get(cell.column, (0, ""))[0]:
                        widest[cell.column] = (want, v)
            target = wb.sheet(ws.title)
            for col, (want, sample) in sorted(widest.items()):
                current = current_width(target, col)
                if current is not None and current + 1e-6 >= want:
                    continue
                changes.append({"sheet": ws.title, **target.set_column_width(
                    col, want, reason=f"{sample[:16]!r} needs {want:g} display units"),
                    "was": current})
    return changes


def current_width(worksheet, column: int) -> float | None:
    from office.xmlorder import q
    cols = worksheet.root.find(q("cols"))
    if cols is None:
        return None
    for col in cols.findall(q("col")):
        if int(col.get("min")) <= column <= int(col.get("max")):
            w = col.get("width")
            return float(w) if w is not None else None
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--sheet", help="default sheet for refs that do not name one")
    ap.add_argument("--set", dest="sets", action="append", default=[],
                    metavar="REF=VALUE")
    ap.add_argument("--set-formula", dest="formulas", action="append", default=[],
                    metavar="REF=EXPR")
    ap.add_argument("--append-row", dest="rows", action="append", default=[],
                    metavar="V1,V2,...",
                    help="comma-separated; a value starting with = is a formula")
    ap.add_argument("--autofit", action="store_true",
                    help="give text columns an explicit width (X15)")
    ap.add_argument("--autofit-scope", choices=("cjk", "all"), default="cjk",
                    help="cjk (default) widens only columns holding CJK text")
    ap.add_argument("--report", type=Path, help="write the change log here")
    args = ap.parse_args()

    def entry():
        ensure_distinct(args.src, args.out)
        if not (args.sets or args.formulas or args.rows or args.autofit):
            fail("nothing to do: pass --set / --set-formula / --append-row / --autofit")
        pkg = Package.open(args.src)
        wb = Workbook(pkg)
        changes: list[dict] = []

        for spec in args.sets:
            sheet, ref, value = split_target(spec, args.sheet)
            changes.append({"sheet": wb.sheet(sheet).name, "op": "set",
                            **wb.sheet(sheet).set_cell(ref, coerce(value))})
        for spec in args.formulas:
            sheet, ref, expr = split_target(spec, args.sheet)
            if not expr.strip():
                fail(f"--set-formula {spec!r} has an empty expression")
            check_formula(expr, set(wb.sheets), ref)
            changes.append({"sheet": wb.sheet(sheet).name, "op": "set-formula",
                            **wb.sheet(sheet).set_cell(ref, expr, formula=True)})
        for spec in args.rows:
            values, formulas = [], set()
            for i, raw in enumerate(spec.split(","), start=1):
                raw = raw.strip()
                if raw.startswith("="):
                    formulas.add(i)
                    values.append(raw[1:])
                else:
                    values.append(coerce(raw))
            ws = wb.sheet(args.sheet)
            changes.append({"sheet": ws.name, "op": "append-row",
                            **ws.append_row(values, formulas)})

        widths = autofit(args.src, wb, args.sheet, args.autofit_scope == "cjk") \
            if args.autofit else []

        saved = wb.save(args.out)
        # The package is re-opened from disk, not inspected in memory: the claim is
        # about the FILE, and an in-memory check would agree with itself even if
        # saving wrote something else.
        #
        # Only damage this edit INTRODUCED is fatal. A file that arrived with a
        # dangling relationship is still a file the user wants edited — refusing it
        # would make the skill useless on exactly the documents that need help — but
        # an edit that creates new damage must write nothing at all.
        was = set(check_package(Package.open(args.src)))
        now = check_package(Package.open(args.out))
        introduced = [f for f in now if f not in was]
        if introduced:
            args.out.unlink(missing_ok=True)
            fail("this edit would have introduced package damage, so nothing was "
                 "written: " + "; ".join(introduced[:3]))
        lost = sorted(set(pkg_names(args.src)) - set(pkg_names(args.out)))
        report = {"in": args.src.name, "out": args.out.name,
                  "changes": changes, "widths": widths,
                  "sheets_written": saved["sheets_written"],
                  "caches_dropped": saved["caches_dropped"],
                  "parts_in": len(pkg_names(args.src)),
                  "parts_out": len(pkg_names(args.out)),
                  "parts_lost": [p for p in lost if p not in saved["caches_dropped"]],
                  "pre_existing_package_findings": sorted(was)}
        emit(report, args.report, "changes", "widths")

    return run(entry)


def pkg_names(path: Path) -> list[str]:
    import zipfile
    with zipfile.ZipFile(path) as z:
        return [n for n in z.namelist() if not n.endswith("/")]


if __name__ == "__main__":
    raise SystemExit(main())
