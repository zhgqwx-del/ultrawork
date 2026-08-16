#!/usr/bin/env python3
"""P11 — merge, split, extract, rotate and delete pages.

    python3 pdf_pages.py --op merge   --in a.pdf b.pdf --out merged.pdf
    python3 pdf_pages.py --op extract --in a.pdf --pages 1,3-4 --out sub.pdf
    python3 pdf_pages.py --op delete  --in a.pdf --pages 2 --out fewer.pdf
    python3 pdf_pages.py --op rotate  --in a.pdf --pages 1 --degrees 90 --out r.pdf
    python3 pdf_pages.py --op split   --in a.pdf --out ./parts [--every 2]
    python3 pdf_pages.py --op flatten --in filled.pdf --out flat.pdf

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

OPS = ("merge", "split", "extract", "delete", "rotate", "flatten")
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


def appearance_for(annot) -> object | None:
    """The appearance stream a viewer would actually paint for this widget.

    `/AP /N` is either a stream, or a dictionary of states keyed by on-state name
    (checkbox, radio) from which `/AS` selects. Taking the dictionary itself, or the
    wrong branch of it, is how a ticked box flattens into an empty one.
    """
    ap = annot.get("/AP")
    normal = ap.get_object().get("/N") if ap is not None else None
    normal = normal.get_object() if normal is not None else None
    if normal is None:
        return None
    if hasattr(normal, "get_data"):
        return normal
    state = annot.get("/AS")
    if state is not None and state in normal:
        return normal[state].get_object()
    return None


def appearance_matrix(rect, bbox, matrix) -> tuple[float, ...]:
    """Map an appearance's /BBox, through its /Matrix, onto the annotation /Rect.

    PDF 12.5.5: transform the BBox by /Matrix, take the bounding box of the result,
    and compute the matrix that maps THAT onto /Rect. `Do` applies the form's own
    /Matrix again, so what gets written as `cm` is this mapping alone — writing the
    product would apply /Matrix twice, which is invisible for the identity matrix
    every form filler writes and wrong for every rotated field.
    """
    a, b, c, d, e, f = [float(v) for v in matrix]
    xs, ys = [], []
    for x, y in ((bbox[0], bbox[1]), (bbox[2], bbox[1]),
                 (bbox[2], bbox[3]), (bbox[0], bbox[3])):
        x, y = float(x), float(y)
        xs.append(a * x + c * y + e)
        ys.append(b * x + d * y + f)
    tx0, tx1, ty0, ty1 = min(xs), max(xs), min(ys), max(ys)
    rx0, rx1 = sorted((float(rect[0]), float(rect[2])))
    ry0, ry1 = sorted((float(rect[1]), float(rect[3])))
    sx = (rx1 - rx0) / (tx1 - tx0) if tx1 > tx0 else 1.0
    sy = (ry1 - ry0) / (ty1 - ty0) if ty1 > ty0 else 1.0
    return (sx, 0.0, 0.0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy)


def field_value(annot):
    """A widget's effective /V, walking up to the parent field that holds it."""
    node, guard = annot, 0
    while node is not None and guard < 32:
        if node.get("/V") is not None:
            return node.get("/V")
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
        guard += 1
    return None


