#!/usr/bin/env python3
"""P1 — render PDF pages to images at a chosen DPI and page range.

    python3 pdf_render.py --in report.pdf --out ./png
    python3 pdf_render.py --in report.pdf --out ./png --pages 1-3,7 --dpi 220

Writes <prefix>-001.png … numbered by the SOURCE page number, so page 7 is always
page-007.png no matter what else was requested — a sequential 1..n naming makes
"the third image" and "page 3" two different things the moment a range is used.

Prints a JSON summary on stdout (also written to --report when given).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import fail, open_pdf, parse_pages, run, write_json  # noqa: E402

MIN_DPI, MAX_DPI = 20, 600


def render(src: Path, out_dir: Path, pages: str | None, dpi: int, prefix: str,
           fmt: str, password: str | None) -> dict:
    import fitz

    if not MIN_DPI <= dpi <= MAX_DPI:
        fail(f"--dpi {dpi} outside the supported range {MIN_DPI}-{MAX_DPI}")
    doc = open_pdf(src, password)
    with doc:
        indices = parse_pages(pages, doc.page_count)
        out_dir.mkdir(parents=True, exist_ok=True)
        written = []
        for i in indices:
            page = doc[i]
            pix = page.get_pixmap(dpi=dpi)
            target = out_dir / f"{prefix}-{i + 1:03d}.{fmt}"
            pix.save(str(target))
            written.append({"page": i + 1, "file": target.name,
                            "pixels": [pix.width, pix.height],
                            "points": [round(page.rect.width, 2),
                                       round(page.rect.height, 2)],
                            "rotation": page.rotation})
        return {"source": str(src), "dpi": dpi, "format": fmt,
                "page_count": doc.page_count, "rendered": written}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", dest="out", required=True, type=Path,
                    help="output directory for the images")
    ap.add_argument("--pages", default=None, help="1-based, e.g. 1-3,7 (default: all)")
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--prefix", default="page")
    ap.add_argument("--format", dest="fmt", default="png", choices=["png", "jpg"])
    ap.add_argument("--password", default=None)
    ap.add_argument("--report", type=Path, default=None,
                    help="also write the JSON summary here")
    args = ap.parse_args()

    summary = render(args.src, args.out, args.pages, args.dpi, args.prefix,
                     args.fmt, args.password)
    if args.report:
        write_json(args.report, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(run(main))
