#!/usr/bin/env python3
"""Behaviour tests for the xlsx skill's scripts (discussions/059 S3).

L1 proves each declared capability runs and produces an artifact; L2 proves the
artifact is a legal, non-lossy workbook. Neither can say whether the numbers are
RIGHT — that a width was counted in display units rather than `len()`, that the
edit reached the cell it named, that a surgical write really did leave the other
16 parts alone. Those claims are this file's job.

    python3 scripts/test-xlsx-skill.py
    python3 scripts/test-xlsx-skill.py --json

Every assertion runs twice: once against the real output of the real scripts (must
stay silent) and once against output carrying exactly the defect it hunts (must
fire). The flaws are not invented damage — each is the implementation somebody
reaches for first. `write-via-load-save` above all: `openpyxl.load_workbook(f)` →
`save()` is what every example on the internet does, and it is what silently drops
`xl/metadata.xml` and every customXml part in the file.

The run prints a flaw -> fired-checks matrix. "All the negative controls went red"
is not the claim; "the RIGHT check went red" is, and only the matrix shows the
difference.

Exit 0 = every assertion behaved, 1 = something did not.
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / "skills" / "builtin" / "xlsx"
FIXTURES = SKILL / "fixtures"
BOOK = FIXTURES / "book.xlsx"
NARROW = FIXTURES / "narrow.xlsx"
PY = sys.executable

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

# What book.xlsx is known to hold. Spelled out rather than read back from the file:
# an expectation derived from the artifact it checks agrees with itself no matter
# what the artifact says.
SHEETS = ["利润表", "汇总"]
CROSS_SHEET_CELL = ("汇总", "B2", "=利润表!B5")
# 营业收入合计（含其他业务） is 13 wide characters => 26 display units, + 2 padding.
LONG_LABEL = "营业收入合计（含其他业务）"
LONG_LABEL_WIDTH = 28
LONG_LABEL_LEN_WIDTH = 15        # what len()+2 would have produced — the defect

# The merge probe's three labels, sized so that each implementation lands on a
# different number: ignore-the-title => 18, count-the-title => 42, ignore-every-
# merge => 6. Same-length labels would make the first two indistinguishable.
MERGE_TITLE = "二零二六年第三季度经营分析报告与附注说明"   # 20 wide => 42 units
MERGE_VERTICAL = "累计毛利合计金额"                        # 8 wide  => 18 units
MERGE_EXPECT_WIDTH = 18
MERGE_TITLE_WIDTH = 42
MERGE_PLAIN_WIDTH = 6

STDOUT_BUDGET = 6000             # bytes one call may print for a large workbook
SCALE_ROWS = 2000                # comfortably past xlsxcommon.STDOUT_ITEM_LIMIT


# Claims this host could not exercise. Reported separately and never folded into the
# pass count — the whole reason X3 carried a wrong expectation for a month is that a
# skip and a pass looked identical at a glance.
SKIPS: list[str] = []


def run_script(name: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([PY, str(SKILL / "scripts" / name), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=300)


def parts_of(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist() if not n.endswith("/")}


def sheet_child_order(path: Path, part: str = "xl/worksheets/sheet1.xml") -> list[str]:
    from lxml import etree
    root = etree.fromstring(parts_of(path)[part])
    return [str(c.tag).rsplit("}", 1)[-1] for c in root]


def widths_of(path: Path, sheet: str) -> dict[str, float]:
    import openpyxl
    wb = openpyxl.load_workbook(path)
    try:
        ws = wb[sheet]
        return {letter: dim.width for letter, dim in ws.column_dimensions.items()
                if dim.width is not None}
    finally:
        wb.close()


def cells_of(path: Path, sheet: str, refs: list[str]) -> dict[str, object]:
    import openpyxl
    wb = openpyxl.load_workbook(path)
    try:
        ws = wb[sheet]
        return {r: ws[r].value for r in refs}
    finally:
        wb.close()


def values_of(path: Path, sheet: str, refs: list[str]) -> dict[str, object]:
    """The CACHED values, not the formulas.

    `cells_of` opens the workbook with data_only=False and therefore hands back
    "=B3-B4" where a recalculated number is expected — which is what the first
    version of K5 asserted against, so the check failed on correct output.
    """
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    try:
        ws = wb[sheet]
        return {r: ws[r].value for r in refs}
    finally:
        wb.close()


def style_ids(path: Path, sheet_part: str, refs: list[str]) -> dict[str, str | None]:
    from lxml import etree
    root = etree.fromstring(parts_of(path)[sheet_part])
    out: dict[str, str | None] = {r: None for r in refs}
    for c in root.iter(f"{MAIN}c"):
        if c.get("r") in out:
            out[c.get("r")] = c.get("s")
    return out


# ── inputs the fixtures deliberately do not carry ─────────────────────────────
def with_calc_chain(src: Path, dst: Path) -> None:
    """Add an `xl/calcChain.xml` to a package.

    openpyxl never writes one, so the fixture cannot carry it — but every workbook
    Excel has saved does, and carrying a stale one across a formula edit is what
    makes Excel report a good file as damaged. Built here so the drop is testable.
    """
    sys.path.insert(0, str(SKILL / "scripts"))
    from office.package import Package
    pkg = Package.open(src)
    pkg.write("xl/calcChain.xml",
              b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
              b'<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/'
              b'2006/main"><c r="B5" i="1"/><c r="D5" i="1"/></calcChain>')
    pkg.set_override("xl/calcChain.xml", "application/vnd.openxmlformats-"
                     "officedocument.spreadsheetml.calcChain+xml")
    pkg.add_relationship("xl/_rels/workbook.xml.rels",
                         "http://schemas.openxmlformats.org/officeDocument/2006/"
                         "relationships/calcChain", "calcChain.xml")
    pkg.save(dst)


def with_shared_formula(src: Path, dst: Path) -> None:
    """Turn D3 into the MASTER of a shared formula covering D3:D5.

    This is how Excel stores a formula filled down a column, and openpyxl does not
    produce it. Overwriting the master leaves D4 and D5 with `<f t="shared" si="0"/>`
    and no definition to share — a file that opens and shows nothing where the
    numbers were.
    """
    sys.path.insert(0, str(SKILL / "scripts"))
    from lxml import etree
    from office.package import Package
    pkg = Package.open(src)
    root = pkg.tree("xl/worksheets/sheet1.xml")
    for c in root.iter(f"{MAIN}c"):
        ref = c.get("r")
        if ref not in ("D3", "D4", "D5"):
            continue
        for child in list(c):
            c.remove(child)
        f = etree.SubElement(c, f"{MAIN}f")
        f.set("t", "shared")
        f.set("si", "0")
        if ref == "D3":
            f.set("ref", "D3:D5")
            f.text = "B3/C3-1"
    pkg.put_tree("xl/worksheets/sheet1.xml", root)
    pkg.save(dst)


def with_dangling_rel(src: Path, dst: Path) -> None:
    """A relationship pointing at a part that is not in the package.

    Damage the skill did not cause. It must be reported and must NOT block the edit —
    a fidelity-minded tool that refuses to touch an already-damaged file is useless
    on exactly the documents that need help.
    """
    sys.path.insert(0, str(SKILL / "scripts"))
    from office.package import Package
    pkg = Package.open(src)
    pkg.add_relationship("xl/_rels/workbook.xml.rels",
                         "http://schemas.openxmlformats.org/officeDocument/2006/"
                         "relationships/sheetMetadata", "metadata.xml")
    pkg.save(dst)


def big_workbook(path: Path, rows: int) -> None:
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "明细"
    ws.append(["科目", "金额", "备注"])
    for i in range(rows):
        ws.append([f"科目{i}", i * 7, f"备注{i}"])
    wb.save(path)
    wb.close()


# ── collect: run the real scripts once ────────────────────────────────────────
def collect(work: Path) -> dict:
    import openpyxl

    ctx: dict = {}

    # --- read -----------------------------------------------------------------
    r = run_script("xlsx_read.py", "--in", BOOK, "--sheet", "利润表",
                   "--range", "A1:D5", "--out", work / "read.json")
    read_json = json.loads((work / "read.json").read_text(encoding="utf-8"))
    rejects = []
    for label, args in (
            ("open-ended range", ("--range", "A1:D")),
            ("oversized range", ("--range", "A1:ZZ1048576")),
            ("unknown sheet", ("--sheet", "没有这个表", "--range", "A1:B2")),
            ("not a cell reference", ("--cells", "无效")),
    ):
        p = run_script("xlsx_read.py", "--in", BOOK, *args)
        rejects.append({"case": label, "exit": p.returncode,
                        "stderr": p.stderr.strip()})
    ctx["read"] = {"json": read_json, "rejects": rejects, "exit": r.returncode}

    # --- surgical write, and the control everyone writes instead ---------------
    edited = work / "edited.xlsx"
    w = run_script("xlsx_write.py", "--in", BOOK, "--out", edited, "--sheet", "利润表",
                   "--set", "B3=1310", "--set-formula", "D5=B5/C5-1",
                   "--append-row", "其他业务收入,88,74",
                   "--report", work / "write.json")
    write_report = json.loads((work / "write.json").read_text(encoding="utf-8"))

    naive = work / "naive.xlsx"
    wb = openpyxl.load_workbook(BOOK)
    ws = wb["利润表"]
    ws["B3"] = 1310
    ws["D5"] = "=B5/C5-1"
    ws.append(["其他业务收入", 88, 74])
    wb.save(naive)
    wb.close()

    before, after, naive_after = parts_of(BOOK), parts_of(edited), parts_of(naive)
    ctx["write"] = {
        "exit": w.returncode,
        "report": write_report,
        "parts_before": sorted(before),
        "parts_after": sorted(after),
        "identical": sorted(n for n in before if after.get(n) == before[n]),
        "naive_parts_after": sorted(naive_after),
        "naive_identical": sorted(n for n in before if naive_after.get(n) == before[n]),
        "cells": cells_of(edited, "利润表", ["B3", "D5", "B5", "A6", "B6", "C6"]),
        # D5 carries a percent number format in the fixture; an edit that resets it
        # is the "I changed one number and the column turned into General" failure.
        "styles": style_ids(edited, "xl/worksheets/sheet1.xml", ["D5", "D3"]),
        "styles_before": style_ids(BOOK, "xl/worksheets/sheet1.xml", ["D5", "D3"]),
        "sheet_order": sheet_child_order(edited),
    }

    # --- calcChain: dropped on a formula edit, kept on a value-only edit --------
    with_cc = work / "with-calcchain.xlsx"
    with_calc_chain(BOOK, with_cc)
    cc_formula = work / "cc-formula.xlsx"
    cc_value = work / "cc-value.xlsx"
    run_script("xlsx_write.py", "--in", with_cc, "--out", cc_formula,
               "--sheet", "利润表", "--set-formula", "D5=B5/C5-1")
    run_script("xlsx_write.py", "--in", with_cc, "--out", cc_value,
               "--sheet", "利润表", "--set", "B3=1310")
    ctx["calcchain"] = {
        "input_has": "xl/calcChain.xml" in parts_of(with_cc),
        "after_formula_edit": "xl/calcChain.xml" in parts_of(cc_formula),
        "after_value_edit": "xl/calcChain.xml" in parts_of(cc_value),
    }

    # --- shared formula: refused, not silently broken --------------------------
    shared = work / "shared.xlsx"
    with_shared_formula(BOOK, shared)
    sp = run_script("xlsx_write.py", "--in", shared, "--out", work / "shared-out.xlsx",
                    "--sheet", "利润表", "--set", "D3=0.5")
    sp_other = run_script("xlsx_write.py", "--in", shared,
                          "--out", work / "shared-other.xlsx",
                          "--sheet", "利润表", "--set", "B3=1310")
    ctx["shared"] = {
        "master_exit": sp.returncode, "master_stderr": sp.stderr.strip(),
        "master_wrote": (work / "shared-out.xlsx").exists(),
        # A cell that is NOT the shared master must still be editable, or the guard
        # is just "refuse to edit any workbook Excel has ever touched".
        "other_exit": sp_other.returncode,
    }

    # --- pre-existing damage: reported, not fatal ------------------------------
    damaged = work / "damaged.xlsx"
    with_dangling_rel(BOOK, damaged)
    dp = run_script("xlsx_write.py", "--in", damaged, "--out", work / "damaged-out.xlsx",
                    "--sheet", "利润表", "--set", "B3=1310",
                    "--report", work / "damaged.json")
    damaged_report = json.loads((work / "damaged.json").read_text(encoding="utf-8")) \
        if (work / "damaged.json").exists() else {}
    ctx["damage"] = {
        "exit": dp.returncode,
        "wrote": (work / "damaged-out.xlsx").exists(),
        "pre_existing": damaged_report.get("pre_existing_package_findings", []),
    }

    # --- autofit ---------------------------------------------------------------
    wide = work / "wide.xlsx"
    a = run_script("xlsx_write.py", "--in", NARROW, "--out", wide, "--autofit",
                   "--report", work / "fit.json")
    ctx["autofit"] = {
        "exit": a.returncode,
        "report": json.loads((work / "fit.json").read_text(encoding="utf-8")),
        "widths": widths_of(wide, "利润表"),
        "narrow_widths": widths_of(NARROW, "利润表"),
        "sheet_order": sheet_child_order(wide),
    }

    # A merged title must not drive its first column; a vertical merge must.
    #
    # The three labels have DELIBERATELY different lengths. The first version of this
    # probe used the same string for the horizontal and the vertical merge, so
    # counting the title and ignoring it produced the identical width and the
    # negative control could not fire — a control arm that cannot tell the two
    # implementations apart is not a control.
    merged = work / "merged.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "表"
    ws["A1"] = MERGE_TITLE                         # 20 wide chars => 42 units
    ws.merge_cells("A1:F1")                        # displayed across six columns
    ws["A3"] = "毛利"                              # 2 wide chars => 6 units
    ws["A5"] = MERGE_VERTICAL                      # 8 wide chars => 18 units
    ws.merge_cells("A5:A7")                        # vertical: no extra room
    wb.save(merged)
    wb.close()
    merged_out = work / "merged-wide.xlsx"
    run_script("xlsx_write.py", "--in", merged, "--out", merged_out, "--autofit")
    ctx["merge"] = {"width_a": widths_of(merged_out, "表").get("A")}

    # --- audit: clean input, then one carrying every class of defect -----------
    a = run_script("xlsx_audit.py", "--in", BOOK, "--out", work / "audit-clean.json")
    clean_audit = json.loads((work / "audit-clean.json").read_text(encoding="utf-8"))

    broken = work / "broken.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "利润表"
    ws["A1"] = 10
    ws["B1"] = "=预算表!A1"        # a sheet that does not exist: a #REF! in waiting
    ws["C1"] = "=#REF!*2"          # an error already baked into the formula text
    ws["D1"] = "=E1+1"             # two-cell cycle
    ws["E1"] = "=D1+1"
    ws["F1"] = "=F1"               # self-reference
    ws["G1"] = '="见 预算表!A1 的说明"'   # a reference inside a STRING — not a reference
    ws["H1"] = "=LOG10(A1)"        # a function whose name is shaped like a cell ref
    sm = wb.create_sheet("汇总")
    sm["A1"] = "=利润表!A1"        # a legitimate cross-sheet link: must NOT be flagged
    wb.save(broken)
    wb.close()
    b = run_script("xlsx_audit.py", "--in", broken, "--out", work / "audit-broken.json",
                   "--fail-on", "error,missing,circular")
    broken_audit = json.loads((work / "audit-broken.json").read_text(encoding="utf-8"))
    ctx["audit"] = {
        "clean_exit": a.returncode, "clean": clean_audit,
        "broken_exit": b.returncode, "broken": broken_audit,
        "cells": {f["cell"] for f in broken_audit["findings"]
                  if f["class"] != "uncalc"},
    }

    # --- formulas refused at write time, before they reach the file ------------
    refusals = {}
    for label, spec, sheet in (
            ("missing sheet", "B7==预算表!A1", "利润表"),
            ("error token baked in", "B7==#REF!+1", "利润表"),
    ):
        out = work / f"refused-{len(refusals)}.xlsx"
        p = run_script("xlsx_write.py", "--in", BOOK, "--out", out,
                       "--sheet", sheet, "--set-formula", spec)
        refusals[label] = {"exit": p.returncode, "stderr": p.stderr.strip(),
                           "wrote": out.exists()}
    linked = work / "linked.xlsx"
    ok = run_script("xlsx_write.py", "--in", BOOK, "--out", linked, "--sheet", "利润表",
                    "--set-formula", "C7==汇总!B2")
    ctx["refuse"] = {"cases": refusals, "legit_exit": ok.returncode,
                     "legit_formula": cells_of(linked, "利润表", ["C7"])["C7"]}

    # --- the rebuild path: openpyxl object model + graft -----------------------
    fmt = work / "formatted.xlsx"
    f = run_script("xlsx_format.py", "--in", BOOK, "--out", fmt, "--sheet", "利润表",
                   "--range", "B3:C5", "--number-format", "#,##0",
                   "--font-color", "0000FF", "--bold", "--fill", "FFF2CC",
                   "--border", "thin", "--report", work / "format.json")
    fmt_report = json.loads((work / "format.json").read_text(encoding="utf-8"))

    cond = work / "conditional.xlsx"
    run_script("xlsx_format.py", "--in", BOOK, "--out", cond, "--sheet", "利润表",
               "--rules", FIXTURES / "rules.json")
    panes = work / "panes.xlsx"
    run_script("xlsx_format.py", "--in", BOOK, "--out", panes, "--sheet", "利润表",
               "--freeze", "C6", "--filter", "A2:C5")
    charted = work / "charted.xlsx"
    c = run_script("xlsx_chart.py", "--in", BOOK, "--out", charted, "--sheet", "汇总",
                   "--type", "column", "--data", "利润表!B2:C4",
                   "--categories", "利润表!A3:A4", "--anchor", "D18",
                   "--title", "季度对比", "--report", work / "chart.json")
    chart_report = json.loads((work / "chart.json").read_text(encoding="utf-8"))

    import openpyxl as _o

    def style_probe(path: Path, sheet: str, refs: list[str]) -> dict:
        wb = _o.load_workbook(path)
        try:
            ws = wb[sheet]
            out = {}
            for r in refs:
                cell = ws[r]
                fill = cell.fill
                out[r] = {
                    "number_format": cell.number_format,
                    "bold": bool(cell.font.bold),
                    "color": cell.font.color.rgb if cell.font.color
                    and isinstance(cell.font.color.rgb, str) else None,
                    "size": cell.font.size, "name": cell.font.name,
                    "fill": fill.start_color.rgb if fill and fill.fill_type
                    and isinstance(fill.start_color.rgb, str) else None,
                    "border": cell.border.left.style,
                }
            return out
        finally:
            wb.close()

    def cf_probe(path: Path, sheet: str) -> dict:
        wb = _o.load_workbook(path)
        try:
            ws = wb[sheet]
            out: dict[str, list[str]] = {}
            for rng in ws.conditional_formatting:
                out.setdefault(str(rng.sqref), []).extend(r.type for r in rng.rules)
            return out
        finally:
            wb.close()

    def chart_probe(path: Path, sheet: str) -> dict:
        wb = _o.load_workbook(path)
        try:
            ws = wb[sheet]
            titles = []
            refs = []
            for ch in ws._charts:
                for s in ch.series:
                    titles.append(getattr(getattr(s.tx, "strRef", None), "f", None)
                                  if s.tx else None)
                    refs.append(s.val.numRef.f if s.val and s.val.numRef else None)
            return {"count": len(ws._charts), "series_titles": titles,
                    "series_refs": refs}
        finally:
            wb.close()

    base_style = style_probe(BOOK, "利润表", ["B3", "D3"])
    ctx["rebuild"] = {
        "format_exit": f.returncode, "chart_exit": c.returncode,
        "format_report": fmt_report, "chart_report": chart_report,
        "style": style_probe(fmt, "利润表", ["B3", "C5", "D3"]),
        "style_before": base_style,
        "custom_parts": {
            tag: sum(1 for n in parts_of(p) if n.startswith("customXml"))
            for tag, p in (("format", fmt), ("conditional", cond),
                           ("panes", panes), ("chart", charted))},
        "custom_parts_in": sum(1 for n in parts_of(BOOK) if n.startswith("customXml")),
        "cf": cf_probe(cond, "利润表"),
        "cf_before": cf_probe(BOOK, "利润表"),
        "panes": (lambda p: {"freeze": p[0], "filter": p[1]})(
            (lambda wb: (wb["利润表"].freeze_panes, wb["利润表"].auto_filter.ref))(
                _o.load_workbook(panes))),
        "panes_before": {"freeze": "A3", "filter": "A2:D5"},
        "chart": chart_probe(charted, "汇总"),
        "chart_before": chart_probe(BOOK, "汇总"),
    }

    # Fault injection: make the graft restore nothing and assert the rebuild REFUSES.
    # Same shape as the L2 gate's broken-soffice cases — a repair path nobody has
    # watched fail is not evidence that it repairs anything.
    probe = ("import sys, pathlib\n"
             f"sys.path.insert(0, {str(SKILL / 'scripts')!r})\n"
             "from office import rebuild as R\n"
             "R.graft_missing_parts = lambda base, prod: "
             "{'restored': [], 'skipped': [], 'restored_count': 0, 'skipped_count': 0}\n"
             f"out = pathlib.Path({str(work / 'nograft.xlsx')!r})\n"
             "try:\n"
             f"    R.rebuild(pathlib.Path({str(BOOK)!r}), out, lambda wb: None)\n"
             "    print('RAISED=no')\n"
             "except R.RebuildError as e:\n"
             "    print('RAISED=yes', 'customXml' in str(e))\n"
             "print('WROTE=', out.exists())\n")
    fault = subprocess.run([PY, "-c", probe], capture_output=True, text=True,
                           encoding="utf-8", timeout=300)
    ctx["graft_fault"] = {"stdout": fault.stdout.strip(), "exit": fault.returncode}

    # --- X4: the two engines, and the evaluator's measured coverage boundary ----
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "xlsx_calibration", REPO / "scripts" / "xlsx-evaluator-calibration.py")
    cal = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cal)

    py_results = cal.python_results()
    lo_results, lo_err = cal.soffice_results()
    ctx["calibration"] = {
        "mismatches": [{"formula": f, "pinned": want, "python": py_results[f]}
                       for f, want in cal.CALIBRATION
                       if cal.norm(py_results[f]) != cal.norm(want)],
        "leaked": [{"formula": f, "why": why, "got": cal.python_refusals()[f]}
                   for f, why in cal.MUST_REFUSE
                   if cal.python_refusals()[f][0] != "REFUSED"],
        "unexercised": cal.unexercised(),
        "pinned_rows": len(cal.CALIBRATION),
        "must_refuse_rows": len(cal.MUST_REFUSE),
        "soffice_available": not lo_err,
        "soffice_reason": lo_err,
        "soffice_drift": [] if lo_err else
        [{"formula": f, "pinned": want, "soffice": lo_results[f]}
         for f, want in cal.CALIBRATION
         if cal.norm(lo_results[f]) != cal.norm(want)],
    }
    if lo_err:
        SKIPS.append(
            f"K4 (LibreOffice agrees with every pinned value) — {lo_err}. "
            f"Residual coverage: K1 still checks the python engine against the pins, "
            f"but NOTHING checked the pins themselves this run — that is exactly how "
            f"the L2 gate carried a wrong X3 expectation for a month.")

    recalc = work / "recalced.xlsx"
    rc = run_script("xlsx_recalc.py", "--in", BOOK, "--out", recalc,
                    "--report", work / "recalc.json")
    recalc_report = json.loads((work / "recalc.json").read_text(encoding="utf-8"))
    mixed = work / "mixed.xlsx"
    wb = openpyxl.load_workbook(BOOK)
    ws = wb["利润表"]
    ws["B8"] = "=SUM(B3:B4)"          # both engines can do this
    ws["B9"] = "=VLOOKUP(B3,A3:B4,2,0)"   # only LibreOffice can
    wb.save(mixed)
    wb.close()
    mx = run_script("xlsx_recalc.py", "--in", mixed, "--report", work / "mixed.json")
    mixed_report = json.loads((work / "mixed.json").read_text(encoding="utf-8"))
    py_only = run_script("xlsx_recalc.py", "--in", mixed, "--engine", "python",
                         "--report", work / "pyonly.json")
    py_only_report = json.loads((work / "pyonly.json").read_text(encoding="utf-8"))
    ctx["recalc"] = {
        "exit": rc.returncode, "report": recalc_report,
        "cached_after": values_of(recalc, "利润表", ["B5", "D5"]),
        "cached_before": values_of(BOOK, "利润表", ["B5", "D5"]),
        "formula_after": cells_of(recalc, "利润表", ["B5", "D5"]),
        "mixed": mixed_report, "mixed_exit": mx.returncode,
        "python_only": py_only_report, "python_only_exit": py_only.returncode,
    }

    # --- stdout budget and the in-place contract -------------------------------
    big = work / "big.xlsx"
    big_workbook(big, SCALE_ROWS)
    scale = run_script("xlsx_read.py", "--in", big, "--sheet", "明细",
                       "--range", f"A1:C{SCALE_ROWS}", "--out", work / "big.json")
    big_json = json.loads((work / "big.json").read_text(encoding="utf-8"))
    in_place = {}
    for script, args in (
            ("xlsx_write.py", ("--in", BOOK, "--out", BOOK, "--set", "B3=1")),
            ("xlsx_read.py", ("--in", work / "nope.xlsx",)),
    ):
        p = run_script(script, *args)
        in_place[script] = {"exit": p.returncode, "stderr": p.stderr.strip()}
    ctx["scale"] = {
        "stdout_bytes": len(scale.stdout.encode("utf-8")),
        "file_cells": len(big_json.get("cells", [])),
        "in_place": in_place,
    }
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
    """A silent check and a check with no subjects look identical from the outside.

    L1 shipped a green C4 while zero capabilities were declared; the same shape is
    available here the moment a fixture loses its CJK column or its second sheet.
    """
    out = []
    read = ctx["read"]["json"]
    formula_cells = [c for c in read["cells"] if c["formula"]]
    for label, got, need in (
            ("sheets in the inventory", len(read["sheets"]), 2),
            ("cells in the window", len(read["cells"]), 20),
            ("formula cells to report two views of", len(formula_cells), 3),
            ("rejected read requests", len(ctx["read"]["rejects"]), 4),
            ("parts in the input package", len(ctx["write"]["parts_before"]), 15),
            ("columns autofit had to widen", len(ctx["autofit"]["report"]["widths"]), 4),
            ("formulas in the clean audit", ctx["audit"]["clean"]["counts"]["formulas"], 5),
            # A property of the constructed INPUT, not of what the audit found —
            # counting findings here would make V0 fire on every detection defect
            # A1-A6 already own, and the matrix could no longer say which broke.
            ("formulas in the broken workbook",
             ctx["audit"]["broken"]["counts"]["formulas"], 8),
    ):
        if got < need:
            out.append(f"V0 only {got} {label} (need at least {need}) — the "
                       f"assertions that rest on them cannot fail")
    # S2's whole discriminating power rests on the fixture's font NOT being the
    # openpyxl default: a wholesale Font() assignment lands on Calibri 11, so if
    # B3 already were Calibri 11 the negative control would be a no-op that reads
    # as a pass. The first version of this fixture was exactly that.
    b3 = ctx["rebuild"]["style_before"]["B3"]
    if b3["name"] in (None, "Calibri") or b3["size"] in (None, 11.0):
        out.append(f"V0 the fixture's B3 font is {b3['name']!r} {b3['size']} — the "
                   f"openpyxl default, so S2's control cannot tell a preserved font "
                   f"from a reset one")
    return out


@check("R1", "read reports BOTH views of a formula cell: the value and the formula")
def r1_two_views(ctx: dict) -> list[str]:
    cells = {c["ref"]: c for c in ctx["read"]["json"]["cells"]}
    out = []
    target = cells.get("D3")
    if target is None:
        return ["R1 D3 is not in the window at all"]
    if not target["formula"]:
        out.append("R1 D3 holds a formula in the fixture and read reported none — a "
                   "reader that only returns values makes every formula invisible")
    if cells.get("B3", {}).get("value") != 1240:
        out.append(f"R1 B3 value is {cells.get('B3', {}).get('value')!r}, "
                   f"expected the stored 1240")
    return out


@check("R2", "an uncalculated formula is flagged, not reported as an empty cell")
def r2_uncalculated(ctx: dict) -> list[str]:
    cells = {c["ref"]: c for c in ctx["read"]["json"]["cells"]}
    # "there are no formula cells at all" is V0's finding, not this one — a check
    # that also reports its own vacuity cannot be told apart from the guard that
    # owns it, and the matrix then shows two checks for one defect.
    formulas = [c for c in cells.values() if c["formula"]]
    # openpyxl writes no cached values, so every formula in the fixture is
    # uncalculated. Reporting value=None without saying so is how an agent concludes
    # "the sheet is empty" from a file that is merely uncomputed.
    unflagged = [c["ref"] for c in formulas if c["value"] is None
                 and not c["uncalculated"]]
    if unflagged:
        return [f"R2 {', '.join(unflagged)} have no cached value and are not marked "
                f"`uncalculated` — indistinguishable from a genuinely empty cell"]
    return []


@check("R3", "an unreadable request is refused with a sentence, not clamped or crashed")
def r3_refusals(ctx: dict) -> list[str]:
    out = []
    for case in ctx["read"]["rejects"]:
        if case["exit"] != 2:
            out.append(f"R3 {case['case']}: exit {case['exit']}, expected 2 "
                       f"(a silently clamped range answers a question nobody asked)")
        elif not case["stderr"].startswith("error: ") or "Traceback" in case["stderr"]:
            out.append(f"R3 {case['case']}: stderr is not one actionable line: "
                       f"{case['stderr'][:80]!r}")
    return out


@check("R4", "the sheet inventory names every sheet and counts its formulas")
def r4_inventory(ctx: dict) -> list[str]:
    sheets = {s["name"]: s for s in ctx["read"]["json"]["sheets"]}
    out = []
    for name in SHEETS:
        if name not in sheets:
            out.append(f"R4 sheet {name!r} is missing from the inventory")
    summary = sheets.get("汇总")
    if summary and summary["formulas"] < 2:
        out.append(f"R4 汇总 reports {summary['formulas']} formulas; the fixture's "
                   f"cross-sheet references are what X10 will rest on")
    return out


@check("W1", "a surgical edit loses no part of the input")
def w1_no_part_lost(ctx: dict) -> list[str]:
    w = ctx["write"]
    lost = sorted(set(w["parts_before"]) - set(w["parts_after"]))
    out = []
    if lost:
        out.append(f"W1 the edit dropped {', '.join(lost)} — present in the input, "
                   f"gone from the output")
    if w["report"]["parts_lost"]:
        out.append(f"W1 the report itself admits losing {w['report']['parts_lost']}")
    # The control arm, measured rather than assumed: if the obvious implementation
    # loses nothing either, this whole capability is solving a problem that is not
    # there and the claim should be withdrawn, not asserted.
    naive_lost = set(w["parts_before"]) - set(w["naive_parts_after"])
    if not naive_lost:
        out.append("W1 the load→save control lost nothing, so this fixture cannot "
                   "demonstrate the difference the surgical path exists for")
    return out


@check("W2", "parts the edit did not touch come out byte-identical")
def w2_bytes_untouched(ctx: dict) -> list[str]:
    w = ctx["write"]
    total = len(w["parts_before"])
    kept, naive_kept = len(w["identical"]), len(w["naive_identical"])
    out = []
    # Only sheet1.xml should differ. Anything else means the writer rebuilt a part it
    # had no business rebuilding, and a rebuild is where content quietly changes.
    changed = sorted(set(w["parts_before"]) - set(w["identical"]))
    if changed != ["xl/worksheets/sheet1.xml"]:
        out.append(f"W2 the edit rewrote {changed}; only the edited worksheet should "
                   f"differ from the input")
    if kept <= naive_kept:
        out.append(f"W2 the surgical path kept {kept}/{total} parts byte-identical and "
                   f"load→save kept {naive_kept}/{total} — no measurable advantage")
    return out


@check("W3", "the edit reaches the named cell and keeps its formatting")
def w3_edit_lands(ctx: dict) -> list[str]:
    w = ctx["write"]
    out = []
    # Deliberately NOT the appended row: W4 owns that, and a check that also looks
    # at A6 fires on every append defect too, which makes the matrix unable to say
    # which of the two is broken.
    for ref, want in (("B3", 1310), ("D5", "=B5/C5-1")):
        got = w["cells"].get(ref)
        if got != want:
            out.append(f"W3 {ref} = {got!r} after the edit, expected {want!r}")
    if w["styles"]["D5"] != w["styles_before"]["D5"]:
        out.append(f"W3 D5's style index changed from {w['styles_before']['D5']!r} to "
                   f"{w['styles']['D5']!r} — its number format is an attribute of the "
                   f"cell, not of the value that was in it")
    return []if not out else out


@check("W4", "append-row lands after the last used row, overwriting nothing")
def w4_append(ctx: dict) -> list[str]:
    w = ctx["write"]
    # The fixture's last used row is 5 (毛利), so the appended row must be 6 and row
    # 5 must be untouched.
    if w["cells"].get("A6") != "其他业务收入":
        return [f"W4 the appended row is not at row 6 (A6 = {w['cells'].get('A6')!r})"]
    if w["cells"].get("B5") != "=B3-B4":
        return [f"W4 appending overwrote row 5: B5 = {w['cells'].get('B5')!r}"]
    return []


@check("W5", "overwriting a shared-formula master is refused, not silently done")
def w5_shared_formula(ctx: dict) -> list[str]:
    s = ctx["shared"]
    out = []
    if s["master_exit"] != 2:
        out.append(f"W5 overwriting the master of a shared formula exited "
                   f"{s['master_exit']}; the cells sharing it would be left with a "
                   f"reference to a definition that no longer exists")
    if s["master_wrote"]:
        out.append("W5 a file was written despite the refusal")
    if s["other_exit"] != 0:
        out.append(f"W5 editing an unrelated cell in the same workbook exited "
                   f"{s['other_exit']} — the guard is refusing whole files, not the "
                   f"one cell it is about")
    return out


@check("W6", "the calcChain cache is dropped on a formula edit and only then")
def w6_calcchain(ctx: dict) -> list[str]:
    c = ctx["calcchain"]
    out = []
    if not c["input_has"]:
        return ["W6 the constructed input carries no calcChain, so nothing is proven"]
    if c["after_formula_edit"]:
        out.append("W6 a stale calcChain survived a formula edit — this is what makes "
                   "Excel report a perfectly good file as damaged")
    if not c["after_value_edit"]:
        out.append("W6 the calcChain was dropped on a VALUE-only edit; the dependency "
                   "order did not change, so throwing it away costs a recalculation "
                   "for nothing")
    return out


@check("W7", "damage the edit did not cause is reported, not treated as fatal")
def w7_pre_existing(ctx: dict) -> list[str]:
    d = ctx["damage"]
    out = []
    if d["exit"] != 0 or not d["wrote"]:
        out.append(f"W7 a workbook that arrived with a dangling relationship was "
                   f"refused (exit {d['exit']}) — the files that most need editing "
                   f"are the damaged ones")
    if not d["pre_existing"]:
        out.append("W7 the pre-existing damage was not reported at all, so the user "
                   "has no way to know the file came in broken")
    return out


@check("C1", "column width counts a CJK character as two units, not one")
def c1_display_width(ctx: dict) -> list[str]:
    got = ctx["autofit"]["widths"].get("A")
    if got is None:
        return ["C1 column A got no explicit width at all"]
    if abs(got - LONG_LABEL_WIDTH) > 0.01:
        hint = (" — that is len()+2, which is exactly half the room the label needs"
                if abs(got - LONG_LABEL_LEN_WIDTH) < 0.01 else "")
        return [f"C1 column A width {got:g}, expected {LONG_LABEL_WIDTH} for "
                f"{LONG_LABEL!r}{hint}"]
    return []


@check("C2", "a formula's own text does not drive the width of its column")
def c2_formula_text(ctx: dict) -> list[str]:
    # 汇总!B holds =B2/利润表!B3 (14 characters). Counting it would demand ~16 units;
    # the widest DISPLAYED text in that column is 取值 at 6.
    widths = {(w["sheet"], w["column"]): w["width"]
              for w in ctx["autofit"]["report"]["widths"]}
    got = widths.get(("汇总", "B"))
    if got is None:
        return ["C2 汇总!B was not widened, so nothing is proven"]
    if got > 8:
        return [f"C2 汇总!B width {got:g} is wider than its widest displayed value; "
                f"the formula text is being measured and it is never shown"]
    return []


@check("C3", "a title merged across columns does not drive the first one; a vertical "
             "merge does")
def c3_merges(ctx: dict) -> list[str]:
    got = ctx["merge"]["width_a"]
    if got is None:
        return ["C3 column A got no width in the merge probe"]
    if abs(got - MERGE_EXPECT_WIDTH) < 0.01:
        return []
    if abs(got - MERGE_TITLE_WIDTH) < 0.01:
        return [f"C3 column A width {got:g} — that is the title merged across A:F, "
                f"which is DISPLAYED across six columns and must not size the first "
                f"one on its own"]
    if abs(got - MERGE_PLAIN_WIDTH) < 0.01:
        return [f"C3 column A width {got:g} — every merged cell was skipped, but a "
                f"merge inside a single column buys no horizontal room and still "
                f"has to fit ({MERGE_VERTICAL!r} needs {MERGE_EXPECT_WIDTH})"]
    return [f"C3 column A width {got:g}, expected {MERGE_EXPECT_WIDTH} "
            f"for the vertically merged {MERGE_VERTICAL!r}"]


@check("E1", "cols is written before sheetData, as the ECMA-376 sequence requires")
def e1_element_order(ctx: dict) -> list[str]:
    order = ctx["autofit"]["sheet_order"]
    if "cols" not in order:
        return ["E1 the autofit output has no cols element"]
    if "sheetData" not in order:
        return ["E1 the autofit output has no sheetData element"]
    if order.index("cols") > order.index("sheetData"):
        return [f"E1 cols appears after sheetData ({order}); CT_Worksheet is an "
                f"xsd:sequence and Excel offers to repair a file that gets it wrong"]
    return []


@check("O1", "stdout stays a summary on a large workbook")
def o1_stdout_budget(ctx: dict) -> list[str]:
    s = ctx["scale"]
    out = []
    if s["stdout_bytes"] > STDOUT_BUDGET:
        out.append(f"O1 reading {SCALE_ROWS} rows printed {s['stdout_bytes']} bytes to "
                   f"stdout (budget {STDOUT_BUDGET}) — that goes straight into the "
                   f"agent's context, and again across a Team delegation")
    if s["file_cells"] < SCALE_ROWS * 3:
        out.append(f"O1 the file written by --out holds only {s['file_cells']} cells; "
                   f"trimming stdout must not mean dropping the data")
    return out


@check("O2", "an output over its own input, or a missing file, gets one sentence")
def o2_contracts(ctx: dict) -> list[str]:
    out = []
    for script, r in ctx["scale"]["in_place"].items():
        if r["exit"] != 2:
            out.append(f"O2 {script} exited {r['exit']}, expected 2")
        elif "Traceback" in r["stderr"] or not r["stderr"].startswith("error: "):
            out.append(f"O2 {script} answered with {r['stderr'][:90]!r} instead of one "
                       f"actionable sentence")
    return out


@check("A1", "the audit finds an error token and names what caused it")
def a1_error(ctx: dict) -> list[str]:
    hits = [f for f in ctx["audit"]["broken"]["findings"]
            if f["class"] == "error" and f["cell"] == "利润表!C1"]
    if not hits:
        return ["A1 =#REF!*2 was not reported as an error"]
    if not hits[0].get("cause"):
        return ["A1 the error was reported with no cause — a token alone does not "
                "tell anyone which reference broke"]
    return []


@check("A2", "the audit finds a reference to a sheet that does not exist")
def a2_missing_sheet(ctx: dict) -> list[str]:
    """The #REF! that has not happened yet.

    Nothing in this stack refuses to STORE `=预算表!A1`; it becomes an error the
    first time Excel opens the file, long after anyone remembers writing it.
    """
    hits = [f for f in ctx["audit"]["broken"]["findings"]
            if f["class"] == "missing" and f["cell"] == "利润表!B1"]
    if not hits:
        return ["A2 a formula pointing at the non-existent sheet 预算表 was not "
                "reported"]
    if hits[0].get("sheet") != "预算表":
        return [f"A2 reported the wrong sheet name: {hits[0].get('sheet')!r}"]
    return []


@check("A3", "the audit finds circular chains, including a one-cell self-reference")
def a3_cycles(ctx: dict) -> list[str]:
    cycles = [f for f in ctx["audit"]["broken"]["findings"] if f["class"] == "circular"]
    starts = {f["cell"] for f in cycles}
    out = []
    if "利润表!F1" not in starts:
        out.append("A3 the self-reference =F1 was not reported")
    if not ({"利润表!D1", "利润表!E1"} & starts):
        out.append("A3 the two-cell cycle D1<->E1 was not reported")
    for f in cycles:
        if not f.get("chain") or "->" not in f["chain"]:
            out.append(f"A3 {f['cell']} was reported without the chain; a cycle with "
                       f"no path is not actionable")
    return out


@check("A4", "an uncalculated formula is reported, not counted as clean")
def a4_uncalc(ctx: dict) -> list[str]:
    clean = ctx["audit"]["clean"]
    n = clean["by_class"]["uncalc"]
    if n != clean["counts"]["formulas"]:
        return [f"A4 {n} of {clean['counts']['formulas']} formulas were reported as "
                f"uncalculated; a library-written workbook has NO cached values, so "
                f"every one of them should be"]
    return []


@check("A5", "the audit stays silent on a clean workbook, cross-sheet links included")
def a5_clean(ctx: dict) -> list[str]:
    clean = ctx["audit"]["clean"]
    noisy = {c: n for c, n in clean["by_class"].items()
             if c != "uncalc" and n}
    if noisy:
        return [f"A5 the clean fixture produced {noisy} — the 汇总 sheet's "
                f"cross-sheet formulas are legitimate and must not be findings"]
    if ctx["audit"]["clean_exit"] != 0:
        return [f"A5 auditing a clean workbook exited {ctx['audit']['clean_exit']}"]
    return []


@check("A6", "the reference parser ignores string literals and function names")
def a6_false_positives(ctx: dict) -> list[str]:
    """Both of these produced a false finding before they were handled.

    G1 holds `="见 预算表!A1 的说明"` — a sheet name inside a STRING, which is text,
    not a link. H1 holds `=LOG10(A1)`, where LOG10 matches the shape of a cell
    reference exactly; left alone it becomes a graph node and can invent a circular
    reference in a workbook that happens to use cell LOG10.
    """
    out = []
    flagged = ctx["audit"]["cells"]
    if "利润表!G1" in flagged:
        out.append("A6 a sheet name inside a string literal was treated as a "
                   "reference to a missing sheet")
    if "利润表!H1" in flagged:
        out.append("A6 LOG10( was parsed as a reference to cell LOG10")
    if "汇总!A1" in flagged:
        out.append("A6 a legitimate cross-sheet reference was flagged")
    return out


@check("Q1", "a formula naming a missing sheet is refused, and nothing is written")
def q1_refuse_missing_sheet(ctx: dict) -> list[str]:
    c = ctx["refuse"]["cases"]["missing sheet"]
    out = []
    if c["exit"] != 2:
        out.append(f"Q1 writing =预算表!A1 exited {c['exit']}; storing it succeeds "
                   f"everywhere and only breaks when Excel opens the file")
    if c["wrote"]:
        out.append("Q1 a file was written despite the refusal")
    if "预算表" not in c["stderr"]:
        out.append("Q1 the refusal does not name the sheet that is missing")
    return out


@check("Q2", "a formula with an error token baked into its text is refused")
def q2_refuse_error_token(ctx: dict) -> list[str]:
    c = ctx["refuse"]["cases"]["error token baked in"]
    if c["exit"] != 2 or c["wrote"]:
        return [f"Q2 =#REF!+1 was accepted (exit {c['exit']}, wrote {c['wrote']}) — "
                f"that is an error value, not an expression"]
    return []


@check("Q3", "a legitimate cross-sheet formula is accepted")
def q3_accept_legit(ctx: dict) -> list[str]:
    """The control for Q1/Q2: a guard that refuses everything is not a guard."""
    r = ctx["refuse"]
    if r["legit_exit"] != 0:
        return [f"Q3 writing =汇总!B2 into a workbook that HAS 汇总 exited "
                f"{r['legit_exit']} — the check is rejecting valid links"]
    if r["legit_formula"] != "=汇总!B2":
        return [f"Q3 the accepted formula read back as {r['legit_formula']!r}"]
    return []


@check("S1", "formatting lands on the named range and nowhere else")
def s1_format_scope(ctx: dict) -> list[str]:
    s = ctx["rebuild"]["style"]
    out = []
    for ref in ("B3", "C5"):
        cell = s[ref]
        if cell["number_format"] != "#,##0":
            out.append(f"S1 {ref} number format is {cell['number_format']!r}")
        if not cell["bold"] or cell["color"] != "FF0000FF":
            out.append(f"S1 {ref} font is bold={cell['bold']} color={cell['color']}")
        if cell["fill"] != "FFFFF2CC":
            out.append(f"S1 {ref} fill is {cell['fill']!r}, expected FFFFF2CC")
        if cell["border"] != "thin":
            out.append(f"S1 {ref} border is {cell['border']!r}")
    # D3 is OUTSIDE B3:C5. A formatter that quietly applies to the whole sheet
    # passes every check above.
    if ctx["rebuild"]["style"]["D3"]["fill"] == "FFFFF2CC":
        out.append("S1 D3 is outside the requested range and was formatted anyway")
    return out


@check("S2", "setting one font attribute keeps the others the cell already had")
def s2_font_merge(ctx: dict) -> list[str]:
    """`Font(color=...)` replaces the whole font object.

    Assigning a fresh Font to change a colour silently resets size and typeface to
    the defaults — the "I made one number blue and the row changed size" failure.
    """
    before, after = ctx["rebuild"]["style_before"]["B3"], ctx["rebuild"]["style"]["B3"]
    out = []
    if after["size"] != before["size"]:
        out.append(f"S2 B3 font size changed from {before['size']} to {after['size']} "
                   f"while only the colour was asked for")
    if after["name"] != before["name"]:
        out.append(f"S2 B3 typeface changed from {before['name']!r} to {after['name']!r}")
    return out


@check("S3", "every conditional-format rule kind arrives, and the existing one survives")
def s3_conditional(ctx: dict) -> list[str]:
    cf, before = ctx["rebuild"]["cf"], ctx["rebuild"]["cf_before"]
    out = []
    want = {"D3:D5": "cellIs", "B3:B5": "colorScale", "C3:C5": "dataBar"}
    for rng, kind in want.items():
        kinds = cf.get(rng, [])
        if kind not in kinds:
            out.append(f"S3 no {kind} rule on {rng} (got {kinds or 'nothing'})")
    # The fixture already carried a rule on D3:D5. Adding one must not replace it.
    kept = len(cf.get("D3:D5", []))
    if kept < len(before.get("D3:D5", [])) + 1:
        out.append(f"S3 D3:D5 holds {kept} rule(s); the fixture's own rule was "
                   f"replaced rather than added to")
    return out


@check("S4", "freeze panes and auto filter are set to the requested values")
def s4_panes(ctx: dict) -> list[str]:
    p, before = ctx["rebuild"]["panes"], ctx["rebuild"]["panes_before"]
    out = []
    if p["freeze"] != "C6":
        out.append(f"S4 freeze_panes is {p['freeze']!r}, expected C6"
                   + (" — that is the fixture's own value, so nothing happened"
                      if p["freeze"] == before["freeze"] else ""))
    if p["filter"] != "A2:C5":
        out.append(f"S4 auto_filter is {p['filter']!r}, expected A2:C5"
                   + (" — the fixture's own value" if p["filter"] == before["filter"]
                      else ""))
    return out


@check("S5", "a chart is added, named from the header, pointing at the requested data")
def s5_chart(ctx: dict) -> list[str]:
    c, before = ctx["rebuild"]["chart"], ctx["rebuild"]["chart_before"]
    out = []
    if c["count"] != before["count"] + 1:
        out.append(f"S5 汇总 holds {c['count']} chart(s), was {before['count']} — "
                   f"the new one replaced the fixture's instead of joining it")
    if not c["series_titles"] or not all(c["series_titles"]):
        out.append("S5 a series has no title reference — without titles_from_data the "
                   "legend reads Series1/Series2 and the chart is unreadable")
    refs = " ".join(r for r in c["series_refs"] if r)
    if "利润表" not in refs:
        out.append(f"S5 no series points at the requested sheet: {c['series_refs']}")
    return out


@check("G1", "every rebuild-path script gets the dropped parts back")
def g1_graft(ctx: dict) -> list[str]:
    """The headline of this slice.

    openpyxl drops all three customXml parts on ANY save. Each of these four
    artifacts went through load→mutate→save, so each is a chance to lose them.
    """
    r = ctx["rebuild"]
    want = r["custom_parts_in"]
    out = []
    if want < 3:
        return [f"G1 the input carries only {want} customXml part(s); the graft has "
                f"nothing to prove"]
    for tag, got in r["custom_parts"].items():
        if got != want:
            out.append(f"G1 {tag}: {got}/{want} customXml parts survived the rebuild")
    if not r["format_report"]["grafted"]:
        out.append("G1 the report claims nothing was grafted, yet openpyxl always "
                   "drops these parts — the repair is not being recorded")
    if r["format_report"]["still_missing"]:
        out.append(f"G1 still missing after the graft: "
                   f"{r['format_report']['still_missing']}")
    return out


@check("G2", "a rebuild that cannot restore what it lost writes nothing")
def g2_graft_fault(ctx: dict) -> list[str]:
    """Fault injection: the graft is disabled and the rebuild must refuse.

    Without this, G1 passing proves the parts survive — not that anything would
    notice if they stopped. A repair path nobody has watched fail is not evidence.
    """
    got = ctx["graft_fault"]["stdout"]
    out = []
    if "RAISED=yes" not in got:
        out.append(f"G2 with the graft disabled the rebuild did not refuse: {got!r}")
    elif "True" not in got.split("RAISED=yes")[1].split("\n")[0]:
        out.append("G2 it refused but did not name the part it lost")
    if "WROTE= False" not in got:
        out.append(f"G2 a file was written despite the refusal: {got!r}")
    return out


@check("K1", "the python engine matches every pinned value")
def k1_pins(ctx: dict) -> list[str]:
    m = ctx["calibration"]["mismatches"]
    return [f"K1 {x['formula']}: pinned {x['pinned']!r}, python {x['python']!r}"
            for x in m[:6]]


@check("K2", "everything outside the boundary is refused, never quietly computed")
def k2_refusals(ctx: dict) -> list[str]:
    """The one behaviour the evaluator must never have.

    A cross-check has value only if it can be wrong loudly. A function that is not
    implemented but returns something plausible is worse than no evaluator at all.
    """
    return [f"K2 {x['formula']} must be refused ({x['why']}) — got {x['got']!r}"
            for x in ctx["calibration"]["leaked"][:6]]


@check("K3", "every function the evaluator claims to support is actually exercised")
def k3_coverage(ctx: dict) -> list[str]:
    missing = ctx["calibration"]["unexercised"]
    if missing:
        return [f"K3 SUPPORTED names never run by the corpus: {', '.join(missing)} — "
                f"a claim nothing measures is a wish list (L1's C5, one level down)"]
    return []


@check("K4", "LibreOffice agrees with every pinned value")
def k4_pin_truth(ctx: dict) -> list[str]:
    """Checks the PINS, not the engine.

    K1 compares the python engine against these numbers; only this compares the
    numbers against the authority they came from. Skipped where LibreOffice is
    absent — and named in the skip list, because that is the exact hole X3 sat in.
    """
    c = ctx["calibration"]
    if not c["soffice_available"]:
        return []
    return [f"K4 {x['formula']}: pinned {x['pinned']!r}, LibreOffice {x['soffice']!r} "
            f"— the PIN is wrong, not the engine" for x in c["soffice_drift"][:6]]


@check("K5", "recalculation writes cached values a value-reader can actually see")
def k5_cached(ctx: dict) -> list[str]:
    r = ctx["recalc"]
    out = []
    if any(v is not None for v in r["cached_before"].values()):
        out.append("K5 the input already had cached values, so writing them proves "
                   "nothing")
    for ref, want in (("B5", 471),):
        got = r["cached_after"].get(ref)
        if not isinstance(got, (int, float)) or abs(float(got) - want) > 1e-6:
            out.append(f"K5 {ref} reads back as {got!r} after recalculation, "
                       f"expected {want}")
    # The formula must survive: a "recalculation" that replaces =B3-B4 with 471 has
    # destroyed the model to produce a number.
    if r["formula_after"].get("B5") != "=B3-B4":
        out.append(f"K5 the formula in B5 became {r['formula_after'].get('B5')!r} — "
                   f"caching a result must not overwrite the formula")
    return out


@check("K6", "a formula only one engine can do is reported, not silently dropped")
def k6_partial(ctx: dict) -> list[str]:
    """VLOOKUP: LibreOffice computes it, the python engine refuses it.

    The report must say so. Without this, "0 disagreements" would be reachable by
    an engine that simply declines everything.
    """
    rep = ctx["recalc"]["mixed"]
    out = []
    unsupported = [f for f in rep["findings"] if f["class"] == "unsupported"]
    if not any("VLOOKUP" in (f.get("formula") or "") for f in unsupported):
        out.append("K6 the VLOOKUP the python engine cannot do was not reported as "
                   "unsupported")
    for f in unsupported:
        if not f.get("formula"):
            out.append(f"K6 {f['cell']} is reported unsupported without its formula "
                       f"text — the caller is told nothing it can act on")
    if rep["cross_checked"] >= rep["formulas"]:
        out.append(f"K6 the report claims {rep['cross_checked']} of {rep['formulas']} "
                   f"formulas were cross-checked, but one engine could not do them all")
    return out


@check("K7", "a single-engine run never presents itself as cross-checked")
def k7_single_engine(ctx: dict) -> list[str]:
    solo, both = ctx["recalc"]["python_only"], ctx["recalc"]["mixed"]
    out = []
    if solo["cross_checked_by_two_engines"]:
        out.append("K7 --engine python reported itself as cross-checked by two engines")
    if solo["cross_checked"]:
        out.append(f"K7 --engine python reports {solo['cross_checked']} cross-checked "
                   f"cells; nothing checked it")
    if not both["cross_checked_by_two_engines"] and ctx["calibration"]["soffice_available"]:
        out.append("K7 the two-engine run does not report itself as cross-checked")
    return out


# ── negative controls ─────────────────────────────────────────────────────────
def flaw_write_via_load_save(ctx, work):
    """The implementation everyone reaches for first, measured on the same edit."""
    w = ctx["write"]
    w["parts_after"] = list(w["naive_parts_after"])
    w["identical"] = list(w["naive_identical"])
    w["report"] = {**w["report"],
                   "parts_lost": sorted(set(w["parts_before"]) - set(w["naive_parts_after"]))}
    return ctx


def flaw_write_rebuilds_every_part(ctx, work):
    ctx["write"]["identical"] = []
    return ctx


def flaw_edit_misses_the_cell(ctx, work):
    ctx["write"]["cells"]["B3"] = 1240
    return ctx


def flaw_edit_resets_style(ctx, work):
    ctx["write"]["styles"] = {**ctx["write"]["styles"], "D5": None}
    return ctx


def flaw_append_overwrites_last_row(ctx, work):
    ctx["write"]["cells"] = {**ctx["write"]["cells"], "A6": None, "B5": "其他业务收入"}
    return ctx


def flaw_shared_formula_overwritten(ctx, work):
    ctx["shared"] = {**ctx["shared"], "master_exit": 0, "master_wrote": True}
    return ctx


def flaw_shared_guard_refuses_whole_file(ctx, work):
    ctx["shared"] = {**ctx["shared"], "other_exit": 2}
    return ctx


def flaw_keeps_stale_calcchain(ctx, work):
    ctx["calcchain"] = {**ctx["calcchain"], "after_formula_edit": True}
    return ctx


def flaw_drops_calcchain_always(ctx, work):
    ctx["calcchain"] = {**ctx["calcchain"], "after_value_edit": False}
    return ctx


def flaw_refuses_damaged_input(ctx, work):
    ctx["damage"] = {**ctx["damage"], "exit": 2, "wrote": False}
    return ctx


def flaw_hides_pre_existing_damage(ctx, work):
    ctx["damage"] = {**ctx["damage"], "pre_existing": []}
    return ctx


def flaw_width_counts_len(ctx, work):
    """`len(s) + 2` — the width every implementation that has not met CJK computes."""
    ctx["autofit"] = {**ctx["autofit"],
                      "widths": {**ctx["autofit"]["widths"],
                                 "A": float(LONG_LABEL_LEN_WIDTH)}}
    return ctx


def flaw_width_counts_formula_text(ctx, work):
    report = copy.deepcopy(ctx["autofit"]["report"])
    for w in report["widths"]:
        if (w["sheet"], w["column"]) == ("汇总", "B"):
            w["width"] = 16
    ctx["autofit"] = {**ctx["autofit"], "report": report}
    return ctx


def flaw_width_counts_merged_title(ctx, work):
    ctx["merge"] = {"width_a": float(MERGE_TITLE_WIDTH)}
    return ctx


def flaw_width_ignores_every_merge(ctx, work):
    """"Skip merged cells" implemented without asking which direction they span."""
    ctx["merge"] = {"width_a": float(MERGE_PLAIN_WIDTH)}
    return ctx


def flaw_cols_appended_after_sheetdata(ctx, work):
    order = [t for t in ctx["autofit"]["sheet_order"] if t != "cols"]
    ctx["autofit"] = {**ctx["autofit"], "sheet_order": order + ["cols"]}
    return ctx


def flaw_read_values_only(ctx, work):
    read = copy.deepcopy(ctx["read"]["json"])
    for c in read["cells"]:
        c["formula"] = None
    ctx["read"] = {**ctx["read"], "json": read}
    return ctx


def flaw_read_uncalculated_as_empty(ctx, work):
    read = copy.deepcopy(ctx["read"]["json"])
    for c in read["cells"]:
        c["uncalculated"] = False
    ctx["read"] = {**ctx["read"], "json": read}
    return ctx


def flaw_read_clamps_bad_range(ctx, work):
    rejects = copy.deepcopy(ctx["read"]["rejects"])
    rejects[1] = {**rejects[1], "exit": 0, "stderr": ""}
    ctx["read"] = {**ctx["read"], "rejects": rejects}
    return ctx


def flaw_read_raises_traceback(ctx, work):
    rejects = copy.deepcopy(ctx["read"]["rejects"])
    rejects[0] = {**rejects[0], "exit": 1,
                  "stderr": "Traceback (most recent call last):\n  ...\n"
                            "ValueError: Value must be of type <class 'int'>"}
    ctx["read"] = {**ctx["read"], "rejects": rejects}
    return ctx


def flaw_inventory_forgets_a_sheet(ctx, work):
    read = copy.deepcopy(ctx["read"]["json"])
    read["sheets"] = [s for s in read["sheets"] if s["name"] != "汇总"]
    ctx["read"] = {**ctx["read"], "json": read}
    return ctx


def flaw_stdout_dumps_every_cell(ctx, work):
    ctx["scale"] = {**ctx["scale"], "stdout_bytes": 480_000}
    return ctx


def flaw_trimming_loses_data(ctx, work):
    """Trimming stdout by dropping the rows instead of routing them to --out."""
    ctx["scale"] = {**ctx["scale"], "file_cells": 20}
    return ctx


def flaw_in_place_allowed(ctx, work):
    scale = copy.deepcopy(ctx["scale"])
    scale["in_place"]["xlsx_write.py"] = {"exit": 0, "stderr": ""}
    ctx["scale"] = scale
    return ctx


def flaw_fixture_stops_exercising_autofit(ctx, work):
    """A fixture whose columns are nearly all wide enough already.

    V0's own control has to be something no other check owns, or it cannot be told
    apart from them. Dropping a sheet — the obvious choice — is what
    `inventory-forgets-a-sheet` already does, so it would prove nothing about V0.
    The 汇总!B entry C2 reads is kept, so only V0 notices.
    """
    report = copy.deepcopy(ctx["autofit"]["report"])
    report["widths"] = [w for w in report["widths"]
                        if (w["sheet"], w["column"]) == ("汇总", "B")]
    ctx["autofit"] = {**ctx["autofit"], "report": report}
    return ctx


def _drop_findings(ctx, keep):
    """Rebuild the broken-workbook audit keeping only `keep(f)` findings."""
    a = copy.deepcopy(ctx["audit"])
    a["broken"]["findings"] = [f for f in a["broken"]["findings"] if keep(f)]
    a["broken"]["by_class"] = {
        c: sum(1 for f in a["broken"]["findings"] if f["class"] == c)
        for c in a["broken"]["by_class"]}
    a["cells"] = {f["cell"] for f in a["broken"]["findings"] if f["class"] != "uncalc"}
    ctx["audit"] = a
    return ctx


def flaw_audit_scans_formulas_only(ctx, work):
    """Reporting the token but never saying which reference produced it."""
    a = copy.deepcopy(ctx["audit"])
    for f in a["broken"]["findings"]:
        if f["class"] == "error":
            f["cause"] = None
    ctx["audit"] = a
    return ctx


def flaw_audit_misses_missing_sheet(ctx, work):
    """The plausible implementation: only scan for tokens already present."""
    return _drop_findings(ctx, lambda f: f["class"] != "missing")


def flaw_audit_no_cycle_detection(ctx, work):
    return _drop_findings(ctx, lambda f: f["class"] != "circular")


def flaw_audit_cycle_without_chain(ctx, work):
    a = copy.deepcopy(ctx["audit"])
    for f in a["broken"]["findings"]:
        if f["class"] == "circular":
            f["chain"] = ""
    ctx["audit"] = a
    return ctx


def flaw_audit_misses_self_reference(ctx, work):
    """=F1 is the cycle a graph walker that never revisits its start will skip."""
    return _drop_findings(ctx, lambda f: f["cell"] != "利润表!F1")


def flaw_audit_treats_uncalc_as_clean(ctx, work):
    a = copy.deepcopy(ctx["audit"])
    a["clean"]["by_class"]["uncalc"] = 0
    ctx["audit"] = a
    return ctx


def flaw_audit_flags_clean_cross_sheet(ctx, work):
    a = copy.deepcopy(ctx["audit"])
    a["clean"]["by_class"]["missing"] = 2
    ctx["audit"] = a
    return ctx


def flaw_parser_reads_string_literals(ctx, work):
    a = copy.deepcopy(ctx["audit"])
    a["cells"] = set(a["cells"]) | {"利润表!G1"}
    ctx["audit"] = a
    return ctx


def flaw_parser_reads_function_names(ctx, work):
    a = copy.deepcopy(ctx["audit"])
    a["cells"] = set(a["cells"]) | {"利润表!H1"}
    ctx["audit"] = a
    return ctx


def flaw_write_stores_missing_sheet_ref(ctx, work):
    r = copy.deepcopy(ctx["refuse"])
    r["cases"]["missing sheet"] = {"exit": 0, "stderr": "", "wrote": True}
    ctx["refuse"] = r
    return ctx


def flaw_write_stores_error_token(ctx, work):
    r = copy.deepcopy(ctx["refuse"])
    r["cases"]["error token baked in"] = {"exit": 0, "stderr": "", "wrote": True}
    ctx["refuse"] = r
    return ctx


def flaw_write_refuses_every_cross_sheet(ctx, work):
    """A guard that refuses all cross-sheet links passes Q1/Q2 and is useless."""
    r = copy.deepcopy(ctx["refuse"])
    r["legit_exit"] = 2
    ctx["refuse"] = r
    return ctx


def _style(ctx, ref, **kw):
    r = copy.deepcopy(ctx["rebuild"])
    r["style"][ref].update(kw)
    ctx["rebuild"] = r
    return ctx


def flaw_format_applies_to_whole_sheet(ctx, work):
    return _style(ctx, "D3", fill="FFFFF2CC")


def flaw_format_misses_the_range(ctx, work):
    return _style(ctx, "C5", number_format="General", bold=False, color=None,
                  fill=None, border=None)


def flaw_font_replaced_wholesale(ctx, work):
    """`cell.font = Font(color=...)` — the one-liner that resets size and face."""
    return _style(ctx, "B3", size=11.0, name="Calibri")


def flaw_conditional_replaces_existing(ctx, work):
    r = copy.deepcopy(ctx["rebuild"])
    r["cf"]["D3:D5"] = ["cellIs"]
    ctx["rebuild"] = r
    return ctx


def flaw_conditional_drops_a_kind(ctx, work):
    r = copy.deepcopy(ctx["rebuild"])
    r["cf"].pop("C3:C5", None)
    ctx["rebuild"] = r
    return ctx


def flaw_panes_left_at_the_fixture_value(ctx, work):
    r = copy.deepcopy(ctx["rebuild"])
    r["panes"] = dict(r["panes_before"])
    ctx["rebuild"] = r
    return ctx


def flaw_chart_replaces_the_existing_one(ctx, work):
    r = copy.deepcopy(ctx["rebuild"])
    r["chart"]["count"] = r["chart_before"]["count"]
    ctx["rebuild"] = r
    return ctx


def flaw_chart_series_unnamed(ctx, work):
    """titles_from_data left off: the legend reads Series1, Series2."""
    r = copy.deepcopy(ctx["rebuild"])
    r["chart"]["series_titles"] = [None] * len(r["chart"]["series_titles"])
    ctx["rebuild"] = r
    return ctx


def flaw_rebuild_without_graft(ctx, work):
    """What `load → mutate → save` does on its own: the customXml parts are gone."""
    r = copy.deepcopy(ctx["rebuild"])
    r["custom_parts"] = {k: 0 for k in r["custom_parts"]}
    r["format_report"] = {**r["format_report"], "grafted": []}
    ctx["rebuild"] = r
    return ctx


def flaw_graft_reports_a_repair_it_did_not_make(ctx, work):
    r = copy.deepcopy(ctx["rebuild"])
    r["format_report"] = {**r["format_report"],
                          "still_missing": ["customXml/item1.xml"]}
    ctx["rebuild"] = r
    return ctx


def flaw_rebuild_writes_anyway(ctx, work):
    ctx["graft_fault"] = {"stdout": "RAISED=no\nWROTE= True", "exit": 0}
    return ctx


def _cal(ctx, **kw):
    c = copy.deepcopy(ctx["calibration"])
    c.update(kw)
    ctx["calibration"] = c
    return ctx


def flaw_evaluator_gets_a_number_wrong(ctx, work):
    """The first draft's answer for -2^2: right in most languages, wrong in Excel."""
    return _cal(ctx, mismatches=[{"formula": "=-2^2", "pinned": 4, "python": -4.0}])


