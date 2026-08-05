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
from pdfcommon import (compact, ensure_distinct, fail, open_reader,  # noqa: E402
                       parse_pages, run, write_json)

OPS = ("merge", "split", "extract", "delete", "rotate")
LEGAL_ROTATIONS = (0, 90, 180, 270)


# Keys of /AcroForm that describe the form as a whole. /Fields is deliberately NOT
# here: it is rebuilt from the pages that actually made it into the output, so an
# extracted or split part lists only the fields it really carries.
# /DR (the resource dictionary holding the form's fonts) matters more than it looks:
# a viewer that decides to rebuild an appearance stream and cannot find the font
# draws the CJK values as blanks.
ACROFORM_KEYS = ("/DR", "/DA", "/Q", "/NeedAppearances", "/SigFlags", "/XFA")


def root_fields_on(writer) -> list:
    """Root field objects for every widget that survived into `writer`, in page order.

    Built from the OUTPUT pages, not copied from the input: `add_page` clones the
    annotations, so an input /Fields array does not name the objects this document
    now contains. Widgets can hang off a parent field (one field, several widgets on
    several pages), so each one is walked up to its root and de-duplicated.
    """
    seen, roots = set(), []
    for page in writer.pages:
        for ref in page.get("/Annots") or []:
            obj = ref.get_object()
            if obj.get("/Subtype") != "/Widget":
                continue
            node, guard = obj, 0
            while node.get("/Parent") is not None and guard < 32:
                node = node["/Parent"].get_object()
                guard += 1
            key = id(node)
            if key not in seen:
                seen.add(key)
                roots.append(node.indirect_reference or ref)
    return roots


def field_names(reader) -> set[str]:
    """Fully-qualified names of the form fields in a source document."""
    from pypdf.generic import DictionaryObject

    names: set[str] = set()
    root = reader.trailer["/Root"].get("/AcroForm")
    if not isinstance(root, (dict, DictionaryObject)) and root is not None:
        root = root.get_object()
    for ref in (root or {}).get("/Fields", []):
        obj = ref.get_object()
        parts, node, guard = [], obj, 0
        while node is not None and guard < 32:
            if node.get("/T"):
                parts.insert(0, str(node["/T"]))
            parent = node.get("/Parent")
            node = parent.get_object() if parent is not None else None
            guard += 1
        if parts:
            names.add(".".join(parts))
    return names


def carry_acroform(writer, sources: list[tuple[Path, object]]) -> dict:
    """Move the catalog's /AcroForm across, and say what happened either way.

    Every op here builds a fresh PdfWriter and copies pages in. The widgets and their
    /V and /AP come along; the catalog's /AcroForm does NOT — and a form document
    without it stops being a form. Measured on `form-filled.pdf`: all five values
    still present in the file, yet PDFium (Chrome's viewer, and this skill's own
    renderer) paints an empty page, because the form env it needs is keyed off the
    catalog. Viewers that draw the /AP directly (Preview, Acrobat) still show them —
    so the damage is INVISIBLE on whichever viewer you happen to try first.

    Two form documents in one output would be a different job: two fields with the
    same fully-qualified name ARE one field to a viewer (typing in one fills the
    other), and the two /DR font dictionaries can disagree on the same name. That is
    reconciliation this skill does not do, so it refuses instead of producing a file
    where two unrelated fields silently share a value.
    """
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject

    withform = [(p, r) for p, r in sources
                if r.trailer["/Root"].get("/AcroForm") is not None]
    if not withform:
        return {"state": "none", "detail": "no input carried an /AcroForm"}
    if len(withform) > 1:
        clash = sorted(set.intersection(*[field_names(r) for _, r in withform]))
        listed = ", ".join(p.name for p, _ in withform)
        fail(f"{len(withform)} inputs carry AcroForm fields ({listed}) and merging "
             f"them needs field-name and /DR reconciliation this skill does not do"
             + (f"; these names collide and would become ONE field in a viewer: "
                f"{', '.join(clash[:8])}" if clash else "")
             + ". Flatten the forms first, or merge them one at a time.")
    src_path, reader = withform[0]
    source = reader.trailer["/Root"]["/AcroForm"].get_object()
    fields = root_fields_on(writer)
    if not fields:
        # The form's pages did not make it into this output (an extract or a split
        # part that took only the prose). An /AcroForm with no fields is noise.
        return {"state": "dropped", "from": src_path.name,
                "detail": "no widget from the form survived into this output"}
    acro = DictionaryObject()
    for key in ACROFORM_KEYS:
        if key in source:
            acro[NameObject(key)] = source.raw_get(key)
    acro[NameObject("/Fields")] = ArrayObject(fields)
    writer._root_object[NameObject("/AcroForm")] = writer._add_object(acro)
    return {"state": "carried", "from": src_path.name, "fields": len(fields),
            "keys": [k for k in ACROFORM_KEYS if k in source]}


