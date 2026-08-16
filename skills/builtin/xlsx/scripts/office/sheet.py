#!/usr/bin/env python3
"""Editing a worksheet without rewriting the workbook.

The graft in `package.py` repairs what a library dropped. This module avoids the
loss entirely: it edits `xl/worksheets/sheetN.xml` in place inside the zip and
leaves every other byte of the package exactly as it was found.

Why both exist. The graft works at PART granularity, and there is loss it cannot
see — round-tripping `sample.xlsx` through openpyxl also drops the `<ignoredErrors>`
element from INSIDE `sheet1.xml`, a part that survives. Nothing at the part level
can notice that. For the dominant editing action — put this value in that cell —
not handing the package to a rewriter at all is simply the stronger answer, and it
keeps charts, pivot caches, macros and cell metadata untouched because they are
never read in the first place.

Three deliberate choices:

  * **Inline strings** (`t="inlineStr"`), so a text edit never touches
    `xl/sharedStrings.xml`. The alternative is appending to the string table and
    renumbering, which is a package-wide edit to write one word.
  * **The style index `s` is preserved** when a cell already exists. Formatting is
    an attribute of the cell, not of the value, and an edit that resets it is how
    "I changed one number and the whole column turned into General" happens.
  * **Shared formulas are refused, not overwritten.** `<f t="shared" ref="B2:B9">`
    is one definition serving a range of cells; overwriting the master leaves the
    dependents pointing at nothing.
"""
from __future__ import annotations

import re
from .package import Package, PackageError
from .xmlorder import MAIN_NS, insert_ordered, q

CELL_REF = re.compile(r"^([A-Za-z]{1,3})([1-9][0-9]*)$")
RANGE_REF = re.compile(r"^([A-Za-z]{1,3})([1-9][0-9]*):([A-Za-z]{1,3})([1-9][0-9]*)$")


def col_to_index(letters: str) -> int:
    """'A' -> 1, 'AA' -> 27."""
    n = 0
    for ch in letters.upper():
        n = n * 26 + (ord(ch) - 64)
    return n


def index_to_col(index: int) -> str:
    letters = ""
    while index > 0:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def parse_ref(ref: str) -> tuple[int, int]:
    """'B4' -> (column 2, row 4)."""
    m = CELL_REF.match(ref.strip())
    if not m:
        raise PackageError(f"{ref!r} is not a cell reference (expected e.g. B4)")
    return col_to_index(m.group(1)), int(m.group(2))


