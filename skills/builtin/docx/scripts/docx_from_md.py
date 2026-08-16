#!/usr/bin/env python3
"""W4 — generate a Word document from Markdown.

Two things make this more than a format translation, and both are contracts rather
than features:

**1. What it cannot map is NAMED, never dropped.** A generator that silently
discards a footnote, a raw `<table>` or a reference-style link produces a document
that is missing content with nothing anywhere saying so, and the person who finds
out is whoever reads the printed version. Every such construct arrives from
`office/markdown.py` with its line number, is reported under `unsupported`, and
`--strict` turns it into a refusal to write. This is the same contract W5 uses for
unfilled placeholders and W7 for unresolved revisions.

**2. A generated document needs styles that EXIST.** `w:pStyle` naming a style the
document does not define is valid XML that silently formats as Normal — headings
that are not bold, code that is not monospaced, quotes with no indent, and nothing
to explain why. So every style this writes is created if absent (through the same
`office/styles.py` machinery W12 uses), and `--template` lets a house style supply
them instead: the template's styles, numbering, headers and footers are kept and
only its BODY is replaced.

Everything written goes through `office/document.py`, so the two rules a Word
document is judged by — `w:sectPr` stays last in the body, and every run binds both
`@w:ascii` and `@w:eastAsia` — hold by construction (gotchas §21.2 ㉓ / ㊲).

    python3 docx_from_md.py --in notes.md --out notes.docx
    python3 docx_from_md.py --in notes.md --out notes.docx --template house.docx
    python3 docx_from_md.py --in notes.md --out notes.docx --strict
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, clip, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office import markdown as md  # noqa: E402
from office import styles as sty  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import MAIN_NS, insert_ordered, local, q  # noqa: E402

STYLES = "word/styles.xml"
NUMBERING = "word/numbering.xml"
SETTINGS = "word/settings.xml"
FONTTABLE = "word/fontTable.xml"
OOXML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
WML = "application/vnd.openxmlformats-officedocument.wordprocessingml."

DECL = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
ASCII_FONT, EA_FONT, MONO_FONT = "Calibri", "宋体", "Consolas"

# Heading sizes in half-points, and the styles this generator needs to exist.
HEADING_SIZE = {1: 32, 2: 28, 3: 24, 4: 22, 5: 21, 6: 21}
CODE_STYLE, QUOTE_STYLE, CAPTION_STYLE = "SourceCode", "Quote", "Caption"

# A fixed nsid so two runs over the same input produce the same bytes. Calling a
# clock or a random source here would make the output unreproducible for no reason.
NSID_BULLET, NSID_NUMBER = "2B3C4D5E", "3C4D5E6F"


# ── a blank document, when there is no template ───────────────────────────────
def blank_package() -> Package:
    """The smallest legal Word package: eight parts, all of them required.

    Written here rather than copied from a library's template because python-docx's
    bundled `default.docx` ships a `<w:zoom>` without the `w:percent` that ECMA-376
    Transitional requires, so every document produced from it fails XSD validation
    (gotchas §21.2 ㉗). A generator whose output cannot pass the gate is not a
    generator this skill can offer.
    """
    o = WML
    parts = {
        "[Content_Types].xml": DECL + (
            f'<Types xmlns="{CT_NS}">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-'
            'package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            f'<Override PartName="/word/document.xml" ContentType="{o}document.main+xml"/>'
            f'<Override PartName="/word/styles.xml" ContentType="{o}styles+xml"/>'
            f'<Override PartName="/word/settings.xml" ContentType="{o}settings+xml"/>'
            f'<Override PartName="/word/fontTable.xml" ContentType="{o}fontTable+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.'
            'openxmlformats-package.core-properties+xml"/>'
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.'
            'openxmlformats-officedocument.extended-properties+xml"/>'
            "</Types>").encode(),
        "_rels/.rels": DECL + (
            f'<Relationships xmlns="{PKG_REL}">'
            f'<Relationship Id="rId1" Type="{OOXML}/officeDocument" '
            'Target="word/document.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/'
            '2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            f'<Relationship Id="rId3" Type="{OOXML}/extended-properties" '
            'Target="docProps/app.xml"/></Relationships>').encode(),
        "word/document.xml": DECL + (
            f'<w:document xmlns:w="{MAIN_NS}" xmlns:r="{OOXML}"><w:body>'
            '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
            'w:header="851" w:footer="992" w:gutter="0"/>'
            '<w:cols w:space="425"/>'
            # NO <w:docGrid>. It used to say `type="lines" linePitch="312"`, and a
            # line grid inflates the rendered line height on top of whatever the
            # styles declare. Measured on one long CJK paragraph, same document,
            # LibreOffice, median within-paragraph gap:
            #   no grid: single 17.8pt · 1.3 spacing 23.1pt   (ratio 1.30 = declared)
            #   grid:    single 31.2pt · 1.3 spacing 40.6pt   (2.28x the reference)
            # The declared 1.3 below therefore reached paper as ~2.3 line spacing; an
            # L4 product rendered at 40.3pt/line and grew a third page holding three
            # lines. Found by reading that product, not by any assertion — 059 §二十二.
            "</w:sectPr></w:body></w:document>").encode(),
        "word/_rels/document.xml.rels": DECL + (
            f'<Relationships xmlns="{PKG_REL}">'
            f'<Relationship Id="rId1" Type="{OOXML}/styles" Target="styles.xml"/>'
            f'<Relationship Id="rId2" Type="{OOXML}/settings" Target="settings.xml"/>'
            f'<Relationship Id="rId3" Type="{OOXML}/fontTable" '
            'Target="fontTable.xml"/></Relationships>').encode(),
        "word/styles.xml": DECL + (
            f'<w:styles xmlns:w="{MAIN_NS}">'
            "<w:docDefaults><w:rPrDefault><w:rPr>"
            f'<w:rFonts w:ascii="{ASCII_FONT}" w:hAnsi="{ASCII_FONT}" '
            f'w:eastAsia="{EA_FONT}" w:cs="{ASCII_FONT}"/>'
            '<w:sz w:val="21"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>'
            "<w:pPrDefault><w:pPr>"
            '<w:spacing w:after="0" w:line="312" w:lineRule="auto"/>'
            "</w:pPr></w:pPrDefault></w:docDefaults>"
            '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
            '<w:name w:val="Normal"/><w:qFormat/></w:style>'
            "</w:styles>").encode(),
        # w:percent is REQUIRED on CT_Zoom in Transitional; omitting the element
        # entirely is the safe choice and is what this writes.
        "word/settings.xml": DECL + (
            f'<w:settings xmlns:w="{MAIN_NS}">'
            '<w:defaultTabStop w:val="420"/><w:compat/></w:settings>').encode(),
        "word/fontTable.xml": DECL + (
            f'<w:fonts xmlns:w="{MAIN_NS}">'
            f'<w:font w:name="{ASCII_FONT}"><w:family w:val="swiss"/>'
            '<w:pitch w:val="variable"/></w:font>'
            f'<w:font w:name="{EA_FONT}"><w:family w:val="auto"/>'
            '<w:pitch w:val="variable"/></w:font>'
            f'<w:font w:name="{MONO_FONT}"><w:family w:val="modern"/>'
            '<w:pitch w:val="fixed"/></w:font></w:fonts>').encode(),
        "docProps/core.xml": DECL + (
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/'
            '2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            "<dc:creator>ultrawork</dc:creator>"
            "<cp:lastModifiedBy>ultrawork</cp:lastModifiedBy>"
            "</cp:coreProperties>").encode(),
        "docProps/app.xml": DECL + (
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/'
            '2006/extended-properties">'
            "<Application>ultrawork docx skill</Application>"
            "<DocSecurity>0</DocSecurity></Properties>").encode(),
    }
    return Package(dict(parts), list(parts))


def clear_body(pkg: Package) -> int:
    """Empty a template's body, keeping its `w:sectPr`. Returns blocks removed.

    The section properties carry the page size, the margins and the header/footer
    bindings — everything that makes a template a template. Removing them along with
    the content would keep the styles and throw away the layout.
    """
    root = pkg.tree(DOCUMENT)
    body = doc.body(root)
    removed = 0
    for el in list(body):
        if local(el.tag) != "sectPr":
            body.remove(el)
            removed += 1
    pkg.put_tree(DOCUMENT, root)
    return removed


# ── styles ────────────────────────────────────────────────────────────────────
def ensure_styles(pkg: Package, levels: int) -> list[str]:
    """Create every style this generator names, if the document lacks it."""
    root = pkg.tree(STYLES) if pkg.has(STYLES) else None
    if root is None:
        fail("the template has no word/styles.xml, so there is nothing to hang "
             "generated formatting on")
    created = []
    fonts = (f'<w:rFonts w:ascii="{ASCII_FONT}" w:hAnsi="{ASCII_FONT}" '
             f'w:eastAsia="{EA_FONT}" w:cs="{ASCII_FONT}"/>')
    for level in range(1, levels + 1):
        half = HEADING_SIZE.get(level, 21)
        if sty.ensure_style(
                root, f"Heading{level}", name=f"heading {level}", based_on="Normal",
                next_style="Normal", ui_priority=9,
                ppr_xml=f'<w:pPr><w:keepNext/>'
                        f'<w:spacing w:before="{340 - level * 30}" w:after="160"/>'
                        f'<w:outlineLvl w:val="{level - 1}"/></w:pPr>',
                rpr_xml=f'<w:rPr>{fonts}<w:b/><w:bCs/>'
                        f'<w:sz w:val="{half}"/><w:szCs w:val="{half}"/></w:rPr>'):
            created.append(f"Heading{level}")
    if sty.ensure_style(root, CODE_STYLE, name="Source Code", based_on="Normal",
                        ui_priority=99,
                        ppr_xml='<w:pPr><w:shd w:val="clear" w:color="auto" '
                                'w:fill="F5F5F5"/>'
                                '<w:spacing w:before="80" w:after="80"/>'
                                '<w:ind w:left="240"/></w:pPr>',
                        rpr_xml=f'<w:rPr><w:rFonts w:ascii="{MONO_FONT}" '
                                f'w:hAnsi="{MONO_FONT}" w:eastAsia="{EA_FONT}" '
                                f'w:cs="{MONO_FONT}"/>'
                                f'<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'):
        created.append(CODE_STYLE)
    if sty.ensure_style(root, QUOTE_STYLE, name="Quote", based_on="Normal",
                        ui_priority=29,
                        ppr_xml='<w:pPr><w:ind w:left="720" w:right="360"/>'
                                '<w:spacing w:before="120" w:after="120"/></w:pPr>',
                        rpr_xml=f'<w:rPr>{fonts}<w:i/><w:iCs/>'
                                f'<w:color w:val="595959"/></w:rPr>'):
        created.append(QUOTE_STYLE)
    if sty.ensure_style(root, CAPTION_STYLE, name="Caption", based_on="Normal",
                        ui_priority=35,
                        ppr_xml='<w:pPr><w:jc w:val="center"/>'
                                '<w:spacing w:after="200"/></w:pPr>',
                        rpr_xml=f'<w:rPr>{fonts}<w:i/><w:iCs/>'
                                f'<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'):
        created.append(CAPTION_STYLE)
    if sty.ensure_style(root, "Hyperlink", name="Hyperlink", kind="character",
                        ui_priority=99,
                        rpr_xml='<w:rPr><w:color w:val="0563C1"/>'
                                '<w:u w:val="single"/></w:rPr>'):
        created.append("Hyperlink")
    if sty.ensure_style(root, "CodeChar", name="Code Char", kind="character",
                        ui_priority=99,
                        rpr_xml=f'<w:rPr><w:rFonts w:ascii="{MONO_FONT}" '
                                f'w:hAnsi="{MONO_FONT}" w:eastAsia="{EA_FONT}" '
                                f'w:cs="{MONO_FONT}"/>'
                                f'<w:shd w:val="clear" w:color="auto" '
                                f'w:fill="F0F0F0"/></w:rPr>'):
        created.append("CodeChar")
    pkg.put_tree(STYLES, root)
    return created


# ── numbering ─────────────────────────────────────────────────────────────────
# Real Unicode bullets, not the private-use code points Word conventionally puts in
# Symbol/Wingdings. Those need a `w:rFonts w:hint` on the level or they render as a
# missing glyph anywhere the symbol font is absent — which on Linux is everywhere.
BULLET_CHARS = ("•", "◦", "▪")     # • ◦ ▪


def ensure_numbering(pkg: Package, depth: int) -> dict:
    """One bullet list and one ordered list, each with `depth` levels."""
    from lxml import etree
    if pkg.has(NUMBERING):
        root = pkg.tree(NUMBERING)
        created_part = False
    else:
        root = etree.Element(q("numbering"), nsmap={"w": MAIN_NS})
        pkg.set_override(NUMBERING, WML + "numbering+xml")
        pkg.add_relationship(Package.rels_part_of(DOCUMENT), OOXML + "/numbering",
                             "numbering.xml")
        created_part = True

    used_a = [int(a.get(q("abstractNumId"))) for a in root.findall(q("abstractNum"))
              if (a.get(q("abstractNumId")) or "").lstrip("-").isdigit()]
    used_n = [int(x.get(q("numId"))) for x in root.findall(q("num"))
              if (x.get(q("numId")) or "").isdigit()]
    next_a = max(used_a, default=-1) + 1
    next_n = max(used_n, default=0) + 1

    ids = {}
    for kind, nsid in (("bullet", NSID_BULLET), ("ordered", NSID_NUMBER)):
        abstract = doc.element("abstractNum", abstractNumId=next_a)
        insert_ordered(abstract, doc.element("nsid", val=nsid))
        insert_ordered(abstract, doc.element("multiLevelType", val="hybridMultilevel"))
        for lvl_i in range(depth):
            lvl = doc.element("lvl", ilvl=lvl_i)
            insert_ordered(lvl, doc.element("start", val=1))
            if kind == "bullet":
                insert_ordered(lvl, doc.element("numFmt", val="bullet"))
                insert_ordered(lvl, doc.element("lvlText",
                                                val=BULLET_CHARS[lvl_i % 3]))
            else:
                insert_ordered(lvl, doc.element("numFmt", val="decimal"))
                insert_ordered(lvl, doc.element("lvlText", val=f"%{lvl_i + 1}."))
            insert_ordered(lvl, doc.element("lvlJc", val="left"))
            ppr = doc.element("pPr")
            ind = doc.element("ind")
            ind.set(q("left"), str(420 * (lvl_i + 1)))
            ind.set(q("hanging"), "420")
            insert_ordered(ppr, ind)
            insert_ordered(lvl, ppr)
            insert_ordered(abstract, lvl)
        insert_ordered(root, abstract)
        num = doc.element("num", numId=next_n)
        etree.SubElement(num, q("abstractNumId")).set(q("val"), str(next_a))
        insert_ordered(root, num)
        ids[kind] = next_n
        next_a += 1
        next_n += 1
    pkg.put_tree(NUMBERING, root)
    return {"num_ids": ids, "levels": depth, "numbering_part_created": created_part}


# ── rendering ─────────────────────────────────────────────────────────────────
def span_run(span: md.Span):
    """One `<w:r>` for one styled span. Formatting is per-span, so a sentence with
    two emphases becomes three runs — which is what Word does too, and exactly the
    thing `office/document.py` exists to read back correctly (gotchas §21.2 ㉒)."""
    return doc.make_run(
        span.text, bold=span.bold, italic=span.italic,
        ascii_font=MONO_FONT if span.code else ASCII_FONT,
        east_asia_font=EA_FONT,
        style="CodeChar" if span.code else ("Hyperlink" if span.link else None))


def add_spans(paragraph, spans: list[md.Span], pkg: Package, rels: dict) -> None:
    """Append the spans, wrapping linked ones in a `<w:hyperlink>` with a real
    relationship — a link with no r:id is text that merely looks like a link."""
    from lxml import etree
    for span in spans:
        if span.link:
            rid = rels.get(span.link)
            if rid is None:
                rid = pkg.add_relationship(Package.rels_part_of(DOCUMENT),
                                           OOXML + "/hyperlink", span.link,
                                           mode="External")
                rels[span.link] = rid
            node = etree.SubElement(paragraph, q("hyperlink"))
            node.set(f"{{{OOXML}}}id", rid)
            node.append(span_run(span))
        else:
            paragraph.append(span_run(span))


def list_paragraph(span_list, level: int, ordered: bool, num_ids: dict):
    para = doc.make_paragraph(style="Normal", num_id=num_ids["ordered" if ordered
                                                             else "bullet"],
                              level=min(level, 8))
    return para


def render_table(rows, alignments, pkg: Package, rels: dict):
    """A `<w:tbl>` with a `tblGrid` — without one Word collapses every column to
    nothing, and the table is present but unreadable."""
    from lxml import etree
    columns = max(len(r) for r in rows)
    width = 9026 // max(columns, 1)
    table = doc.element("tbl")
    tbl_pr = doc.element("tblPr")
    insert_ordered(tbl_pr, doc.element("tblStyle", val="TableGrid"))
    w = doc.element("tblW")
    w.set(q("w"), "9026")
    w.set(q("type"), "dxa")
    insert_ordered(tbl_pr, w)
    borders = etree.fromstring(
        f'<w:tblBorders xmlns:w="{MAIN_NS}">'
        + "".join(f'<w:{side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
                  for side in ("top", "left", "bottom", "right", "insideH", "insideV"))
        + "</w:tblBorders>")
    insert_ordered(tbl_pr, borders)
    insert_ordered(table, tbl_pr)
    grid = doc.element("tblGrid")
    for _ in range(columns):
        col = doc.element("gridCol")
        col.set(q("w"), str(width))
        insert_ordered(grid, col)
    insert_ordered(table, grid)

    for r_index, row in enumerate(rows):
        tr = doc.element("tr")
        for c_index in range(columns):
            tc = doc.element("tc")
            tc_pr = doc.element("tcPr")
            cw = doc.element("tcW")
            cw.set(q("w"), str(width))
            cw.set(q("type"), "dxa")
            insert_ordered(tc_pr, cw)
            insert_ordered(tc, tc_pr)
            align = alignments[c_index] if c_index < len(alignments) else "left"
            para = doc.make_paragraph(align=None if align == "left" else align)
            cells = row[c_index] if c_index < len(row) else []
            spans = [md.Span(s.text, bold=s.bold or r_index == 0, italic=s.italic,
                             code=s.code, strike=s.strike, link=s.link)
                     for s in cells]
            add_spans(para, spans, pkg, rels)
            if not spans:
                para.append(doc.make_run(""))
            tc.append(para)
            tr.append(tc)
        table.append(tr)
    return table


def render(pkg: Package, blocks: list[md.Block], source: Path,
           num_ids: dict) -> dict:
    """Write every block into the body, in order."""
    from lxml import etree
    root = pkg.tree(DOCUMENT)
    body = doc.body(root)
    rels: dict[str, str] = {}
    counts: dict[str, int] = {}
    images: list[dict] = []

    for block in blocks:
        counts[block.kind] = counts.get(block.kind, 0) + 1
        if block.kind == "heading":
            para = doc.make_paragraph(style=f"Heading{min(block.level, 6)}")
            add_spans(para, block.spans, pkg, rels)
            doc.append_block(body, para)
        elif block.kind == "paragraph":
            para = doc.make_paragraph()
            add_spans(para, block.spans, pkg, rels)
            doc.append_block(body, para)
        elif block.kind == "list_item":
            para = list_paragraph(block.spans, block.level, block.ordered, num_ids)
            add_spans(para, block.spans, pkg, rels)
            doc.append_block(body, para)
        elif block.kind == "quote":
            para = doc.make_paragraph(style=QUOTE_STYLE)
            add_spans(para, block.spans, pkg, rels)
            doc.append_block(body, para)
        elif block.kind == "code":
            # One paragraph per line: a single paragraph with <w:br> would wrap and
            # lose the indentation that is the point of a code block.
            for line in (block.text.split("\n") or [""]):
                para = doc.make_paragraph(style=CODE_STYLE)
                para.append(doc.make_run(line or " ", ascii_font=MONO_FONT,
                                         east_asia_font=EA_FONT))
                doc.append_block(body, para)
        elif block.kind == "rule":
            para = doc.make_paragraph()
            ppr = para.find(q("pPr"))
            if ppr is None:
                ppr = doc.element("pPr")
                insert_ordered(para, ppr)
            insert_ordered(ppr, etree.fromstring(
                f'<w:pBdr xmlns:w="{MAIN_NS}"><w:bottom w:val="single" w:sz="6" '
                f'w:space="1" w:color="BFBFBF"/></w:pBdr>'))
            doc.append_block(body, para)
        elif block.kind == "table":
            doc.append_block(body, render_table(block.rows, block.alignments,
                                                pkg, rels))
        elif block.kind == "image":
            images.append({"src": block.src, "alt": block.alt, "line": block.line})
            para = doc.make_paragraph(align="center")
            para.append(doc.make_run(f"[{block.alt or block.src}]"))
            doc.append_block(body, para)
            if block.alt:
                cap = doc.make_paragraph(block.alt, style=CAPTION_STYLE)
                doc.append_block(body, cap)
    pkg.put_tree(DOCUMENT, root)
    return {"blocks": counts, "hyperlinks": len(rels), "images": images}


def place_images(pkg: Package, images: list[dict], base: Path) -> list[dict]:
    """Replace each image placeholder with a real picture, sized in EMU.

    Reuses W11's machinery rather than a second copy of it: one place gets the four
    package pieces and the EMU conversion right, or two places get it differently.
    """
    from docx_image import build_drawing, next_doc_pr_id
    from office.media import MediaError, Picture
    out = []
    root = pkg.tree(DOCUMENT)
    paragraphs = list(doc.iter_paragraphs(doc.body(root)))
    for entry in images:
        path = (base / entry["src"]).resolve()
        placeholder = f"[{entry['alt'] or entry['src']}]"
        target = next((p for p in paragraphs
                       if doc.paragraph_text(p) == placeholder), None)
        if target is None:
            out.append({**entry, "placed": False, "why": "placeholder not found"})
            continue
        try:
            picture = Picture(path)
        except MediaError as e:
            # NOT fatal and NOT silent: a missing picture is a real thing to tell the
            # caller about, and refusing the whole document over one would make the
            # generator unusable on a draft.
            out.append({**entry, "placed": False, "why": str(e)[:160]})
            continue
        cx, cy = picture.extent(width_cm=None, height_cm=None)
        max_cx = 5486400                      # 6in: the usable width of an A4 page
        if cx > max_cx:
            cy = round(cy * max_cx / cx)
            cx = max_cx
        part = pkg.free_part_name("word/media/image{n}." + picture.extension)
        pkg.write(part, path.read_bytes())
        pkg.set_default(picture.extension, picture.content_type)
        rid = pkg.add_relationship(Package.rels_part_of(DOCUMENT),
                                   OOXML + "/image", part.split("/", 1)[1])
        for child in list(target):
            if local(child.tag) != "pPr":
                target.remove(child)
        holder = doc.element("r")
        holder.append(build_drawing(rid, cx, cy, next_doc_pr_id(root),
                                    path.name, entry["alt"]))
        target.append(holder)
        out.append({**entry, "placed": True, "part": part,
                    "emu": {"cx": cx, "cy": cy}})
    pkg.put_tree(DOCUMENT, root)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path,
                    help="the Markdown file")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--template", type=Path,
                    help="a .docx whose styles, numbering, headers and footers are "
                         "kept; only its body is replaced")
    ap.add_argument("--strict", action="store_true",
                    help="refuse to write if anything in the Markdown could not be "
                         "mapped")
    ap.add_argument("--list-depth", type=int, default=3,
                    help="how many nesting levels of list to author (default 3)")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        if not args.src.is_file():
            fail(f"no such file: {args.src}")
        ensure_distinct(args.src, args.out)
        text = args.src.read_text(encoding="utf-8")
        blocks, unsupported = md.parse(text)
        if not blocks:
            fail(f"{args.src.name} produced no content — it is empty, or everything "
                 f"in it is a construct this generator does not map "
                 f"({len(unsupported)} reported)")

        if args.template:
            pkg = open_document(args.template)
            replaced = clear_body(pkg)
        else:
            pkg = blank_package()
            replaced = 0
        pre_existing = check_package(pkg)

        levels = max([b.level for b in blocks if b.kind == "heading"] or [1])
        created = ensure_styles(pkg, max(min(levels, 6), 3))
        numbering = ensure_numbering(pkg, max(args.list_depth, 1))
        written = render(pkg, blocks, args.src, numbering["num_ids"])
        placed = place_images(pkg, written.pop("images"), args.src.resolve().parent)

        report = {
            "in": args.src.name, "out": str(args.out),
            "template": str(args.template) if args.template else
                        "none — a blank document was authored",
            "template_blocks_replaced": replaced,
            "written": written,
            "styles_created": created,
            "numbering": numbering,
            "images": placed,
            # The contract: everything this could not map, by line. `--strict` turns
            # it into a refusal; without it the caller at least KNOWS.
            "unsupported": unsupported,
            "unsupported_count": len(unsupported),
        }
        if args.strict and unsupported:
            kinds = sorted({u["construct"] for u in unsupported})
            fail(f"--strict: {len(unsupported)} construct(s) in {args.src.name} could "
                 f"not be mapped to WordprocessingML ({', '.join(kinds)}). Nothing "
                 f"was written. The full list with line numbers is what --report "
                 f"writes; drop --strict to generate anyway and read it there")
        report["pre_existing_package_findings"] = save_checked(pkg, args.out,
                                                              pre_existing)
        emit(report, args.report, "unsupported", "images", "styles_created")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
