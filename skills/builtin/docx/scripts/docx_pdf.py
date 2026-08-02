#!/usr/bin/env python3
"""W17 — render a document to PDF (and optionally to page images).

This is not a nicety. **A .docx cannot be previewed inside ultrawork** — the
artifact panel renders PDF and shows a binary info card for everything else — so
converting to PDF is the only way a document this skill produced becomes something
the user can actually look at without leaving the app (059 §7).

    python3 docx_pdf.py --in report.docx --out report.pdf
    python3 docx_pdf.py --in report.docx --out report.pdf --png ./pages --dpi 150

Requires LibreOffice **Writer**, which is a declared dependency of this skill. There
is no pure-Python fallback and pretending otherwise would mean inventing a layout
engine: pagination, line breaking, headers, footers and field results all have to be
resolved the way a word processor resolves them.

⚠️ Writer specifically, not just `soffice`. A host with only `libreoffice-calc`
installed has a working `soffice` binary that exits 0 on a .docx and writes no PDF —
which is why "did it produce a file" is the success test here and the exit code is
not.

Two things it refuses rather than papers over:

  * **a PDF with no ink on the first page.** LibreOffice exits 0 for an empty
    document and produces a blank page; handing that back as "your preview" is
    worse than an error, because it looks like the content is gone.
  * **tracked changes rendered as if they were the final text.** A document with
    pending revisions renders with the insertions in place and the deletions
    struck through or hidden, depending on settings that live in the FILE. The
    picture is then not the document anyone will approve, so the count is reported.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run)
from office.soffice import convert, find_soffice  # noqa: E402
from office.xmlorder import q  # noqa: E402

# Share of dark pixels below which a page counts as blank. The same number the xlsx
# skill and the repo's L2 gate use — a second, differently calibrated threshold for
# the same question is a second thing to be wrong.
BLANK_INK = 0.0005
BLANK_DPI = 100


def revision_counts(pkg) -> dict:
    root = pkg.tree(DOCUMENT)
    return {"insertions": len(list(root.iter(q("ins")))),
            "deletions": len(list(root.iter(q("del"))))}


def field_count(pkg) -> int:
    """Fields anywhere in the document or its headers and footers.

    Reported because LibreOffice does NOT recalculate them on conversion: a `{ PAGE }`
    whose cached result says "1" renders as "1" on every page. The number in the
    picture came from whatever last opened the file, which may have been nothing.
    """
    total = 0
    for name in pkg.names():
        if not (name == DOCUMENT or name.startswith(("word/header", "word/footer"))):
            continue
        if not name.endswith(".xml"):
            continue
        total += sum(1 for f in pkg.tree(name).iter(q("fldChar"))
                     if f.get(q("fldCharType")) == "begin")
    return total


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
        # putting a red badge on the docx skill for a library only the preview extras
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
        if args.dpi < 36 or args.dpi > 600:
            fail(f"--dpi {args.dpi} is outside 36-600")
        pkg = open_document(args.src)          # refuses a package that is not a .docx
        if not find_soffice():
            fail("LibreOffice not found. It is a required dependency of this skill — "
                 "laying out a document means resolving pagination, line breaking, "
                 "headers and footers the way a word processor does, and there is no "
                 "pure-Python substitute. Install from libreoffice.org, and make sure "
                 "the Writer component is included")
        revisions = revision_counts(pkg)
        fields = field_count(pkg)

        with tempfile.TemporaryDirectory(prefix="docx-pdf-") as td:
            produced, err = convert(args.src, "pdf", Path(td) / "out",
                                    timeout=args.timeout)
            if produced is None:
                fail(err + ". If LibreOffice is installed but this still fails, check "
                           "that the Writer component is present — the shared soffice "
                           "binary exits 0 on a .docx it has no filter for")
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_bytes(produced.read_bytes())

        info = inspect_pdf(args.out, args.png, args.dpi)
        if info.get("blank_pages") and not args.allow_blank:
            args.out.unlink(missing_ok=True)
            fail(f"page(s) {info['blank_pages']} render with no ink at all, so nothing "
                 f"was written. An empty preview looks like lost content; pass "
                 f"--allow-blank if a blank page is genuinely expected")

        report = {"in": args.src.name, "out": str(args.out), "engine": "LibreOffice",
                  "revisions": revisions, "fields": fields, **info}
        if revisions["insertions"] or revisions["deletions"]:
            report["warning"] = (
                f"this document has {revisions['insertions']} tracked insertion(s) and "
                f"{revisions['deletions']} deletion(s); the PDF shows one resolution of "
                f"them, not the document anyone has approved. Accept or reject the "
                f"revisions first if the PDF is the deliverable")
        if fields:
            report["fields_note"] = (
                f"{fields} field(s) (page numbers, a table of contents, cross "
                f"references) render from their CACHED result — LibreOffice does not "
                f"recalculate them on conversion, so a stale cache renders stale")
        emit(report, args.report, "images")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
