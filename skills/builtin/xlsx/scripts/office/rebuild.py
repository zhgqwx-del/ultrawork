#!/usr/bin/env python3
"""The other write path: let openpyxl rebuild the package, then put back what it lost.

`sheet.py` edits the XML in place and touches nothing else — the right answer for
values, formulas and widths. It is the wrong answer for CREATING a conditional
format, a chart or a border, because those are large, interlocking structures
(styles.xml + the sheet + a drawing + a rels graph) and hand-writing them is how you
produce a file Excel offers to repair.

So this path accepts the rebuild and repairs the damage:

    load → mutate via the object model → save → graft the lost parts back → verify

The graft is measured, not hoped for. On this skill's own fixture, openpyxl drops
three customXml parts on any save; after grafting, zero are missing and the package
validates. What it CANNOT repair is loss inside a part it rewrote — the
`<ignoredErrors>` element that disappears from a surviving sheet1.xml has no
part-level signature. That limit is reported, not papered over: `still_missing` is
always in the report, and anything left there is a failure.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from .package import Package, graft_missing_parts, part_is_inert
from .validate import check_package


class RebuildError(Exception):
    """The rebuild produced something worse than the input."""


def rebuild(src: Path, out: Path, mutate, keep_vba: bool | None = None) -> dict:
    """Open `src` with openpyxl, hand the workbook to `mutate`, write `out`.

    `mutate(workbook)` may return a dict of notes to fold into the report.
    """
    import openpyxl

    if not src.is_file():
        raise RebuildError(f"no such file: {src}")
    # .xlsm carries its macros in a part openpyxl only preserves when asked. The
    # graft would restore the bin either way, but not the content-type override
    # that makes the file macro-enabled, so this is not something to leave to luck.
    if keep_vba is None:
        keep_vba = src.suffix.lower() in (".xlsm", ".xltm")
    try:
        wb = openpyxl.load_workbook(src, keep_vba=keep_vba)
    except Exception as e:  # noqa: BLE001 - openpyxl raises several unrelated types
        raise RebuildError(f"cannot open {src.name} as a workbook: "
                           f"{type(e).__name__}: {e}") from e
    try:
        notes = mutate(wb) or {}
    finally:
        pass

    with tempfile.TemporaryDirectory(prefix="xlsx-rebuild-") as td:
        staged = Path(td) / "staged.xlsx"
        try:
            wb.save(staged)
        finally:
            wb.close()

        baseline = Package.open(src)
        produced = Package.open(staged)
        graft = graft_missing_parts(baseline, produced)
        produced.save(out)

    # Verified against the FILE on disk, not the in-memory package: an in-memory
    # check agrees with itself even when saving wrote something else.
    final = Package.open(out)
    lost = []
    for name in sorted(set(baseline.parts) - set(final.parts)):
        if name in {s["part"] for s in graft["skipped"]}:
            continue
        if part_is_inert(name, baseline.parts[name]):
            continue
        lost.append(name)
    if lost:
        out.unlink(missing_ok=True)
        raise RebuildError(
            "the rebuild lost part(s) the graft could not restore, so nothing was "
            "written: " + ", ".join(lost))

    was = set(check_package(baseline))
    now = check_package(final)
    introduced = [f for f in now if f not in was]
    if introduced:
        out.unlink(missing_ok=True)
        raise RebuildError("the rebuild would have introduced package damage, so "
                           "nothing was written: " + "; ".join(introduced[:3]))

    import openpyxl
    try:
        check = openpyxl.load_workbook(out)
        check.close()
    except Exception as e:  # noqa: BLE001
        out.unlink(missing_ok=True)
        raise RebuildError(f"the rebuilt workbook cannot be reopened: "
                           f"{type(e).__name__}: {e}") from e

    return {
        "path": "openpyxl-rebuild+graft",
        "parts_in": len(baseline.parts),
        "parts_out": len(final.parts),
        "grafted": [r["part"] for r in graft["restored"]],
        "dropped_deliberately": [{"part": s["part"], "why": s["reason"]}
                                 for s in graft["skipped"]],
        # Always present, always empty on success. A report that only mentions loss
        # when there is some cannot be told apart from one nobody wrote.
        "still_missing": lost,
        "pre_existing_package_findings": sorted(was),
        **notes,
    }