def flaw_evaluator_guesses_instead_of_refusing(ctx, work):
    return _cal(ctx, leaked=[{"formula": "=VLOOKUP(H1,H1:I3,2,0)",
                              "why": "not implemented", "got": ("VALUE", 20.0)}])


def flaw_supported_is_a_wish_list(ctx, work):
    return _cal(ctx, unexercised=["MEDIAN", "XLOOKUP"])


def flaw_pinned_value_is_wrong(ctx, work):
    """X3's defect, one level down: the expectation itself is wrong."""
    return _cal(ctx, soffice_available=True,
                soffice_drift=[{"formula": "=MOD(-7,3)", "pinned": -1, "soffice": 2}])


def flaw_recalc_leaves_no_cached_values(ctx, work):
    r = copy.deepcopy(ctx["recalc"])
    r["cached_after"] = {"B5": None, "D5": None}
    ctx["recalc"] = r
    return ctx


def flaw_recalc_overwrites_the_formula(ctx, work):
    r = copy.deepcopy(ctx["recalc"])
    r["formula_after"]["B5"] = 471
    ctx["recalc"] = r
    return ctx


def flaw_unsupported_reported_without_the_formula(ctx, work):
    r = copy.deepcopy(ctx["recalc"])
    for f in r["mixed"]["findings"]:
        if f["class"] == "unsupported":
            f["formula"] = None
    ctx["recalc"] = r
    return ctx