def op_flatten(src: Path, out: Path, password: str | None) -> dict:
    """Paint every widget's appearance into the page and stop being a form.

    Why this exists: `carry_acroform` refuses to merge two form documents and tells
    the caller to flatten first. A refusal that prescribes a remedy the skill does
    not provide is an invitation to hand-roll one, and hand-rolled flattening is the
    kind of job that half-works in silence — measured on 2026-08-15, where a model
    asked to do exactly this produced a file whose five `/__flat_ Do` calls all
    pointed at bare dictionaries with no stream body: every `Do` a no-op, both pages
    rendering identically, and the report saying it had verified by rendering.

    So this refuses rather than half-works, and checks the OUTPUT before reporting
    success: a widget carrying a value whose appearance cannot be drawn is a value
    about to disappear, and the caller is told instead of being handed a blank.
    """
    from pypdf import PdfWriter
    from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject,
                               NameObject)

    reader = open_reader(src, password)
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)

    drawn, blanks, kept, painted = 0, [], 0, []
    for pno, page in enumerate(writer.pages, 1):
        annots = list(page.get("/Annots") or [])
        if not annots:
            continue
        resources = page.get("/Resources")
        resources = resources.get_object() if resources is not None else None
        if resources is None:
            resources = DictionaryObject()
            page[NameObject("/Resources")] = writer._add_object(resources)
        xobjects = resources.get("/XObject")
        xobjects = xobjects.get_object() if xobjects is not None else None
        if xobjects is None:
            xobjects = DictionaryObject()
            resources[NameObject("/XObject")] = writer._add_object(xobjects)

        ops, survivors = [], []
        for ref in annots:
            annot = ref.get_object()
            if annot.get("/Subtype") != "/Widget":
                survivors.append(ref)       # links, notes: not ours to remove
                kept += 1
                continue
            stream = appearance_for(annot)
            value = field_value(annot)
            if stream is None or not stream.get_data():
                # An /Off checkbox draws nothing and that is correct. A field with a
                # VALUE and nothing to draw is the defect this whole op exists for.
                if value is not None and str(value) not in ("/Off", ""):
                    fail(f"page {pno}: field {str(annot.get('/T'))!r} holds "
                         f"{str(value)[:40]!r} but its appearance stream is empty — "
                         f"flattening it would delete the value. Fill the form with "
                         f"pdf_form_fill.py (which writes appearances) and retry.")
                blanks.append(str(annot.get("/T")))
                continue
            # Unique against what is ALREADY in this page's resources, not just
            # against this run. Re-flattening a document that has been flattened
            # before restarts the numbering at 0, and `/uwflat0` would then overwrite
            # the appearance the first pass painted — content lost with no error.
            name = NameObject(_free_name(xobjects))
            xobjects[name] = _stream_ref(annot)
            painted.append(str(name))
            mtx = appearance_matrix(annot["/Rect"], stream.get("/BBox", [0, 0, 1, 1]),
                                    stream.get("/Matrix", [1, 0, 0, 1, 0, 0]))
            ops.append("q {:.6f} {:.6f} {:.6f} {:.6f} {:.6f} {:.6f} cm {} Do Q"
                       .format(*mtx, name))
            drawn += 1

        if not ops:
            page[NameObject("/Annots")] = ArrayObject(survivors)
            continue
        # The page's own content is wrapped in q/Q first: if it ends with the graphics
        # state unbalanced (a stray `q`), everything appended after it inherits that
        # CTM and lands somewhere else entirely.
        before = DecodedStreamObject()
        before.set_data(b"q\n")
        after = DecodedStreamObject()
        after.set_data(("Q\n" + "\n".join(ops) + "\n").encode("latin-1"))
        current = page.get("/Contents")
        current = current.get_object() if current is not None else None
        existing = list(current) if isinstance(current, ArrayObject) else \
            ([page.raw_get("/Contents")] if current is not None else [])
        page[NameObject("/Contents")] = ArrayObject(
            [writer._add_object(before), *existing, writer._add_object(after)])
        page[NameObject("/Annots")] = ArrayObject(survivors)

    note = save(writer, out, [(src, reader)])
    verified = verify_flat(out, painted)
    return {"op": "flatten", "inputs": [{"file": str(src), "pages": len(reader.pages)}],
            "pages": len(writer.pages), "flattened": drawn,
            "annotations_kept": kept, "no_appearance": blanks,
            "acroform": note, "verified": verified}


def _stream_ref(annot):
    """The appearance as an INDIRECT reference to the stream itself.

    Deliberately the object, not a copy of its dictionary: a `/Subtype /Form` entry
    with a /BBox and no stream body is legal, silent, and paints nothing — which is
    precisely the file this op was written after.
    """
    ap = annot.raw_get("/AP").get_object()
    normal = ap.raw_get("/N")
    target = normal.get_object()
    if hasattr(target, "get_data"):
        return normal
    return target.raw_get(annot["/AS"])


def _free_name(xobjects) -> str:
    """A /uwflatN this page is not already using."""
    n = 0
    while f"/uwflat{n}" in xobjects:
        n += 1
    return f"/uwflat{n}"


def verify_flat(out: Path, painted: list[str]) -> dict:
    """Re-open and confirm the file really stopped being a form AND really draws.

    Structural, not rendered, but it catches the exact shape that got past a model
    claiming it had rendered: every XObject this op registered must be a stream with
    bytes in it, and there must be one `Do` per widget flattened.
    """
    import re

    from pypdf import PdfReader
    from pypdf.generic import ArrayObject

    reader = PdfReader(str(out))
    widgets = sum(1 for page in reader.pages for ref in (page.get("/Annots") or [])
                  if ref.get_object().get("/Subtype") == "/Widget")
    # Only the names THIS run wrote. A document flattened twice already carries the
    # first pass's XObjects and its draw calls; counting those made re-running the
    # op — which should be a no-op — fail with "5 draw calls for 0 widgets".
    wanted, empty, calls = set(painted), [], 0
    for page in reader.pages:
        res = page.get("/Resources")
        res = res.get_object() if res is not None else {}
        xo = res.get("/XObject")
        xo = xo.get_object() if xo is not None else {}
        for name in xo:
            if str(name) not in wanted:
                continue
            obj = xo[name].get_object()
            if not hasattr(obj, "get_data") or not obj.get_data():
                empty.append(str(name))
        contents = page.get("/Contents")
        contents = contents.get_object() if contents is not None else None
        parts = list(contents) if isinstance(contents, ArrayObject) else \
            ([contents] if contents is not None else [])
        blob = b"".join(p.get_object().get_data() for p in parts)
        calls += sum(len(re.findall(name.encode() + rb"\s+Do", blob))
                     for name in wanted)
    if widgets:
        fail(f"{widgets} widget annotation(s) survived the flatten — the file is "
             f"still a form and the values are still living in the annotations")
    if empty:
        fail(f"{len(empty)} flattened appearance(s) carry no stream data ({empty[:4]}) "
             f"— they would draw nothing at all, which is how flattening deletes a "
             f"form in silence")
    if calls != len(painted):
        fail(f"{calls} draw call(s) in the page content for {len(painted)} flattened "
             f"widget(s) — registering the appearance without painting it leaves a "
             f"file that looks right in the structure and blank on the page")
    return {"widgets_left": 0, "draw_calls": calls, "empty_appearances": 0}


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
    elif args.op == "flatten":
        report = op_flatten(src, args.out, args.password)
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
