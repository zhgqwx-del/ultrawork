#!/usr/bin/env python3
"""W9 — create, replace and remove headers and footers.

A header is **four things**, and the first-page and even-page variants are **five**:

    word/header2.xml                 the header's own part
    an [Content_Types].xml Override  what that part IS
    a Relationship                   from word/document.xml to it
    <w:headerReference> in w:sectPr  which section uses it, and for which pages
    ── and then, for the variants ──
    <w:titlePg/> in the same w:sectPr        or the `first` header is IGNORED
    <w:evenAndOddHeaders/> in word/settings.xml   or the `even` header is IGNORED

That last line is the one that costs an afternoon. Write the part, the content type,
the relationship and a `w:headerReference w:type="first"` — all four correct, all
four validated by every schema — and Word shows the ordinary header on page one.
Nothing is malformed; the document simply never asked for a different first page.
The switch for even pages is worse still, because it does not live in the section at
all: it is a document-wide setting, in a different part.

Removing one is the same in reverse, and dropping the last reference to a part means
dropping the part — which is itself three things (bytes, Override, Relationship);
`office/package.py` does that symmetrically. Removing a `first` header also removes
`w:titlePg`, because leaving it behind means page one now has NO header at all — a
change the caller did not ask for and would not see until it printed.

    python3 docx_header.py --in a.docx --list
    python3 docx_header.py --in a.docx --out b.docx \\
            --header "示例科技有限公司" --footer "内部资料" --page-number
    python3 docx_header.py --in a.docx --out b.docx --type first --header ""
    python3 docx_header.py --in a.docx --out b.docx --type even --remove header
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import MAIN_NS, insert_ordered, local, q  # noqa: E402

SETTINGS = "word/settings.xml"
OOXML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WML = "application/vnd.openxmlformats-officedocument.wordprocessingml."

KINDS = {
    "header": {"root": "hdr", "part": "word/header{n}.xml", "ref": "headerReference",
               "type": WML + "header+xml", "rel": OOXML + "/header"},
    "footer": {"root": "ftr", "part": "word/footer{n}.xml", "ref": "footerReference",
               "type": WML + "footer+xml", "rel": OOXML + "/footer"},
}

# What each variant needs BESIDES the four pieces, and where that switch lives.
ACTIVATION = {
    "default": None,
    "first": ("titlePg", "w:sectPr"),
    "even": ("evenAndOddHeaders", SETTINGS),
}


def reference_of(sect, kind: str, page_type: str):
    ref = KINDS[kind]["ref"]
    for el in sect:
        if local(el.tag) == ref and (el.get(q("type")) or "default") == page_type:
            return el
    return None


def part_behind(pkg: Package, ref) -> str | None:
    rid = ref.get(f"{{{OOXML}}}id")
    rels = pkg.relationships(Package.rels_part_of(DOCUMENT))
    return next((r["resolved"] for r in rels if r["id"] == rid), None)


def build_part(kind: str, text: str, *, page_number: bool, align: str) -> bytes:
    """The header/footer part itself: one paragraph, and a PAGE field if asked."""
    from lxml import etree
    root = etree.Element(q(KINDS[kind]["root"]), nsmap={"w": MAIN_NS})
    para = doc.make_paragraph(align=align)
    if text:
        para.append(doc.make_run(text))
    if page_number:
        if text:
            para.append(doc.make_run("    "))
        para.append(doc.make_run("第 "))
        # No cached result: the page number of a document nothing has laid out is
        # not knowable here, and writing "1" is how every page ends up saying 1.
        for node in doc.make_field(" PAGE ", None):
            para.append(node)
        para.append(doc.make_run(" 页"))
    root.append(para)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def ensure_settings_flag(pkg: Package, tag: str) -> str | None:
    """Turn on a document-wide switch in word/settings.xml. Returns what it did.

    A document with no settings part is legal and rare; creating one is the same
    three pieces as any other part, so it is done here rather than refused.
    """
    from lxml import etree
    created = None
    if pkg.has(SETTINGS):
        root = pkg.tree(SETTINGS)
    else:
        root = etree.Element(q("settings"), nsmap={"w": MAIN_NS})
        pkg.set_override(SETTINGS, WML + "settings+xml")
        pkg.add_relationship(Package.rels_part_of(DOCUMENT), OOXML + "/settings",
                             "settings.xml")
        created = "created word/settings.xml with its Override and relationship"
    if root.find(q(tag)) is None:
        insert_ordered(root, doc.element(tag))
        pkg.put_tree(SETTINGS, root)
        return created or f"set <w:{tag}/> in {SETTINGS}"
    pkg.put_tree(SETTINGS, root)
    return created


def write_one(pkg: Package, kind: str, text: str, page_type: str, *,
              page_number: bool, align: str) -> dict:
    spec = KINDS[kind]
    root = pkg.tree(DOCUMENT)
    sect = doc.body_sect_pr(root, create=True)
    existing = reference_of(sect, kind, page_type)
    pieces: list[str] = []
    data = build_part(kind, text, page_number=page_number, align=align)

    if existing is not None and part_behind(pkg, existing):
        part = part_behind(pkg, existing)
        pkg.write(part, data)
        action = "replaced"
        pieces.append("part contents")
    else:
        part = pkg.free_part_name(spec["part"])
        pkg.write(part, data)
        pieces.append("part")
        pkg.set_override(part, spec["type"])
        pieces.append("content-type Override")
        rid = pkg.add_relationship(Package.rels_part_of(DOCUMENT), spec["rel"],
                                   part.split("/", 1)[1])
        pieces.append("relationship")
        ref = doc.element(spec["ref"], type=page_type)
        ref.set(f"{{{OOXML}}}id", rid)
        insert_ordered(sect, ref)
        pieces.append(f"w:sectPr <w:{spec['ref']} w:type=\"{page_type}\">")
        action = "created"

    activation = ACTIVATION[page_type]
    activated = None
    if activation:
        tag, where = activation
        if where == SETTINGS:
            note = ensure_settings_flag(pkg, tag)
            activated = f"<w:{tag}/> in {SETTINGS}"
            if note:
                pieces.append(note)
        else:
            if sect.find(q(tag)) is None:
                insert_ordered(sect, doc.element(tag))
                pieces.append(f"<w:{tag}/> in w:sectPr")
            activated = f"<w:{tag}/> in w:sectPr"
    pkg.put_tree(DOCUMENT, root)
    return {"kind": kind, "type": page_type, "part": part, "action": action,
            "pieces": pieces,
            # Named even when it was already there: "this is what makes the variant
            # take effect" is the fact worth carrying, not "I happened to write it".
            "activated_by": activated,
            "page_number_field": page_number}


def remove_one(pkg: Package, kind: str, page_type: str) -> dict:
    spec = KINDS[kind]
    root = pkg.tree(DOCUMENT)
    sect = doc.body_sect_pr(root)
    if sect is None:
        fail("this document has no <w:sectPr>, so nothing is bound to a header")
    ref = reference_of(sect, kind, page_type)
    if ref is None:
        fail(f"this document has no {page_type} {kind} to remove; "
             f"--list shows what it does have")
    part = part_behind(pkg, ref)
    sect.remove(ref)
    pkg.put_tree(DOCUMENT, root)

    # Two references can point at ONE part — the same letterhead on odd and even
    # pages is the ordinary way to write that — so the part goes only when nothing
    # is left pointing at it.
    still_used = [el for el in sect
                  if local(el.tag) in ("headerReference", "footerReference")
                  and part_behind(pkg, el) == part]
    dropped = False
    if part and not still_used:
        pkg.drop(part)          # bytes + Override + every Relationship, all three
        dropped = True

    # Leaving w:titlePg behind after removing the first-page header does not restore
    # the ordinary header on page one — it leaves page one with NO header, which is a
    # change nobody asked for and nobody sees until it prints.
    title_off = False
    if page_type == "first" and not any(
            (el.get(q("type")) or "default") == "first"
            for el in sect if local(el.tag) in ("headerReference", "footerReference")):
        node = sect.find(q("titlePg"))
        if node is not None:
            sect.remove(node)
            title_off = True
            pkg.put_tree(DOCUMENT, root)
    return {"kind": kind, "type": page_type, "part": part, "part_dropped": dropped,
            "title_page_switched_off": title_off}


def listing(pkg: Package) -> dict:
    root = pkg.tree(DOCUMENT)
    sect = doc.body_sect_pr(root)
    out: dict = {"headers": [], "footers": [], "title_page": False,
                 "even_and_odd_headers": False}
    if sect is not None:
        for el in sect:
            name = local(el.tag)
            if name in ("headerReference", "footerReference"):
                out["headers" if name == "headerReference" else "footers"].append({
                    "type": el.get(q("type")) or "default",
                    "part": part_behind(pkg, el),
                })
        out["title_page"] = sect.find(q("titlePg")) is not None
    if pkg.has(SETTINGS):
        out["even_and_odd_headers"] = \
            pkg.tree(SETTINGS).find(q("evenAndOddHeaders")) is not None
    # The two switches are reported next to the parts on purpose: a first-page header
    # with title_page false is a part that exists and is never shown, and that state
    # is invisible in any listing that only counts parts.
    out["notes"] = [
        f"a '{t}' {k[:-1]} is present but {why} is off, so readers ignore it"
        for k, t, flag, why in (("headers", "first", "title_page", "<w:titlePg/>"),
                                ("footers", "first", "title_page", "<w:titlePg/>"),
                                ("headers", "even", "even_and_odd_headers",
                                 "<w:evenAndOddHeaders/>"),
                                ("footers", "even", "even_and_odd_headers",
                                 "<w:evenAndOddHeaders/>"))
        if any(e["type"] == t for e in out[k]) and not out[flag]
    ]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--header", metavar="TEXT",
                    help="create or replace the header for --type")
    ap.add_argument("--footer", metavar="TEXT",
                    help="create or replace the footer for --type")
    ap.add_argument("--type", default="default", choices=sorted(ACTIVATION),
                    help="which pages this applies to (default: every page)")
    ap.add_argument("--page-number", action="store_true",
                    help="add a { PAGE } field; the number is left for the reader "
                         "to compute rather than cached as a literal")
    ap.add_argument("--align", default="center", choices=("left", "center", "right"))
    ap.add_argument("--remove", action="append", default=[], choices=("header", "footer"),
                    help="remove the --type header/footer and, if nothing else uses "
                         "it, its part")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        pkg = open_document(args.src)
        if args.list or not (args.header is not None or args.footer is not None
                             or args.remove):
            if not args.list:
                fail("nothing to do: pass --header TEXT, --footer TEXT, "
                     "--remove header|footer, or --list")
            emit({"in": args.src.name, **listing(pkg)}, args.report, "notes")
            return
        if not args.out:
            fail("pass --out FILE")
        ensure_distinct(args.src, args.out)
        if args.page_number and args.header is None and args.footer is None:
            fail("--page-number has nothing to go in: pass --header TEXT or "
                 "--footer TEXT as well")
        pre_existing = check_package(pkg)
        before = dict(pkg.parts)
        report: dict = {"in": args.src.name, "out": str(args.out),
                        "type": args.type, "written": [], "removed": []}
        for kind, text in (("header", args.header), ("footer", args.footer)):
            if text is None:
                continue
            report["written"].append(
                write_one(pkg, kind, text, args.type,
                          # A page number belongs where a reader looks for one. Put
                          # it in the footer when both are being written, so
                          # `--page-number` on a two-part call is not ambiguous.
                          page_number=args.page_number and (
                              kind == "footer" or args.footer is None),
                          align=args.align))
        for kind in args.remove:
            report["removed"].append(remove_one(pkg, kind, args.type))
        report["pre_existing_package_findings"] = save_checked(pkg, args.out,
                                                              pre_existing)
        report.update({k: v for k, v in listing(pkg).items() if k != "notes"})
        report["notes"] = listing(pkg)["notes"]
        report["parts_changed"] = sorted(n for n in pkg.parts
                                         if before.get(n) != pkg.parts[n])
        report["parts_byte_identical"] = sum(1 for n in before
                                             if pkg.parts.get(n) == before[n])
        emit(report, args.report, "written", "removed", "notes", "parts_changed")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