def flaw_unsupported_silently_dropped(ctx, work):
    r = copy.deepcopy(ctx["recalc"])
    r["mixed"]["findings"] = [f for f in r["mixed"]["findings"]
                              if f["class"] != "unsupported"]
    ctx["recalc"] = r
    return ctx


def flaw_single_engine_claims_cross_check(ctx, work):
    r = copy.deepcopy(ctx["recalc"])
    r["python_only"]["cross_checked_by_two_engines"] = True
    ctx["recalc"] = r
    return ctx


FLAWS = [
    ("evaluator-gets-a-number-wrong", flaw_evaluator_gets_a_number_wrong, {"K1"}, ""),
    ("evaluator-guesses-instead-of-refusing", flaw_evaluator_guesses_instead_of_refusing,
     {"K2"}, ""),
    ("supported-list-is-a-wish-list", flaw_supported_is_a_wish_list, {"K3"}, ""),
    ("the-pinned-value-itself-is-wrong", flaw_pinned_value_is_wrong, {"K4"}, ""),
    ("recalc-leaves-no-cached-values", flaw_recalc_leaves_no_cached_values, {"K5"}, ""),
    ("recalc-overwrites-the-formula-with-its-result",
     flaw_recalc_overwrites_the_formula, {"K5"}, ""),
    ("unsupported-reported-without-its-formula",
     flaw_unsupported_reported_without_the_formula, {"K6"}, ""),
    ("unsupported-formulas-silently-dropped", flaw_unsupported_silently_dropped,
     {"K6"}, ""),
    ("single-engine-run-claims-it-was-cross-checked",
     flaw_single_engine_claims_cross_check, {"K7"}, ""),

    ("format-applies-to-the-whole-sheet", flaw_format_applies_to_whole_sheet,
     {"S1"}, ""),
    ("format-never-reaches-the-range", flaw_format_misses_the_range, {"S1"}, ""),
    ("font-assigned-wholesale-resets-size-and-face", flaw_font_replaced_wholesale,
     {"S2"}, ""),
    ("conditional-rule-replaces-the-existing-one", flaw_conditional_replaces_existing,
     {"S3"}, ""),
    ("conditional-drops-a-rule-kind", flaw_conditional_drops_a_kind, {"S3"}, ""),
    ("panes-left-at-the-fixture-value", flaw_panes_left_at_the_fixture_value,
     {"S4"}, ""),
    ("chart-replaces-the-existing-one", flaw_chart_replaces_the_existing_one,
     {"S5"}, ""),
    ("chart-series-come-out-unnamed", flaw_chart_series_unnamed, {"S5"}, ""),
    ("rebuild-without-the-graft", flaw_rebuild_without_graft, {"G1"}, ""),
    ("graft-claims-a-repair-it-did-not-make", flaw_graft_reports_a_repair_it_did_not_make,
     {"G1"}, ""),
    ("rebuild-writes-a-lossy-file-anyway", flaw_rebuild_writes_anyway, {"G2"}, ""),

    ("audit-names-the-token-but-not-the-cause", flaw_audit_scans_formulas_only,
     {"A1"}, ""),
    ("audit-only-scans-for-existing-tokens", flaw_audit_misses_missing_sheet,
     {"A2"}, ""),
    ("audit-does-not-look-for-cycles", flaw_audit_no_cycle_detection, {"A3"}, ""),
    ("audit-reports-a-cycle-without-the-chain", flaw_audit_cycle_without_chain,
     {"A3"}, ""),
    ("audit-misses-a-one-cell-self-reference", flaw_audit_misses_self_reference,
     {"A3"}, ""),
    ("audit-counts-uncalculated-formulas-as-clean", flaw_audit_treats_uncalc_as_clean,
     {"A4"}, ""),
    ("audit-flags-a-legitimate-cross-sheet-link", flaw_audit_flags_clean_cross_sheet,
     {"A5"}, ""),
    ("parser-reads-references-inside-strings", flaw_parser_reads_string_literals,
     {"A6"}, ""),
    ("parser-reads-LOG10-as-a-cell", flaw_parser_reads_function_names, {"A6"}, ""),
    ("write-stores-a-reference-to-a-missing-sheet", flaw_write_stores_missing_sheet_ref,
     {"Q1"}, ""),
    ("write-stores-an-error-token-as-a-formula", flaw_write_stores_error_token,
     {"Q2"}, ""),
    ("write-refuses-every-cross-sheet-link", flaw_write_refuses_every_cross_sheet,
     {"Q3"}, ""),

    ("write-via-openpyxl-load-save", flaw_write_via_load_save, {"W1", "W2"},
     "W2 also fires, and it must: load→save both loses parts and rebuilds the ones "
     "it keeps. W1 owns the loss, W2 owns the rebuild, and this one flaw is where "
     "both come from"),
    ("write-rebuilds-every-part", flaw_write_rebuilds_every_part, {"W2"}, ""),
    ("edit-does-not-reach-the-cell", flaw_edit_misses_the_cell, {"W3"}, ""),
    ("edit-resets-the-cell-format", flaw_edit_resets_style, {"W3"}, ""),
    ("append-overwrites-the-last-row", flaw_append_overwrites_last_row, {"W4"}, ""),
    ("shared-formula-master-overwritten", flaw_shared_formula_overwritten, {"W5"}, ""),
    ("shared-formula-guard-refuses-the-whole-file",
     flaw_shared_guard_refuses_whole_file, {"W5"}, ""),
    ("keeps-a-stale-calcchain", flaw_keeps_stale_calcchain, {"W6"}, ""),
    ("drops-the-calcchain-on-every-edit", flaw_drops_calcchain_always, {"W6"}, ""),
    ("refuses-an-already-damaged-input", flaw_refuses_damaged_input, {"W7"}, ""),
    ("hides-pre-existing-damage", flaw_hides_pre_existing_damage, {"W7"}, ""),

    ("width-counts-characters-not-display-units", flaw_width_counts_len, {"C1"}, ""),
    ("width-measures-the-formula-text", flaw_width_counts_formula_text, {"C2"}, ""),
    ("width-counts-a-title-merged-across-columns", flaw_width_counts_merged_title,
     {"C3"}, ""),
    ("width-ignores-merges-in-both-directions", flaw_width_ignores_every_merge,
     {"C3"}, ""),
    ("cols-appended-after-sheetdata", flaw_cols_appended_after_sheetdata, {"E1"}, ""),

    ("read-returns-values-only", flaw_read_values_only, {"R1", "V0"},
     "V0 also fires, honestly: a reader that reports no formulas at all leaves the "
     "window with zero formula cells, and R1/R2 then have no subjects. V0 is the "
     "check that says so"),
    ("read-reports-uncalculated-as-empty", flaw_read_uncalculated_as_empty, {"R2"}, ""),
    ("read-clamps-an-oversized-range", flaw_read_clamps_bad_range, {"R3"}, ""),
    ("read-answers-with-a-traceback", flaw_read_raises_traceback, {"R3"}, ""),
    ("inventory-forgets-a-sheet", flaw_inventory_forgets_a_sheet, {"R4", "V0"},
     "V0 also fires: with only one sheet left the fixture no longer carries the "
     "cross-sheet reference the later capabilities rest on. Both findings are true "
     "and they say different things"),

    ("stdout-dumps-every-cell", flaw_stdout_dumps_every_cell, {"O1"}, ""),
    ("trimming-drops-the-data-instead-of-filing-it", flaw_trimming_loses_data,
     {"O1"}, ""),
    ("writer-overwrites-its-own-input", flaw_in_place_allowed, {"O2"}, ""),

    ("CONTROL: fixture stops exercising autofit",
     flaw_fixture_stops_exercising_autofit, {"V0"}, ""),
]


