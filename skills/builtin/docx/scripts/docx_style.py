#!/usr/bin/env python3
"""W12 — read, create, modify and remove the styles in word/styles.xml.

**A style is not a local edit.** Every paragraph that names it repaints the moment it
changes, and the request that asked for the change usually mentioned one paragraph.
So modifying a style that already exists needs `--overwrite`, and the report always
says how many paragraphs and runs the change reached — a number the caller can
recognise as wrong before the document goes out.

Three more things this refuses to do quietly:

  * **Delete a style something still uses.** Word does not complain; the paragraphs
    fall back to Normal and the document silently loses its headings. `--delete`
    refuses unless nothing uses it, or `--reassign` says where those paragraphs go.
  * **Create a `w:basedOn` cycle.** Word stops resolving formatting at the loop and
    renders the style as Normal — no error, no repair prompt, just a document that
    ignores half of what styles.xml says.
  * **Write a style whose Chinese has no `w:eastAsia`.** Same rule every run this
    skill writes obeys, for the same reason: without it the reader's theme picks the
    CJK face (gotchas §21.2 ㊲).

The `w:style` child order is `CT_Style`'s (§17.7.4.17) and comes from
`office/xmlorder.py`, so a style written here cannot be the thing that makes Word
offer to repair the file.

    python3 docx_style.py --in a.docx --list
    python3 docx_style.py --in a.docx --out b.docx --set 正文小字 \\
            --name "Body Small" --based-on Normal --size 9 --east-asia 宋体
    python3 docx_style.py --in a.docx --out b.docx --set Heading1 --overwrite --color 1F5CA8
    python3 docx_style.py --in a.docx --out b.docx --delete 旧标题 --reassign Heading2
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office import styles as sty  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import insert_ordered, q  # noqa: E402

STYLES = "word/styles.xml"
KINDS = ("paragraph", "character", "table", "numbering")

# Properties that live in <w:rPr> vs <w:pPr>, in the order CT_RPr / CT_PPr want them.
# Kept as data so adding one cannot get the order wrong by hand.
RUN_PROPS = ("rFonts", "b", "bCs", "i", "iCs", "color", "sz", "szCs", "u")
PARA_PROPS = ("keepNext", "numPr", "spacing", "ind", "jc", "outlineLvl")


def styles_root_of(pkg: Package):
    if not pkg.has(STYLES):
        fail("this document has no word/styles.xml — every Word document has one, "
             "so this package is either not a document or is already damaged")
    return pkg.tree(STYLES)


def build_rpr(args) -> object | None:
    """`<w:rPr>` for the run properties given, in schema order, or None."""
    from lxml import etree
    wanted = {}
    if args.font or args.east_asia:
        ascii_font = args.font or args.east_asia
        east = args.east_asia or args.font
        # Both faces, always. Setting only one is the defect D6 exists to catch, and
        # a STYLE that sets only one spreads it to every run that uses the style.
        wanted["rFonts"] = {"ascii": ascii_font, "hAnsi": ascii_font,
                            "eastAsia": east, "cs": ascii_font}
    if args.bold:
        wanted["b"] = {}
        wanted["bCs"] = {}
    if args.italic:
        wanted["i"] = {}
        wanted["iCs"] = {}
    if args.color:
        wanted["color"] = {"val": args.color.lstrip("#").upper()}
    if args.size is not None:
        half = str(int(round(args.size * 2)))       # w:sz is in HALF-points
        wanted["sz"] = {"val": half}
        wanted["szCs"] = {"val": half}
    if args.underline:
        wanted["u"] = {"val": "single"}
    if not wanted:
        return None
    rpr = etree.Element(q("rPr"))
    for tag in RUN_PROPS:
        if tag in wanted:
            insert_ordered(rpr, doc.element(tag, **wanted[tag]))
    return rpr


def build_ppr(args) -> object | None:
    from lxml import etree
    wanted = {}
    if args.align:
        wanted["jc"] = {"val": args.align}
    spacing = {}
    if args.space_before is not None:
        spacing["before"] = str(args.space_before)
    if args.space_after is not None:
        spacing["after"] = str(args.space_after)
    if spacing:
        wanted["spacing"] = spacing
    if args.indent_left is not None:
        wanted["ind"] = {"left": str(args.indent_left)}
    if args.outline_level is not None:
        wanted["outlineLvl"] = {"val": str(args.outline_level)}
    if args.keep_next:
        wanted["keepNext"] = {}
    if not wanted:
        return None
    ppr = etree.Element(q("pPr"))
    for tag in PARA_PROPS:
        if tag in wanted:
            insert_ordered(ppr, doc.element(tag, **wanted[tag]))
    return ppr


def upsert(pkg: Package, args) -> dict:
    from lxml import etree
    root = styles_root_of(pkg)
    body = pkg.tree(DOCUMENT)
    index = sty.style_index(root)
    style_id = args.set
    existing = index.get(style_id)
    users = sty.users_of(body, style_id)

    if existing is not None and not args.overwrite:
        fail(f"style {style_id!r} already exists and {users} paragraph(s)/run(s) use "
             f"it. Changing a style repaints every one of them, which is a wider "
             f"edit than creating a new one — pass --overwrite if that is what you "
             f"mean, or pick a new style id")
    if args.based_on and args.based_on not in index and args.based_on != style_id:
        fail(f"--based-on {args.based_on!r} is not a style in this document; "
             f"--list shows what is")

    style = existing
    created = style is None
    if created:
        style = etree.SubElement(root, q("style"))
        style.set(q("type"), args.type)
        style.set(q("styleId"), style_id)
        # Marks it as the author's rather than one of Word's built-ins; Word groups
        # and offers custom styles differently, and mislabelling one hides it.
        style.set(q("customStyle"), "1")
    elif args.type and style.get(q("type")) != args.type:
        fail(f"style {style_id!r} is a {style.get(q('type'))!r} style; a style's type "
             f"cannot be changed in place because every element that uses it expects "
             f"the old kind")

    def replace_child(tag: str, node) -> None:
        old = style.find(q(tag))
        if old is not None:
            style.remove(old)
        if node is not None:
            insert_ordered(style, node)

    if args.name or created:
        replace_child("name", doc.element("name", val=args.name or style_id))
    if args.based_on:
        replace_child("basedOn", doc.element("basedOn", val=args.based_on))
    if args.next_style:
        replace_child("next", doc.element("next", val=args.next_style))

    rpr, ppr = build_rpr(args), build_ppr(args)
    # Snapshot the names BEFORE merging. `insert_ordered` REPARENTS each child, so
    # after the loop below `rpr` and `ppr` are empty — reading them afterwards made
    # the report say "properties_set: []" on a call that had just set six of them.
    # The document was right and the report was wrong, which is the harder half to
    # notice.
    touched = sorted(str(c.tag).rsplit("}", 1)[-1]
                     for node in (rpr, ppr) if node is not None for c in node)
    # Merge rather than clobber: a caller changing only the colour of a style should
    # not lose the size it already had. Only the properties named on the command line
    # are touched.
    for tag, node in (("pPr", ppr), ("rPr", rpr)):
        if node is None:
            continue
        current = style.find(q(tag))
        if current is None:
            insert_ordered(style, node)
        else:
            # list(), not the live element: moving a child out from under lxml's
            # iterator is how a loop silently visits every other one.
            for child in list(node):
                same = current.find(q(str(child.tag).rsplit("}", 1)[-1]))
                if same is not None:
                    current.remove(same)
                insert_ordered(current, child)

    cycle = sty.based_on_cycle(sty.style_index(root), style_id)
    if cycle:
        fail(f"this would make {style_id!r} inherit from itself ({' -> '.join(cycle)}). "
             f"Word stops resolving formatting at the loop and renders the style as "
             f"Normal, with no error anywhere")
    pkg.put_tree(STYLES, root)
    return {"style": style_id, "action": "created" if created else "modified",
            "type": style.get(q("type")),
            # The number that makes an overwrite reviewable before it ships.
            "repainted": users,
            "properties_set": touched}


def remove(pkg: Package, style_id: str, reassign: str | None) -> dict:
    root = styles_root_of(pkg)
    body = pkg.tree(DOCUMENT)
    index = sty.style_index(root)
    if style_id not in index:
        fail(f"no style {style_id!r} in this document; --list shows what is there")
    users = sty.users_of(body, style_id)
    if users and not reassign:
        fail(f"{users} paragraph(s)/run(s) still use {style_id!r}. Deleting it does "
             f"not raise anything — Word falls back to Normal and the document "
             f"quietly loses that formatting. Pass --reassign STYLEID to move them, "
             f"or delete those paragraphs first")
    if reassign and reassign not in index:
        fail(f"--reassign {reassign!r} is not a style in this document")

    moved = 0
    if reassign:
        for container, prop in (("pPr", "pStyle"), ("rPr", "rStyle"),
                                ("tblPr", "tblStyle")):
            for pr in body.iter(q(container)):
                node = pr.find(q(prop))
                if node is not None and node.get(q("val")) == style_id:
                    node.set(q("val"), reassign)
                    moved += 1
        pkg.put_tree(DOCUMENT, body)

    # Anything based on the style being removed would inherit from a style that is
    # not there. Word treats that as no inheritance at all, so the children silently
    # lose whatever they were getting from it — repointed rather than left dangling.
    orphaned = []
    for other_id, other in index.items():
        based = other.find(q("basedOn"))
        if based is not None and based.get(q("val")) == style_id:
            parent = index[style_id].find(q("basedOn"))
            if parent is not None:
                based.set(q("val"), parent.get(q("val")))
            else:
                other.remove(based)
            orphaned.append(other_id)

    root.remove(index[style_id])
    pkg.put_tree(STYLES, root)
    return {"style": style_id, "reassigned_to": reassign, "reassigned": moved,
            "children_repointed": orphaned}


def listing(pkg: Package) -> list[dict]:
    root = styles_root_of(pkg)
    body = pkg.tree(DOCUMENT)
    index = sty.style_index(root)
    out = []
    for style_id, style in index.items():
        entry = sty.describe(style, index)
        entry["used_by"] = sty.users_of(body, style_id)
        cycle = sty.based_on_cycle(index, style_id)
        if cycle:
            entry["basedOn_cycle"] = cycle
        out.append(entry)
    return sorted(out, key=lambda e: (-e["used_by"], e["id"] or ""))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--set", metavar="STYLEID", help="create or modify a style")
    ap.add_argument("--overwrite", action="store_true",
                    help="allow --set to change a style that already exists")
    ap.add_argument("--delete", metavar="STYLEID")
    ap.add_argument("--reassign", metavar="STYLEID",
                    help="move everything using --delete's style to this one")
    ap.add_argument("--name")
    ap.add_argument("--type", default="paragraph", choices=KINDS)
    ap.add_argument("--based-on", metavar="STYLEID")
    ap.add_argument("--next-style", metavar="STYLEID")
    ap.add_argument("--font", metavar="FACE", help="latin face (@w:ascii)")
    ap.add_argument("--east-asia", metavar="FACE", help="CJK face (@w:eastAsia)")
    ap.add_argument("--size", type=float, metavar="PT")
    ap.add_argument("--bold", action="store_true")
    ap.add_argument("--italic", action="store_true")
    ap.add_argument("--underline", action="store_true")
    ap.add_argument("--color", metavar="RRGGBB")
    ap.add_argument("--align", choices=("left", "center", "right", "both"))
    ap.add_argument("--space-before", type=int, metavar="TWIPS")
    ap.add_argument("--space-after", type=int, metavar="TWIPS")
    ap.add_argument("--indent-left", type=int, metavar="TWIPS")
    ap.add_argument("--outline-level", type=int, metavar="N",
                    help="0-8; what makes a paragraph a heading for a TOC")
    ap.add_argument("--keep-next", action="store_true")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        pkg = open_document(args.src)
        if args.list or not (args.set or args.delete):
            if not args.list:
                fail("nothing to do: pass --set STYLEID, --delete STYLEID, or --list")
            emit({"in": args.src.name, "styles": listing(pkg)}, args.report, "styles")
            return
        if not args.out:
            fail("pass --out FILE")
        ensure_distinct(args.src, args.out)
        if args.outline_level is not None and not 0 <= args.outline_level <= 8:
            fail(f"--outline-level is 0-8 (WordprocessingML has nine outline levels); "
                 f"got {args.outline_level}")
        pre_existing = check_package(pkg)
        before = dict(pkg.parts)
        report: dict = {"in": args.src.name, "out": str(args.out)}
        if args.set:
            report["set"] = upsert(pkg, args)
        if args.delete:
            report["deleted"] = remove(pkg, args.delete, args.reassign)
        report["pre_existing_package_findings"] = save_checked(pkg, args.out,
                                                              pre_existing)
        report["styles"] = listing(pkg)
        report["parts_changed"] = sorted(n for n in pkg.parts
                                         if before.get(n) != pkg.parts[n])
        emit(report, args.report, "styles", "parts_changed")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
