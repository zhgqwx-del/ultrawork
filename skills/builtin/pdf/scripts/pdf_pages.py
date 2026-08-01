#!/usr/bin/env python3
"""P11 — merge, split, extract, rotate and delete pages.

    python3 pdf_pages.py --op merge   --in a.pdf b.pdf --out merged.pdf
    python3 pdf_pages.py --op extract --in a.pdf --pages 1,3-4 --out sub.pdf
    python3 pdf_pages.py --op delete  --in a.pdf --pages 2 --out fewer.pdf
    python3 pdf_pages.py --op rotate  --in a.pdf --pages 1 --degrees 90 --out r.pdf
    python3 pdf_pages.py --op split   --in a.pdf --out ./parts [--every 2]

Every operation writes a report (--report) naming the inputs, the pages that moved
and the page count it produced, so `office-skills-selftest.py --check` can be given
the inputs as its `baseline` and confirm nothing was silently dropped. A merge that
loses its second input produces a perfectly legal PDF; page count alone cannot tell
you it happened, which is why the report lists what went in.

Rotation is stored as /Rotate, not baked into the content — the text keeps its
original coordinates, which is what makes the change reversible.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import (compact, ensure_distinct, fail, open_pdf,  # noqa: E402
                       parse_pages, run, write_json)

OPS = ("merge", "split", "extract", "delete", "rotate")
LEGAL_ROTATIONS = (0, 90, 180, 270)


def save(doc, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out), garbage=4, deflate=True, no_new_id=True)


def op_merge(srcs: list[Path], out: Path, password: str | None) -> dict:
    import fitz

    if len(srcs) < 2:
        fail("merge needs at least two files in --in")
    merged = fitz.open()
    contributed = []
    with merged:
        for src in srcs:
            doc = open_pdf(src, password)
            with doc:
                merged.insert_pdf(doc)
                contributed.append({"file": str(src), "pages": doc.page_count})
        save(merged, out)
        pages = merged.page_count
    total = sum(c["pages"] for c in contributed)
    if pages != total:
        fail(f"merge produced {pages} pages from inputs totalling {total} — refusing "
             f"to report success on a result that lost pages")
    return {"op": "merge", "inputs": contributed, "pages": pages}


def op_extract(src: Path, spec: str | None, out: Path, password: str | None) -> dict:
    import fitz

    doc = open_pdf(src, password)
    with doc:
        wanted = parse_pages(spec, doc.page_count)
        picked = fitz.open()
        with picked:
            for i in wanted:
                picked.insert_pdf(doc, from_page=i, to_page=i)
            save(picked, out)
            pages = picked.page_count
    return {"op": "extract", "inputs": [{"file": str(src)}],
            "kept_pages": [i + 1 for i in wanted], "pages": pages}


def op_delete(src: Path, spec: str | None, out: Path, password: str | None) -> dict:
    doc = open_pdf(src, password)
    with doc:
        drop = parse_pages(spec, doc.page_count)
        if len(drop) == doc.page_count:
            fail(f"deleting {len(drop)} of {doc.page_count} page(s) would leave an "
                 f"empty document")
        doc.delete_pages(drop)
        save(doc, out)
        pages = doc.page_count
    return {"op": "delete", "inputs": [{"file": str(src)}],
            "deleted_pages": [i + 1 for i in drop], "pages": pages}


def op_rotate(src: Path, spec: str | None, degrees: int, out: Path,
              password: str | None) -> dict:
    if degrees not in LEGAL_ROTATIONS:
        fail(f"--degrees {degrees} is not one of {LEGAL_ROTATIONS}; PDF stores "
             f"/Rotate in quarter turns")
    doc = open_pdf(src, password)
    with doc:
        wanted = parse_pages(spec, doc.page_count)
        turned = []
        for i in wanted:
            page = doc[i]
            # Relative, so `--degrees 90` twice ends at 180 rather than fighting an
            # existing /Rotate the document already carried.
            before = page.rotation
            page.set_rotation((before + degrees) % 360)
            turned.append({"page": i + 1, "from": before, "to": page.rotation})
        save(doc, out)
        pages = doc.page_count
    return {"op": "rotate", "inputs": [{"file": str(src)}], "rotated": turned,
            "pages": pages}


def op_split(src: Path, out_dir: Path, every: int, password: str | None) -> dict:
    import fitz

    if every < 1:
        fail(f"--every {every} must be at least 1")
    doc = open_pdf(src, password)
    written = []
    with doc:
        out_dir.mkdir(parents=True, exist_ok=True)
        for start in range(0, doc.page_count, every):
            end = min(start + every - 1, doc.page_count - 1)
            part = fitz.open()
            with part:
                part.insert_pdf(doc, from_page=start, to_page=end)
                # Named by SOURCE page range, like pdf_render.py names by source
                # page: "part 2" and "page 2" must not be two different things.
                target = out_dir / (f"pages-{start + 1:03d}.pdf" if start == end
                                    else f"pages-{start + 1:03d}-{end + 1:03d}.pdf")
                part.save(str(target), garbage=4, deflate=True, no_new_id=True)
            written.append({"file": target.name, "from_page": start + 1,
                            "to_page": end + 1})
        total = doc.page_count
    return {"op": "split", "inputs": [{"file": str(src), "pages": total}],
            "parts": written, "pages": total}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--op", required=True, choices=list(OPS))
    ap.add_argument("--in", dest="srcs", required=True, nargs="+", type=Path)
    ap.add_argument("--out", required=True, type=Path,
                    help="output file, or output DIRECTORY for --op split")
    ap.add_argument("--pages", default=None, help="1-based, e.g. 1,3-4")
    ap.add_argument("--degrees", type=int, default=90)
    ap.add_argument("--every", type=int, default=1, help="pages per part when splitting")
    ap.add_argument("--password", default=None)
    ap.add_argument("--report", type=Path, default=None)
    args = ap.parse_args()

    if args.op != "merge" and len(args.srcs) != 1:
        fail(f"--op {args.op} takes exactly one file in --in, got {len(args.srcs)}")
    src = args.srcs[0]
    for one in args.srcs:
        ensure_distinct(one, args.out)
    if args.op == "merge":
        report = op_merge(args.srcs, args.out, args.password)
    elif args.op == "extract":
        report = op_extract(src, args.pages, args.out, args.password)
    elif args.op == "delete":
        report = op_delete(src, args.pages, args.out, args.password)
    elif args.op == "rotate":
        report = op_rotate(src, args.pages, args.degrees, args.out, args.password)
    else:
        report = op_split(src, args.out, args.every, args.password)
    report["out"] = str(args.out)

    if args.report:
        write_json(args.report, report)
    stdout = report
    for key in ("parts", "rotated", "kept_pages", "deleted_pages"):
        stdout = compact(stdout, key, args.report)
    print(json.dumps(stdout, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(run(main))