def fired(ctx: dict) -> dict[str, list[str]]:
    out = {}
    for cid, c in CHECKS.items():
        findings = c["fn"](ctx)
        if findings:
            out[cid] = findings
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    for f in (BOOK, NARROW):
        if not f.is_file():
            print(f"[error] fixture missing: {f} (run fixtures/make_fixtures.py)",
                  file=sys.stderr)
            return 1

    results = []
    SKIPS.clear()
    with tempfile.TemporaryDirectory(prefix="xlsx-skill-test-") as td:
        work = Path(td)
        base = collect(work)

        clean = fired(base)
        results.append({"case": "real output of the real scripts", "expect": "silence",
                        "ok": not clean,
                        "detail": [f for v in clean.values() for f in v]})

        matrix = []
        for name, mutate, expected, cascade in FLAWS:
            ctx = mutate(copy.deepcopy(base), work)
            got = fired(ctx)
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
                          "skipped": SKIPS, "failed": len(failed)},
                         ensure_ascii=False, indent=2))
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
        print(f"  {m['flaw']:<46} -> {', '.join(m['fired']) or '(nothing)'}{note}")
    if SKIPS:
        print("\n[skipped] claims this host could not exercise:")
        for note in SKIPS:
            print(f"  - {note}")
    print(f"\n[xlsx-skill] {len(results) - len(failed)} passed, {len(failed)} failed, "
          f"{len(CHECKS)} assertions"
          + (f", {len(SKIPS)} skipped" if SKIPS else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
