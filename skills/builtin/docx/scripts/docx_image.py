#!/usr/bin/env python3
"""W11 — insert and replace pictures.

A picture in a Word document is **four package pieces and two numbers**, and the
numbers are the part that goes wrong silently:

    word/media/image1.png            the bytes
    <Default Extension="png">        what a .png IS — a package-wide declaration,
                                     not an Override, and a document that has never
                                     held a PNG does not have one
    a Relationship                   from word/document.xml, whose Id the drawing
                                     names in `r:embed`
    <w:drawing><wp:inline>           where it sits in the text

    <wp:extent cx cy>                the size Word lays out
    <a:ext cx cy>                    the size the picture is stretched to INSIDE it

Both sizes are in **EMU** — English Metric Units, 914400 to the inch — and none of
the tools involved will complain about a wrong one. Fill the extent with a pixel
count and the picture is a quarter of a millimetre wide; fill it with centimetres and
it is forty times the page. Let the two numbers disagree and Word lays out a box of
one size with a picture of another stretched into it, which reads as "the export is
blurry" rather than as a bug. `office/media.py` does the conversion, from the
picture's OWN declared density where it has one (`pHYs` / JFIF) rather than from the
web's 96 dpi assumption — 240 pixels is 2.5 inches at 96 dpi and 1.6 at 150.

    python3 docx_image.py --in a.docx --list
    python3 docx_image.py --in a.docx --out b.docx --insert chart.png \\
            --after "营业收入同比增长" --width-cm 8 --alt "季度收入趋势图"
    python3 docx_image.py --in a.docx --out b.docx --replace 0 --with new.png
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office.media import EMU_PER_CM, MediaError, Picture  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import local, q  # noqa: E402

OOXML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
IMAGE_REL = OOXML + "/image"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"


def wp(tag: str) -> str:
    return f"{{{WP}}}{tag}"


def a(tag: str) -> str:
    return f"{{{A}}}{tag}"


def pic(tag: str) -> str:
    return f"{{{PIC}}}{tag}"


def next_doc_pr_id(root) -> int:
    """`wp:docPr/@id` is unique per document; a duplicate is a repair prompt."""
    used = [int(el.get("id")) for el in root.iter(wp("docPr"))
            if (el.get("id") or "").isdigit()]
    used += [int(el.get("id")) for el in root.iter(wp("anchor"))
             if (el.get("id") or "").isdigit()]
    return max(used, default=0) + 1


def build_drawing(rid: str, cx: int, cy: int, doc_pr_id: int, name: str,
                  alt: str) -> object:
    """A `<w:drawing>` holding one inline picture, sized in EMU.

    `wp:extent` and `a:ext` are written from the same pair of numbers on purpose:
    they are two statements of one size, and a version of this that computed them
    separately would produce documents that render differently in Word and in
    LibreOffice for a reason no one would look for.
    """
    from lxml import etree
    drawing = etree.Element(q("drawing"))
    inline = etree.SubElement(drawing, wp("inline"),
                              distT="0", distB="0", distL="0", distR="0")
    etree.SubElement(inline, wp("extent"), cx=str(cx), cy=str(cy))
    etree.SubElement(inline, wp("effectExtent"), l="0", t="0", r="0", b="0")
    doc_pr = etree.SubElement(inline, wp("docPr"), id=str(doc_pr_id), name=name)
    if alt:
        # Not cosmetic: without a description a screen reader announces "image", and
        # the accessibility checkers every large organisation runs flag the document.
        doc_pr.set("descr", alt)
    frame = etree.SubElement(inline, wp("cNvGraphicFramePr"))
    etree.SubElement(frame, a("graphicFrameLocks")).set("noChangeAspect", "1")
    graphic = etree.SubElement(inline, a("graphic"))
    data = etree.SubElement(graphic, a("graphicData"), uri=PIC)
    picture = etree.SubElement(data, pic("pic"))
    nv = etree.SubElement(picture, pic("nvPicPr"))
    etree.SubElement(nv, pic("cNvPr"), id="0", name=name)
    etree.SubElement(nv, pic("cNvPicPr"))
    fill = etree.SubElement(picture, pic("blipFill"))
    etree.SubElement(fill, a("blip")).set(f"{{{OOXML}}}embed", rid)
    etree.SubElement(etree.SubElement(fill, a("stretch")), a("fillRect"))
    sp = etree.SubElement(picture, pic("spPr"))
    xfrm = etree.SubElement(sp, a("xfrm"))
    etree.SubElement(xfrm, a("off"), x="0", y="0")
    etree.SubElement(xfrm, a("ext"), cx=str(cx), cy=str(cy))
    etree.SubElement(etree.SubElement(sp, a("prstGeom"), prst="rect"), a("avLst"))
    return drawing


def add_media(pkg: Package, picture: Picture) -> tuple[str, str, bool]:
    """Write the bytes and make them reachable. Returns (part, rId, default_added)."""
    part = pkg.free_part_name("word/media/image{n}." + picture.extension)
    pkg.write(part, picture.path.read_bytes())
    had_default = pkg.content_type(part) is not None
    pkg.set_default(picture.extension, picture.content_type)
    rid = pkg.add_relationship(Package.rels_part_of(DOCUMENT), IMAGE_REL,
                               part.split("/", 1)[1])
    return part, rid, not had_default


def insert(pkg: Package, source: Path, *, after: str | None, width_cm: float | None,
           height_cm: float | None, alt: str) -> dict:
    try:
        picture = Picture(source)
    except MediaError as e:
        fail(str(e))
    cx, cy = picture.extent(width_cm, height_cm)
    if cx <= 0 or cy <= 0:
        fail(f"the computed size is {cx}x{cy} EMU, which is not a picture anyone "
             f"can see; check --width-cm")
    root = pkg.tree(DOCUMENT)
    body = doc.body(root)

    anchor = None
    if after:
        for paragraph in doc.iter_paragraphs(body):
            usable, _ = doc.find_occurrences(paragraph, after)
            if usable:
                # The picture goes after the whole BLOCK the phrase sits in, not
                # after the paragraph object — a phrase inside a table cell would
                # otherwise put a picture in the middle of the table's markup.
                anchor = paragraph
                while anchor is not None and anchor.getparent() is not body:
                    anchor = anchor.getparent()
                break
        if anchor is None:
            fail(f"--after {after!r} does not appear in the document body, so there "
                 f"is nowhere to put the picture. Drop --after to append it at the "
                 f"end, or check the phrase — it may be split across runs in a way "
                 f"docx_read.py --outline will show")

    part, rid, default_added = add_media(pkg, picture)
    para = doc.make_paragraph(align="center")
    holder = doc.element("r")
    holder.append(build_drawing(rid, cx, cy, next_doc_pr_id(root),
                                source.name, alt))
    para.append(holder)
    if anchor is not None:
        anchor.addnext(para)
    else:
        doc.append_block(body, para)          # keeps <w:sectPr> last
    pkg.put_tree(DOCUMENT, root)

    report = picture.describe(cx, cy)
    report.update({
        "part": part, "relationship": rid,
        "content_type_default_added": default_added,
        "alt": alt or None,
        "placed": f"in a new paragraph after {after!r}" if after
                  else "in a new paragraph at the end of the body",
        "scaled": "intrinsic size" if width_cm is None and height_cm is None
                  else "scaled, aspect ratio kept" if None in (width_cm, height_cm)
                  else "scaled to both dimensions as given",
    })
    return report


def drawings_of(root) -> list:
    return [d for d in root.iter(q("drawing"))]


def listing(pkg: Package) -> list[dict]:
    root = pkg.tree(DOCUMENT)
    rels = {r["id"]: r for r in pkg.relationships(Package.rels_part_of(DOCUMENT))}
    out = []
    for i, drawing in enumerate(drawings_of(root)):
        extent = next(iter(drawing.iter(wp("extent"))), None)
        inner = next(iter(drawing.iter(a("ext"))), None)
        blip = next(iter(drawing.iter(a("blip"))), None)
        doc_pr = next(iter(drawing.iter(wp("docPr"))), None)
        rid = blip.get(f"{{{OOXML}}}embed") if blip is not None else None
        part = rels.get(rid, {}).get("resolved")
        cx = int(extent.get("cx")) if extent is not None else None
        entry = {
            "index": i, "relationship": rid, "part": part,
            "bytes": len(pkg.read(part)) if part and pkg.has(part) else None,
            "alt": doc_pr.get("descr") if doc_pr is not None else None,
            "emu": {"cx": cx,
                    "cy": int(extent.get("cy")) if extent is not None else None},
            "cm": [round(cx / EMU_PER_CM, 2)] if cx else None,
        }
        if inner is not None and extent is not None:
            # Two numbers for one size. When they disagree Word lays out a box of
            # one size and stretches a picture of another into it, and the report
            # says so rather than leaving it to look like a bad export.
            entry["extent_matches_inner"] = (inner.get("cx") == extent.get("cx")
                                             and inner.get("cy") == extent.get("cy"))
        out.append(entry)
    return out


def replace(pkg: Package, index: int, source: Path) -> dict:
    try:
        picture = Picture(source)
    except MediaError as e:
        fail(str(e))
    root = pkg.tree(DOCUMENT)
    drawings = drawings_of(root)
    if not 0 <= index < len(drawings):
        fail(f"--replace {index}: this document has {len(drawings)} picture(s); "
             f"--list shows their indexes")
    drawing = drawings[index]
    blip = next(iter(drawing.iter(a("blip"))), None)
    if blip is None:
        fail(f"picture {index} carries no <a:blip>, so nothing points at any bytes")
    old_rid = blip.get(f"{{{OOXML}}}embed")
    rels_part = Package.rels_part_of(DOCUMENT)
    old_part = next((r["resolved"] for r in pkg.relationships(rels_part)
                     if r["id"] == old_rid), None)

    same_extension = bool(old_part) and old_part.lower().endswith(
        "." + picture.extension)
    if same_extension:
        # The cheapest correct move: the relationship and the content type already
        # say the right thing, so only the bytes change and nothing else in the
        # package is touched.
        pkg.write(old_part, picture.path.read_bytes())
        part, rid, default_added = old_part, old_rid, False
    else:
        part, rid, default_added = add_media(pkg, picture)
        blip.set(f"{{{OOXML}}}embed", rid)
        others = [d for d in drawings_of(root) if d is not drawing]
        still_used = any(b.get(f"{{{OOXML}}}embed") == old_rid
                         for d in others for b in d.iter(a("blip")))
        if old_part and not still_used:
            pkg.drop(old_part)     # bytes + Override + Relationship, all three
    pkg.put_tree(DOCUMENT, root)

    extent = next(iter(drawing.iter(wp("extent"))), None)
    cx = int(extent.get("cx")) if extent is not None else 0
    cy = int(extent.get("cy")) if extent is not None else 0
    report = picture.describe(cx, cy)
    report.update({
        "index": index, "part": part, "relationship": rid,
        "replaced_part": old_part,
        "old_part_dropped": bool(old_part and not same_extension
                                 and not pkg.has(old_part)),
        "content_type_default_added": default_added,
        # The frame is NOT resized: the caller asked to change the picture, not the
        # layout, and silently reflowing a page around a new aspect ratio is a
        # bigger change than the one that was requested.
        "size": "the existing frame is kept; the new picture is stretched into it",
        "aspect_ratio_changed": bool(cx and cy and abs(
            picture.height_px / picture.width_px - cy / cx) > 0.01),
    })
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--insert", metavar="PICTURE", type=Path)
    ap.add_argument("--after", metavar="PHRASE",
                    help="put it after the paragraph holding this text "
                         "(default: the end of the document)")
    ap.add_argument("--width-cm", type=float)
    ap.add_argument("--height-cm", type=float)
    ap.add_argument("--alt", default="", help="alternative text for screen readers")
    ap.add_argument("--replace", type=int, metavar="INDEX")
    ap.add_argument("--with", dest="replacement", metavar="PICTURE", type=Path)
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        pkg = open_document(args.src)
        if args.list or (args.insert is None and args.replace is None):
            if not args.list:
                fail("nothing to do: pass --insert PICTURE, --replace INDEX --with "
                     "PICTURE, or --list")
            emit({"in": args.src.name, "pictures": listing(pkg)}, args.report,
                 "pictures")
            return
        if not args.out:
            fail("pass --out FILE")
        ensure_distinct(args.src, args.out)
        if args.replace is not None and args.replacement is None:
            fail("--replace INDEX needs --with PICTURE")
        for value, flag in ((args.width_cm, "--width-cm"),
                            (args.height_cm, "--height-cm")):
            if value is not None and value <= 0:
                fail(f"{flag} must be positive; got {value}")
        pre_existing = check_package(pkg)
        before = dict(pkg.parts)
        report: dict = {"in": args.src.name, "out": str(args.out)}
        if args.insert is not None:
            report["inserted"] = insert(pkg, args.insert, after=args.after,
                                        width_cm=args.width_cm,
                                        height_cm=args.height_cm, alt=args.alt)
        if args.replace is not None:
            report["replaced"] = replace(pkg, args.replace, args.replacement)
        report["pre_existing_package_findings"] = save_checked(pkg, args.out,
                                                              pre_existing)
        report["pictures"] = listing(pkg)
        report["parts_changed"] = sorted(n for n in pkg.parts
                                         if before.get(n) != pkg.parts[n])
        report["parts_byte_identical"] = sum(1 for n in before
                                             if pkg.parts.get(n) == before[n])
        emit(report, args.report, "pictures", "parts_changed")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
