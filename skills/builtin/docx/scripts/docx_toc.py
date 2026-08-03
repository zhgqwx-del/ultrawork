#!/usr/bin/env python3
"""W10 — a table of contents, and multi-level numbering for the headings it lists.

**A table of contents is a field, and a field's result is a cache.** Word stores the
instruction (`TOC \\o "1-3" \\h \\z \\u`) next to the last result some program
computed for it, and nothing recomputes that result on open unless the document asks.
So the tempting implementation — write the entries with page numbers — produces a
document whose contents page is authoritative-looking and wrong the moment a
paragraph is added. And the honest-looking alternative, writing the field with no
result at all, gives the reader a blank page and no way to know why.

⚠️ LibreOffice does not update fields when it converts, either (measured; the same
fact is in `docx_pdf.py`'s `fields_note`), so a PDF made from this document shows
whatever was cached here. That rules out "someone downstream will fix it".

What this writes instead:

  * the entries ARE cached — heading text, at the right level, hyperlinked to a
    bookmark, so the contents page is readable and clickable straight away;
  * the **page numbers are not**, because nothing here has laid the document out and
    a page number that was not computed is a guess. Where the number goes there is a
    placeholder that cannot be mistaken for one;
  * `w:dirty` on the field and `<w:updateFields w:val="true"/>` in settings.xml ask
    the reader to compute the real ones on open;
  * the report says all of that out loud rather than leaving it to be discovered.

The numbering half has a trap of its own: an `w:abstractNum` whose levels name
`<w:pStyle w:val="Heading1"/>` numbers **nothing** by itself. The binding is
two-way — the heading STYLE has to carry the matching `<w:numPr>` — and a document
with only the first half looks completely correct in the XML while every heading
renders unnumbered.

    python3 docx_toc.py --in a.docx --out b.docx --toc
    python3 docx_toc.py --in a.docx --out b.docx --toc --levels 2 --title 目录
    python3 docx_toc.py --in a.docx --out b.docx --outline-numbering
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, clip, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office import styles as sty  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import MAIN_NS, insert_ordered, local, q  # noqa: E402

STYLES = "word/styles.xml"
NUMBERING = "word/numbering.xml"
SETTINGS = "word/settings.xml"
OOXML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WML = "application/vnd.openxmlformats-officedocument.wordprocessingml."

# Where a page number would go if one had been computed. Deliberately not a digit
# and not blank: a digit would be a guess presented as a fact, and blank is
# indistinguishable from a tool that forgot.
PAGE_PLACEHOLDER = "—"

# Word's own naming for TOC bookmarks. Kept because readers (and Word's own "update
# field") recognise the prefix; the numbers are allocated from the document.
BOOKMARK_PREFIX = "_Toc"

# A fixed nsid: this value identifies the list across documents, and calling a clock
# or a random source for it would make every run of this script produce a different
# file for the same input.
NSID = "1A2B3C4D"


def outline_level(paragraph, index: dict) -> int | None:
    """Which heading level this paragraph is, or None if it is body text.

    Three sources, in the order Word resolves them: the paragraph's own
    `w:outlineLvl`, the same property inherited down its style's `w:basedOn` chain,
    and finally the `HeadingN` naming convention. The last one alone is not enough —
    a document whose headings use a house style called `章标题` has headings, and a
    reader that only matches on the name reports a document with no structure.
    """
    ppr = paragraph.find(q("pPr"))
    if ppr is not None:
        own = ppr.find(q("outlineLvl"))
        if own is not None and (own.get(q("val")) or "").isdigit():
            return int(own.get(q("val"))) + 1
    pstyle = ppr.find(q("pStyle")) if ppr is not None else None
    style_id = pstyle.get(q("val")) if pstyle is not None else None
    for node in sty.style_chain(index, style_id):
        spr = node.find(q("pPr"))
        lvl = spr.find(q("outlineLvl")) if spr is not None else None
        if lvl is not None and (lvl.get(q("val")) or "").isdigit():
            return int(lvl.get(q("val"))) + 1
    if style_id and style_id.startswith("Heading") and style_id[7:].isdigit():
        return int(style_id[7:])
    return None


def next_bookmark_id(root) -> int:
    used = [int(b.get(q("id"))) for b in root.iter(q("bookmarkStart"))
            if (b.get(q("id")) or "").isdigit()]
    return max(used, default=-1) + 1


def collect_headings(root, styles_root, levels: int) -> list[dict]:
    """Every heading at or above `levels`, in document order, bookmarked as we go."""
    index = sty.style_index(styles_root)
    body = doc.body(root)
    bid = next_bookmark_id(root)
    out: list[dict] = []
    existing = {b.get(q("name")) for b in root.iter(q("bookmarkStart"))}
    for paragraph in doc.iter_paragraphs(body):
        level = outline_level(paragraph, index)
        if level is None or level > levels:
            continue
        text = doc.paragraph_text(paragraph).strip()
        if not text:
            continue                       # an empty heading has nothing to list
        name = f"{BOOKMARK_PREFIX}{900000 + len(out)}"
        while name in existing:
            name += "a"
        existing.add(name)
        start = doc.element("bookmarkStart", id=bid, name=name)
        end = doc.element("bookmarkEnd", id=bid)
        ppr = paragraph.find(q("pPr"))
        if ppr is not None:
            ppr.addnext(start)             # after pPr, which must stay first
        else:
            paragraph.insert(0, start)
        paragraph.append(end)
        bid += 1
        out.append({"level": level, "text": text, "bookmark": name})
    return out


def ensure_toc_styles(styles_root, levels: int) -> list[str]:
    """TOCHeading, TOC1..TOCn and Hyperlink, if the document does not have them.

    A `w:pStyle` naming a style that does not exist is valid XML that silently
    formats as Normal: every entry flush left, no dot leaders, and nothing anywhere
    saying why the contents page looks like a list of sentences.
    """
    created = []
    # ⚠️ `<w:numId w:val="0"/>` is not decoration, and it is not "belt and braces".
    # TOCHeading is based on Heading1 (as Word's own is), so when outline numbering
    # is attached to the heading styles it is INHERITED here — and the contents page
    # takes number 1, pushing the real first chapter to 2. Measured, in a rendered
    # PDF: "1. 目录 / 2. 经营概况 / 2.1 收入分析 / 3. 风险提示". Nothing in the
    # package is invalid, every check stays green, and the document is wrong.
    # numId 0 is the value ECMA-376 §17.9.18 reserves for "remove the numbering".
    if sty.ensure_style(styles_root, "TOCHeading", name="TOC Heading",
                        based_on="Heading1", next_style="Normal", ui_priority=39,
                        ppr_xml='<w:pPr>'
                                '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/>'
                                "</w:numPr>"
                                '<w:spacing w:before="240" w:after="120"/>'
                                "</w:pPr>"):
        created.append("TOCHeading")
    for level in range(1, levels + 1):
        indent = (level - 1) * 420
        if sty.ensure_style(
                styles_root, f"TOC{level}", name=f"toc {level}", based_on="Normal",
                next_style="Normal", ui_priority=39,
                ppr_xml=f'<w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" '
                        f'w:pos="8306"/></w:tabs>'
                        f'<w:spacing w:after="0"/>'
                        f'<w:ind w:left="{indent}"/></w:pPr>'):
            created.append(f"TOC{level}")
    if sty.ensure_style(styles_root, "Hyperlink", name="Hyperlink", kind="character",
                        ui_priority=99,
                        rpr_xml='<w:rPr><w:color w:val="0563C1"/>'
                                '<w:u w:val="single"/></w:rPr>'):
        created.append("Hyperlink")
    return created


def toc_block(headings: list[dict], levels: int, title: str,
              cached: bool) -> list:
    """The paragraphs that make up the contents page, field markers included."""
    from lxml import etree
    blocks = []
    if title:
        head = doc.make_paragraph(title, style="TOCHeading", bold=True, size_pt=16)
        blocks.append(head)

    instruction = f' TOC \\o "1-{levels}" \\h \\z \\u '
    if not cached or not headings:
        holder = doc.make_paragraph(style=f"TOC{1}")
        for node in doc.make_field(instruction, None):
            holder.append(node)
        blocks.append(holder)
        return blocks

    for i, heading in enumerate(headings):
        para = doc.make_paragraph(style=f"TOC{min(heading['level'], levels)}")
        if i == 0:
            # begin / instruction / separate open the field; everything after them,
            # up to `end`, is its cached RESULT.
            for node in doc.make_field(instruction, "")[:3]:
                para.append(node)
        link = etree.SubElement(para, q("hyperlink"))
        link.set(q("anchor"), heading["bookmark"])
        link.append(doc.make_run(heading["text"], style="Hyperlink"))
        tab_run = doc.element("r")
        tab_run.append(doc.element("tab"))
        para.append(tab_run)
        para.append(doc.make_run(PAGE_PLACEHOLDER))
        if i == len(headings) - 1:
            para.append(doc.make_field(instruction, "")[-1])   # the `end` marker
        blocks.append(para)
    return blocks


def existing_toc(root) -> bool:
    return any((el.text or "").strip().upper().startswith("TOC ")
               for el in root.iter(q("instrText")))


def insert_toc(pkg: Package, levels: int, title: str, cached: bool) -> dict:
    root = pkg.tree(DOCUMENT)
    styles_root = pkg.tree(STYLES) if pkg.has(STYLES) else None
    if styles_root is None:
        fail("this document has no word/styles.xml, so a table of contents would "
             "have no styles to hang on")
    if existing_toc(root):
        # Two contents pages is not a smaller mistake than none, and the second one
        # would be the one nobody notices — it renders identically until updated.
        fail("this document already carries a TOC field. Adding a second one would "
             "produce two contents pages that look alike until a reader updates "
             "them; remove the existing one first")
    headings = collect_headings(root, styles_root, levels)
    if not headings:
        fail(f"no headings at levels 1-{levels} were found, so a table of contents "
             f"would be empty. Headings are recognised by w:outlineLvl (inherited "
             f"from the paragraph style) or by a HeadingN style id")
    created = ensure_toc_styles(styles_root, levels)
    pkg.put_tree(STYLES, styles_root)

    body = doc.body(root)
    blocks = toc_block(headings, levels, title, cached)
    first = next((el for el in body if local(el.tag) in ("p", "tbl", "sdt")), None)
    for node in blocks:
        if first is not None:
            first.addprevious(node)
        else:
            doc.append_block(body, node)
    pkg.put_tree(DOCUMENT, root)
    note = ensure_settings_flag(pkg, "updateFields", "true")

    return {
        "headings": headings,
        "instruction": f'TOC \\o "1-{levels}" \\h \\z \\u',
        "entries": len(headings) if cached else 0,
        "cached": bool(cached),
        "paragraphs_added": len(blocks),
        "styles_created": created,
        # Said in the report because it is the product decision, not an implementation
        # detail: the reader is getting a real list of headings and NOT a page number.
        "page_numbers": (
            f"not written — nothing here has laid the document out, so the entries "
            f"carry {PAGE_PLACEHOLDER!r} where a number goes rather than a guess"),
        "needs_update": True,
        "update_on_open": note or "<w:updateFields w:val=\"true\"/> already set",
        "how_to_update": "Word: select the field and press F9, or Ctrl+A then F9. "
                         "LibreOffice: Tools > Update > Fields (F9). Converting to "
                         "PDF does NOT update fields.",
    }


def ensure_settings_flag(pkg: Package, tag: str, value: str | None = None) -> str | None:
    from lxml import etree
    if pkg.has(SETTINGS):
        root = pkg.tree(SETTINGS)
    else:
        root = etree.Element(q("settings"), nsmap={"w": MAIN_NS})
        pkg.set_override(SETTINGS, WML + "settings+xml")
        pkg.add_relationship(Package.rels_part_of(DOCUMENT), OOXML + "/settings",
                             "settings.xml")
    node = root.find(q(tag))
    if node is None:
        node = doc.element(tag)
        if value is not None:
            node.set(q("val"), value)
        insert_ordered(root, node)
        pkg.put_tree(SETTINGS, root)
        return f"set <w:{tag}/> in {SETTINGS}"
    pkg.put_tree(SETTINGS, root)
    return None


def numbering_root(pkg: Package):
    from lxml import etree
    if pkg.has(NUMBERING):
        return pkg.tree(NUMBERING), False
    root = etree.Element(q("numbering"), nsmap={"w": MAIN_NS})
    pkg.set_override(NUMBERING, WML + "numbering+xml")
    pkg.add_relationship(Package.rels_part_of(DOCUMENT), OOXML + "/numbering",
                         "numbering.xml")
    return root, True


def outline_numbering(pkg: Package, levels: int) -> dict:
    """Number the heading styles 1. / 1.1 / 1.1.1, both halves of the binding."""
    from lxml import etree
    styles_root = pkg.tree(STYLES) if pkg.has(STYLES) else None
    if styles_root is None:
        fail("this document has no word/styles.xml, so there are no heading styles "
             "to number")
    index = sty.style_index(styles_root)
    targets = [f"Heading{n}" for n in range(1, levels + 1) if f"Heading{n}" in index]
    if not targets:
        fail(f"none of Heading1..Heading{levels} is defined in word/styles.xml, so "
             f"there is nothing to attach outline numbering to")

    root, part_created = numbering_root(pkg)
    used_abstract = [int(a.get(q("abstractNumId"))) for a in root.findall(q("abstractNum"))
                     if (a.get(q("abstractNumId")) or "").lstrip("-").isdigit()]
    used_num = [int(n.get(q("numId"))) for n in root.findall(q("num"))
                if (n.get(q("numId")) or "").isdigit()]
    abstract_id = max(used_abstract, default=-1) + 1
    num_id = max(used_num, default=0) + 1

    abstract = doc.element("abstractNum", abstractNumId=abstract_id)
    insert_ordered(abstract, doc.element("nsid", val=NSID))
    insert_ordered(abstract, doc.element("multiLevelType", val="multilevel"))
    written_levels = []
    for n in range(1, levels + 1):
        lvl = doc.element("lvl", ilvl=n - 1)
        insert_ordered(lvl, doc.element("start", val=1))
        insert_ordered(lvl, doc.element("numFmt", val="decimal"))
        style_id = f"Heading{n}"
        if style_id in index:
            # Half one: the level says which style it numbers.
            insert_ordered(lvl, doc.element("pStyle", val=style_id))
        text = ".".join(f"%{i}" for i in range(1, n + 1)) + ("." if n == 1 else "")
        insert_ordered(lvl, doc.element("lvlText", val=text))
        insert_ordered(lvl, doc.element("lvlJc", val="left"))
        ppr = doc.element("pPr")
        indent = doc.element("ind")
        indent.set(q("left"), str(n * 420))
        indent.set(q("hanging"), str(420))
        insert_ordered(ppr, indent)
        insert_ordered(lvl, ppr)
        insert_ordered(abstract, lvl)
        written_levels.append({"ilvl": n - 1, "format": "decimal", "text": text,
                               "style": style_id if style_id in index else None})
    insert_ordered(root, abstract)

    num = doc.element("num", numId=num_id)
    etree.SubElement(num, q("abstractNumId")).set(q("val"), str(abstract_id))
    insert_ordered(root, num)
    pkg.put_tree(NUMBERING, root)

    # Half two, the one that is easy to skip and impossible to see missing: without
    # a w:numPr on the STYLE, the abstractNum above numbers nothing at all.
    bound = []
    for n, style_id in enumerate(targets, start=1):
        style = index[style_id]
        ppr = style.find(q("pPr"))
        if ppr is None:
            ppr = doc.element("pPr")
            insert_ordered(style, ppr)
        numpr = ppr.find(q("numPr"))
        if numpr is not None:
            ppr.remove(numpr)
        numpr = doc.element("numPr")
        insert_ordered(numpr, doc.element("ilvl", val=n - 1))
        insert_ordered(numpr, doc.element("numId", val=num_id))
        insert_ordered(ppr, numpr)
        bound.append(style_id)
    pkg.put_tree(STYLES, styles_root)

    # Numbering attached to a style is inherited by every style based on it, and
    # that is where it bites: a "副标题" based on Heading2 quietly joins the outline
    # and takes a number nobody wanted. These are NAMED and not changed — the
    # document had them before this call, and silently rewriting a style the caller
    # did not mention is the other half of the same mistake. (The one style this
    # script creates itself, TOCHeading, cancels the inheritance explicitly; see
    # `ensure_toc_styles`.)
    inherited = []
    for style_id, style in index.items():
        if style_id in bound:
            continue
        chain = [s.get(q("styleId")) for s in sty.style_chain(index, style_id)[1:]]
        if not any(c in bound for c in chain):
            continue
        ppr = style.find(q("pPr"))
        if ppr is not None and ppr.find(q("numPr")) is not None:
            continue
        inherited.append({"style": style_id,
                          "inherits_from": next(c for c in chain if c in bound)})

    return {"abstract_num_id": abstract_id, "num_id": num_id,
            "numbering_part_created": part_created,
            "levels": written_levels,
            "styles_bound": bound,
            "styles_that_inherit_it": inherited,
            "why_two_halves": "an abstractNum whose levels name a w:pStyle numbers "
                              "nothing until that style's pPr carries the matching "
                              "w:numPr; both are written above"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--toc", action="store_true", help="insert a table of contents")
    ap.add_argument("--levels", type=int, default=3,
                    help="heading levels to include (default 3)")
    ap.add_argument("--title", default="目录",
                    help="heading above the contents; pass '' for none")
    ap.add_argument("--no-cache", action="store_true",
                    help="write the field with NO result at all — the reader sees "
                         "nothing until they update it")
    ap.add_argument("--outline-numbering", action="store_true",
                    help="number the heading styles 1. / 1.1 / 1.1.1")
    ap.add_argument("--list", action="store_true", help="report the headings only")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        if not 1 <= args.levels <= 9:
            fail(f"--levels must be between 1 and 9 (WordprocessingML has nine "
                 f"outline levels); got {args.levels}")
        pkg = open_document(args.src)
        if args.list or not (args.toc or args.outline_numbering):
            if not args.list:
                fail("nothing to do: pass --toc, --outline-numbering, or --list")
            styles_root = pkg.tree(STYLES) if pkg.has(STYLES) else None
            index = sty.style_index(styles_root)
            root = pkg.tree(DOCUMENT)
            found = []
            for paragraph in doc.iter_paragraphs(doc.body(root)):
                level = outline_level(paragraph, index)
                if level is not None and level <= args.levels:
                    found.append({"level": level,
                                  "text": clip(doc.paragraph_text(paragraph).strip())})
            emit({"in": args.src.name, "headings": found}, args.report, "headings")
            return
        if not args.out:
            fail("pass --out FILE")
        ensure_distinct(args.src, args.out)
        pre_existing = check_package(pkg)
        before = dict(pkg.parts)
        report: dict = {"in": args.src.name, "out": str(args.out)}
        if args.outline_numbering:
            # Numbering first: it edits the heading styles, and the contents page
            # copies the heading TEXT, which numbering does not change.
            report["numbering"] = outline_numbering(pkg, args.levels)
        if args.toc:
            toc = insert_toc(pkg, args.levels, args.title, cached=not args.no_cache)
            # The headings come back from the call that bookmarked them. Re-scanning
            # would bookmark every heading a second time — `collect_headings` writes
            # to the tree, and a reader of this file should not have to know that.
            report["headings"] = [{"level": h["level"], "text": clip(h["text"]),
                                   "bookmark": h["bookmark"]}
                                  for h in toc.pop("headings")]
            report["toc"] = toc
        report["pre_existing_package_findings"] = save_checked(pkg, args.out,
                                                              pre_existing)
        report["parts_changed"] = sorted(n for n in pkg.parts
                                         if before.get(n) != pkg.parts[n])
        report["parts_byte_identical"] = sum(1 for n in before
                                             if pkg.parts.get(n) == before[n])
        emit(report, args.report, "headings", "parts_changed")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
