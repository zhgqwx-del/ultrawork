#!/usr/bin/env python3
"""X13 — render a workbook to PDF (and optionally to page images).

This is not a nicety. **A .xlsx cannot be previewed inside ultrawork** — the
artifact panel renders PDF and shows a binary info card for everything else — so
converting to PDF is the only way a workbook this skill produced becomes something
the user can actually look at without leaving the app (059 §7).

    python3 xlsx_pdf.py --in book.xlsx --out book.pdf
    python3 xlsx_pdf.py --in book.xlsx --out book.pdf --png ./pages --dpi 150
    python3 xlsx_pdf.py --in book.xlsx --out book.pdf --sheet 利润表

Requires LibreOffice, which is a declared dependency of this skill. There is no
pure-Python fallback and pretending otherwise would mean inventing a layout engine:
column widths, page breaks, print areas and number formats all have to be resolved
the way a spreadsheet application resolves them.

Two things it refuses rather than papers over:

  * **a PDF with no ink on the first page.** LibreOffice exits 0 for an empty
    sheet and produces a blank page; handing that back as "your preview" is worse
    than an error, because it looks like the data is gone.
  * **a workbook whose formulas have never been calculated.** Those cells render
    EMPTY. The file looks wrong and the cause is invisible in the picture.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from office.soffice import convert, find_soffice  # noqa: E402
from xlsxcommon import XlsxError, emit, ensure_distinct, fail, run  # noqa: E402

# Share of dark pixels below which a page counts as blank. Calibrated against the
# same raster the repo's L2 gate uses, which was itself standardised after a
# synthetic-only threshold misfired on real output (gotchas §10⑭).
BLANK_INK = 0.0005
BLANK_DPI = 100


def hidden_sheets(path: Path) -> list[str]:
    import openpyxl
    from contextlib import closing
    wb = openpyxl.load_workbook(path, read_only=True)
    with closing(wb):
        return [ws.title for ws in wb.worksheets if ws.sheet_state != "visible"]


def uncalculated(path: Path) -> int:
    import openpyxl
    from contextlib import closing
    f = openpyxl.load_workbook(path, read_only=True, data_only=False)
    v = openpyxl.load_workbook(path, read_only=True, data_only=True)
    n = 0
    with closing(f), closing(v):
        for name in f.sheetnames:
            for frow, vrow in zip(f[name].iter_rows(values_only=True),
                                  v[name].iter_rows(values_only=True)):
                for a, b in zip(frow, vrow):
                    if isinstance(a, str) and a.startswith("=") and b is None:
                        n += 1
    return n


def only_sheet(src: Path, name: str, workdir: Path) -> Path:
    """A copy with every other sheet removed, so --sheet means one sheet."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from office.package import Package
    import openpyxl
    from contextlib import closing
    wb = openpyxl.load_workbook(src)
    with closing(wb):
        if name not in wb.sheetnames:
            fail(f"no sheet named {name!r} (have: {', '.join(wb.sheetnames)})")
        for other in [s for s in wb.sheetnames if s != name]:
            del wb[other]
        trimmed = workdir / src.name
        wb.save(trimmed)
    return trimmed


def page_ink(page) -> float:
    """Share of dark pixels on one page, rendered grey at BLANK_DPI.

    `stride` is the row length in bytes and is NOT always the width — PDFium pads
    rows — so the rows are counted individually. Treating the buffer as one flat
    w*h run divides by a length that includes padding bytes and quietly reports
    less ink than there is, which on this threshold is the difference between
    "blank" and "fine".
    """
    bitmap = page.render(scale=BLANK_DPI / 72.0, grayscale=True)
    buf, stride, width, height = (bitmap.buffer, bitmap.stride, bitmap.width,
                                  bitmap.height)
    if not width or not height:
        return 0.0
    dark = bytes(1 if v < 140 else 0 for v in range(256))
    hits = sum(bytes(buf[r * stride:r * stride + width]).translate(dark).count(1)
               for r in range(height))
    return hits / (width * height)


def inspect_pdf(pdf: Path, png_dir: Path | None, dpi: int) -> dict:
    try:
        import pypdfium2 as pdfium
    except ImportError:
        # pypdfium2 belongs to the pdf skill and is NOT a declared dependency here —
        # putting a red badge on the xlsx skill for a library only the preview extras
        # need would be wrong. So the PDF is still produced and the blank-page check
        # degrades to a stated gap. But --png was asked for explicitly: quietly
        # producing no images would be the silent failure this file exists to avoid.
        if png_dir is not None:
            fail("--png needs pypdfium2 to rasterize the pages, and it is not "
                 "installed (pip install pypdfium2). The PDF itself does not need it")
        return {"pages": None, "blank_pages": None, "images": [],
                "note": "pypdfium2 is not installed, so the blank-page check did NOT "
                        "run — this PDF has not been checked for empty pages "
                        "(pip install pypdfium2)"}
    out: dict = {"images": []}
    doc = pdfium.PdfDocument(str(pdf))
    try:
        out["pages"] = len(doc)
        out["blank_pages"] = [i + 1 for i in range(len(doc))
                              if page_ink(doc[i]) < BLANK_INK]
        if png_dir is not None:
            png_dir.mkdir(parents=True, exist_ok=True)
            for i in range(len(doc)):
                img = png_dir / f"page-{i + 1:03d}.png"
                doc[i].render(scale=dpi / 72.0).to_pil().save(str(img))
                out["images"].append(str(img))
    finally:
        doc.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--sheet", help="render only this sheet")
    ap.add_argument("--png", type=Path, metavar="DIR", help="also write page images")
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--allow-blank", action="store_true",
                    help="accept a PDF whose pages carry no ink")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        if not args.src.is_file():
            fail(f"no such file: {args.src}")
        ensure_distinct(args.src, args.out)
        if not find_soffice():
            fail("LibreOffice not found. It is a required dependency of this skill — "
                 "rendering a spreadsheet means resolving column widths, page breaks "
                 "and number formats the way a spreadsheet application does, and "
                 "there is no pure-Python substitute. Install from libreoffice.org")
        if args.dpi < 36 or args.dpi > 600:
            fail(f"--dpi {args.dpi} is outside 36-600")

        blank_formulas = uncalculated(args.src)
        with tempfile.TemporaryDirectory(prefix="xlsx-pdf-") as td:
            work = Path(td)
            source = only_sheet(args.src, args.sheet, work) if args.sheet else args.src
            produced, err = convert(source, "pdf", work / "out", timeout=args.timeout)
            if produced is None:
                fail(err)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_bytes(produced.read_bytes())

        info = inspect_pdf(args.out, args.png, args.dpi)
        if info.get("blank_pages") and not args.allow_blank:
            args.out.unlink(missing_ok=True)
            fail(f"page(s) {info['blank_pages']} render with no ink at all, so nothing "
                 f"was written. An empty preview looks like lost data; pass "
                 f"--allow-blank if a blank page is genuinely expected"
                 + (f". Note {blank_formulas} formula cell(s) have no cached value — "
                    f"run xlsx_recalc.py first" if blank_formulas else ""))

        report = {"in": args.src.name, "out": args.out.name,
                  "sheet": args.sheet, "engine": "LibreOffice",
                  "hidden_sheets_not_rendered": hidden_sheets(args.src),
                  "uncalculated_formulas": blank_formulas, **info}
        if blank_formulas:
            report["warning"] = (
                f"{blank_formulas} formula cell(s) have no cached value and therefore "
                f"render EMPTY — the picture is wrong in a way the picture cannot "
                f"show. Run xlsx_recalc.py first")
        emit(report, args.report, "images")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