class Worksheet:
    """One `xl/worksheets/sheetN.xml`, opened for surgery."""

    def __init__(self, pkg: Package, part: str, name: str):
        self.pkg = pkg
        self.part = part
        self.name = name
        self.root = pkg.tree(part)
        self.formulas_changed = False

    # ── lookup ────────────────────────────────────────────────────────────────
    def _sheet_data(self):
        el = self.root.find(q("sheetData"))
        if el is None:
            from lxml import etree
            el = etree.Element(q("sheetData"))
            insert_ordered(self.root, el)
        return el

    def _row(self, index: int, create: bool):
        data = self._sheet_data()
        for row in data.findall(q("row")):
            r = row.get("r")
            if r and int(r) == index:
                return row
            if r and int(r) > index:
                if not create:
                    return None
                from lxml import etree
                new = etree.Element(q("row"), r=str(index))
                row.addprevious(new)
                return new
        if not create:
            return None
        from lxml import etree
        new = etree.SubElement(data, q("row"), r=str(index))
        return new

    def _cell(self, ref: str, create: bool):
        col, row_index = parse_ref(ref)
        row = self._row(row_index, create)
        if row is None:
            return None
        target = f"{index_to_col(col)}{row_index}"
        for cell in row.findall(q("c")):
            r = cell.get("r") or ""
            m = CELL_REF.match(r)
            if not m:
                continue
            if col_to_index(m.group(1)) == col:
                return cell
            if col_to_index(m.group(1)) > col:
                if not create:
                    return None
                from lxml import etree
                new = etree.Element(q("c"), r=target)
                cell.addprevious(new)
                return new
        if not create:
            return None
        from lxml import etree
        return etree.SubElement(row, q("c"), r=target)

    # ── mutation ──────────────────────────────────────────────────────────────
    def set_cell(self, ref: str, value, formula: bool = False) -> dict:
        """Write one cell. `value` None clears it."""
        from lxml import etree
        cell = self._cell(ref, create=True)
        self._guard_shared_formula(ref, cell)
        style = cell.get("s")
        existing_formula = cell.find(q("f")) is not None
        for child in list(cell):
            cell.remove(child)
        for attr in list(cell.attrib):
            if attr not in ("r", "s"):
                del cell.attrib[attr]
        if style is not None:
            cell.set("s", style)
        kind = "blank"
        if formula:
            text = str(value)
            etree.SubElement(cell, q("f")).text = text.lstrip("=")
            # No cached <v>: writing one would state a result nothing computed.
            # Excel and LibreOffice both evaluate a formula cell that has none.
            kind = "formula"
            self.formulas_changed = True
        elif value is None:
            kind = "blank"
        elif isinstance(value, bool):
            cell.set("t", "b")
            etree.SubElement(cell, q("v")).text = "1" if value else "0"
            kind = "boolean"
        elif isinstance(value, (int, float)):
            etree.SubElement(cell, q("v")).text = repr(value) if isinstance(value, float) \
                else str(value)
            kind = "number"
        else:
            cell.set("t", "inlineStr")
            etree.SubElement(etree.SubElement(cell, q("is")), q("t")).text = str(value)
            # xml:space keeps leading/trailing spaces a user typed on purpose.
            if str(value) != str(value).strip():
                cell.find(q("is")).find(q("t")).set(
                    "{http://www.w3.org/XML/1998/namespace}space", "preserve")
            kind = "text"
        if existing_formula and not formula:
            self.formulas_changed = True
        self._grow_dimension(ref)
        return {"cell": ref, "kind": kind, "kept_style": style is not None}

    def set_cached(self, ref: str, value) -> dict:
        """Write a formula cell's CACHED RESULT, leaving the formula itself alone.

        This is what makes a workbook written by a library readable: openpyxl stores
        `<f>` and no `<v>`, so every consumer that asks for values — including this
        skill's own reader, and anything that is not a spreadsheet application —
        sees an empty cell where a number should be.

        Only formula cells are touched. Writing a cached value onto a constant would
        be inventing a second, silently divergent copy of it.
        """
        from lxml import etree
        cell = self._cell(ref, create=False)
        if cell is None:
            return {"cell": ref, "written": False, "why": "no such cell"}
        f = cell.find(q("f"))
        if f is None:
            return {"cell": ref, "written": False, "why": "not a formula cell"}
        for child in list(cell):
            if child.tag != q("f"):
                cell.remove(child)
        cell.attrib.pop("t", None)
        if value is None:
            return {"cell": ref, "written": True, "kind": "blank"}
        if isinstance(value, bool):
            cell.set("t", "b")
            etree.SubElement(cell, q("v")).text = "1" if value else "0"
            kind = "boolean"
        elif isinstance(value, (int, float)):
            etree.SubElement(cell, q("v")).text = repr(float(value)) \
                if isinstance(value, float) else str(value)
            kind = "number"
        elif isinstance(value, str) and value.startswith("#"):
            # An error VALUE is a legitimate cached result and has its own cell type.
            cell.set("t", "e")
            etree.SubElement(cell, q("v")).text = value
            kind = "error"
        else:
            # `str` is the cell type for a formula whose result is text — NOT
            # inlineStr, which is only for constants.
            cell.set("t", "str")
            etree.SubElement(cell, q("v")).text = str(value)
            kind = "text"
        return {"cell": ref, "written": True, "kind": kind}

    def clear_cached(self, refs: set[str]) -> list[str]:
        """Drop the cached `<v>` of many formula cells in ONE pass over the sheet.

        `set_cached` is right for a handful of cells and quadratic for thousands:
        `_row` rescans every row on every call. Measured 2026-08-16 — clearing
        19,998 cells that way took 54s on a 10,000-row sheet, against 0.3s for the
        scan that decided which cells they were. Same result, one traversal.
        """
        wanted = {r.upper() for r in refs}
        cleared: list[str] = []
        for row in self._sheet_data().findall(q("row")):
            for cell in row.findall(q("c")):
                ref = (cell.get("r") or "").upper()
                if ref not in wanted or cell.find(q("f")) is None:
                    continue
                for child in list(cell):
                    if child.tag != q("f"):
                        cell.remove(child)
                cell.attrib.pop("t", None)
                cleared.append(ref)
        return cleared

    def formula_cells(self) -> dict[str, str]:
        """Every cell on this sheet holding a formula, as {ref: '=...'}."""
        out: dict[str, str] = {}
        for row in self._sheet_data().findall(q("row")):
            for cell in row.findall(q("c")):
                f = cell.find(q("f"))
                if f is not None and f.text:
                    out[cell.get("r")] = "=" + f.text
        return out

    def _guard_shared_formula(self, ref: str, cell) -> None:
        f = cell.find(q("f"))
        if f is None or f.get("t") != "shared":
            return
        if f.get("ref"):
            raise PackageError(
                f"{self.name}!{ref} defines a shared formula covering {f.get('ref')}; "
                f"overwriting it would leave the other cells in that range without a "
                f"definition. Rewrite the whole range, or convert it in Excel first")

    def append_row(self, values: list, formulas: set[int] | None = None) -> dict:
        """Add a row below the last one that carries anything."""
        data = self._sheet_data()
        used = [int(r.get("r")) for r in data.findall(q("row")) if r.get("r")]
        index = (max(used) + 1) if used else 1
        formulas = formulas or set()
        written = []
        for i, value in enumerate(values, start=1):
            if value is None:
                continue
            ref = f"{index_to_col(i)}{index}"
            written.append(self.set_cell(ref, value, formula=i in formulas))
        return {"row": index, "cells": written}

    def set_column_width(self, column: int, width: float,
                         reason: str = "") -> dict:
        """Set an explicit width on one column.

        `<cols>` must precede `<sheetData>` (ECMA-376 CT_Worksheet is a sequence);
        appending it is the obvious wrong move and produces a file Excel offers to
        repair. `insert_ordered` is what keeps that from happening.
        """
        from lxml import etree
        cols = self.root.find(q("cols"))
        if cols is None:
            cols = etree.Element(q("cols"))
            insert_ordered(self.root, cols)
        for col in cols.findall(q("col")):
            lo, hi = int(col.get("min")), int(col.get("max"))
            if lo <= column <= hi:
                if lo == hi:
                    col.set("width", f"{width:g}")
                    col.set("customWidth", "1")
                    return {"column": index_to_col(column), "width": width,
                            "reason": reason, "split": False}
                # The column shares a <col> span with others; narrow the span and
                # give this one its own entry rather than resizing its neighbours.
                cols.remove(col)
                for a, b in ((lo, column - 1), (column + 1, hi)):
                    if a <= b:
                        keep = etree.SubElement(cols, q("col"), min=str(a), max=str(b))
                        for k, v in col.attrib.items():
                            if k not in ("min", "max"):
                                keep.set(k, v)
                mine = etree.SubElement(cols, q("col"), min=str(column), max=str(column))
                for k, v in col.attrib.items():
                    if k not in ("min", "max", "width", "customWidth"):
                        mine.set(k, v)
                mine.set("width", f"{width:g}")
                mine.set("customWidth", "1")
                return {"column": index_to_col(column), "width": width,
                        "reason": reason, "split": True}
        etree.SubElement(cols, q("col"), min=str(column), max=str(column),
                         width=f"{width:g}", customWidth="1")
        return {"column": index_to_col(column), "width": width, "reason": reason,
                "split": False}

    def _grow_dimension(self, ref: str) -> None:
        dim = self.root.find(q("dimension"))
        if dim is None:
            return
        current = dim.get("ref") or ""
        col, row = parse_ref(ref)
        m = RANGE_REF.match(current)
        if m:
            c0, r0 = col_to_index(m.group(1)), int(m.group(2))
            c1, r1 = col_to_index(m.group(3)), int(m.group(4))
        elif CELL_REF.match(current):
            c0 = c1 = col_to_index(CELL_REF.match(current).group(1))
            r0 = r1 = int(CELL_REF.match(current).group(2))
        else:
            return
        new = (f"{index_to_col(min(c0, col))}{min(r0, row)}:"
               f"{index_to_col(max(c1, col))}{max(r1, row)}")
        if new != current:
            dim.set("ref", new)

    def flush(self) -> None:
        self.pkg.put_tree(self.part, self.root)