def save(writer, out: Path, sources: list[tuple[Path, object]]) -> dict:
    """The one exit every op goes through — which is why the /AcroForm carry lives
    here and not in `op_merge`. This tree has twice shipped a guard installed on a
    path nobody walks; `save` is the path all five walk."""
    note = carry_acroform(writer, sources)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as fh:
        writer.write(fh)
    return note


def op_merge(srcs: list[Path], out: Path, password: str | None) -> dict:
    from pypdf import PdfWriter

    if len(srcs) < 2:
        fail("merge needs at least two files in --in")
    writer = PdfWriter()
    contributed, sources = [], []
    for src in srcs:
        reader = open_reader(src, password)
        for page in reader.pages:
            writer.add_page(page)
        contributed.append({"file": str(src), "pages": len(reader.pages)})
        sources.append((src, reader))
    note = save(writer, out, sources)
    pages = len(writer.pages)
    total = sum(c["pages"] for c in contributed)
    if pages != total:
        fail(f"merge produced {pages} pages from inputs totalling {total} — refusing "
             f"to report success on a result that lost pages")
    return {"op": "merge", "inputs": contributed, "pages": pages, "acroform": note}


def op_extract(src: Path, spec: str | None, out: Path, password: str | None) -> dict:
    from pypdf import PdfWriter

    reader = open_reader(src, password)
    wanted = parse_pages(spec, len(reader.pages))
    writer = PdfWriter()
    for i in wanted:
        writer.add_page(reader.pages[i])
    note = save(writer, out, [(src, reader)])
    return {"op": "extract", "inputs": [{"file": str(src)}],
            "kept_pages": [i + 1 for i in wanted], "pages": len(writer.pages),
            "acroform": note}


def op_delete(src: Path, spec: str | None, out: Path, password: str | None) -> dict:
    from pypdf import PdfWriter

    reader = open_reader(src, password)
    count = len(reader.pages)
    drop = parse_pages(spec, count)
    if len(drop) == count:
        fail(f"deleting {len(drop)} of {count} page(s) would leave an empty document")
    writer = PdfWriter()
    for i, page in enumerate(reader.pages):
        if i not in set(drop):
            writer.add_page(page)
    note = save(writer, out, [(src, reader)])
    return {"op": "delete", "inputs": [{"file": str(src)}],
            "deleted_pages": [i + 1 for i in drop], "pages": len(writer.pages),
            "acroform": note}


def op_rotate(src: Path, spec: str | None, degrees: int, out: Path,
              password: str | None) -> dict:
    from pypdf import PdfWriter

    if degrees not in LEGAL_ROTATIONS:
        fail(f"--degrees {degrees} is not one of {LEGAL_ROTATIONS}; PDF stores "
             f"/Rotate in quarter turns")
    reader = open_reader(src, password)
    wanted = set(parse_pages(spec, len(reader.pages)))
    writer = PdfWriter()
    turned = []
    for i, page in enumerate(reader.pages):
        if i in wanted:
            # Relative, so `--degrees 90` twice ends at 180 rather than fighting an
            # existing /Rotate the document already carried.
            before = int(page.rotation) % 360
            after = (before + degrees) % 360
            page.rotation = after
            turned.append({"page": i + 1, "from": before, "to": after})
        writer.add_page(page)
    note = save(writer, out, [(src, reader)])
    return {"op": "rotate", "inputs": [{"file": str(src)}], "rotated": turned,
            "pages": len(writer.pages), "acroform": note}


def op_split(src: Path, out_dir: Path, every: int, password: str | None) -> dict:
    from pypdf import PdfWriter

    if every < 1:
        fail(f"--every {every} must be at least 1")
    reader = open_reader(src, password)
    total = len(reader.pages)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for start in range(0, total, every):
        end = min(start + every - 1, total - 1)
        writer = PdfWriter()
        for i in range(start, end + 1):
            writer.add_page(reader.pages[i])
        # Named by SOURCE page range, like pdf_render.py names by source page:
        # "part 2" and "page 2" must not be two different things.
        target = out_dir / (f"pages-{start + 1:03d}.pdf" if start == end
                            else f"pages-{start + 1:03d}-{end + 1:03d}.pdf")
        note = save(writer, target, [(src, reader)])
        written.append({"file": target.name, "from_page": start + 1,
                        "to_page": end + 1, "acroform": note})
    return {"op": "split", "inputs": [{"file": str(src), "pages": total}],
            "parts": written, "pages": total,
            "acroform_parts": sum(1 for w in written
                                  if w["acroform"]["state"] == "carried")}


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