class Workbook:
    """The package, its sheets, and where each one's XML lives."""

    def __init__(self, pkg: Package):
        self.pkg = pkg
        self.root = pkg.tree("xl/workbook.xml")
        rels = pkg.relationships(Package.rels_part_of("xl/workbook.xml"))
        by_id = {r["id"]: r["resolved"] for r in rels}
        self.sheets: dict[str, str] = {}
        sheets_el = self.root.find(q("sheets"))
        for sh in (sheets_el if sheets_el is not None else []):
            rid = sh.get(f"{{{REL_ATTR_NS}}}id")
            part = by_id.get(rid)
            if part:
                self.sheets[sh.get("name")] = part
        self._open: dict[str, Worksheet] = {}

    def sheet(self, name: str | None = None) -> Worksheet:
        if not self.sheets:
            raise PackageError("workbook declares no worksheets")
        if name is None:
            name = next(iter(self.sheets))
        if name not in self.sheets:
            raise PackageError(f"no sheet named {name!r} (have: "
                               f"{', '.join(self.sheets)})")
        if name not in self._open:
            self._open[name] = Worksheet(self.pkg, self.sheets[name], name)
        return self._open[name]

    def save(self, path) -> dict:
        """Write every touched sheet back and drop caches the edit invalidated."""
        dropped = []
        formulas_changed = any(ws.formulas_changed for ws in self._open.values())
        for ws in self._open.values():
            ws.flush()
        if formulas_changed and "xl/calcChain.xml" in self.pkg.parts:
            # Stale evaluation-order cache over a changed formula graph is what makes
            # Excel report a good file as damaged. It is rebuilt on open.
            self.pkg.drop("xl/calcChain.xml")
            dropped.append("xl/calcChain.xml")
        self.pkg.save(path)
        return {"sheets_written": sorted(self._open), "caches_dropped": dropped}


REL_ATTR_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
