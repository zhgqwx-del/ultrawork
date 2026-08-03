#!/usr/bin/env python3
"""word/styles.xml: the chain a run's formatting actually comes from.

A run that carries no `<w:rFonts>` is not a run with no font. WordprocessingML
resolves formatting down a chain (§17.7.2), and the answer for one property can come
from four different places:

    the run's own <w:rPr>
      -> the character style named by <w:rStyle>, and ITS <w:basedOn> ancestors
        -> the paragraph style named by <w:pStyle>, and ITS ancestors
          -> <w:docDefaults><w:rPrDefault>

This matters because the repair that looks obvious — "every Chinese run gets
`w:eastAsia="宋体"`" — is wrong for any run whose style already says something else.
It produces a document that passes every check (the binding is there, it is
explicit, it renders) while quietly restyling headings the author had chosen a face
for. The only way to tell the two apart is to walk the chain first and report where
each value came from, which is what `resolve_font` exists to do.

Two sources are deliberately NOT modelled, and the caller is told so rather than
left to assume full coverage: theme fonts (`@w:asciiTheme` / `@w:eastAsiaTheme`,
which resolve through word/theme/theme1.xml) and table styles. A run bound to a
theme font is reported as bound — it is — and left alone.
"""
from __future__ import annotations

from .xmlorder import MAIN_NS, insert_ordered, local, q

# The four `w:rFonts` attributes that name a face directly, and the theme attribute
# that names one indirectly. A binding through the theme still binds.
FONT_SLOTS = ("ascii", "hAnsi", "eastAsia", "cs")
THEME_OF = {"ascii": "asciiTheme", "hAnsi": "hAnsiTheme",
            "eastAsia": "eastAsiaTheme", "cs": "cstheme"}

# How deep a `w:basedOn` chain may go before this module decides it is a cycle. Real
# documents nest three or four; a file that loops would otherwise hang here.
MAX_CHAIN = 32


def style_index(styles_root) -> dict[str, object]:
    """`{styleId: <w:style>}`, or an empty index when there is no styles part."""
    if styles_root is None:
        return {}
    return {s.get(q("styleId")): s for s in styles_root.findall(q("style"))
            if s.get(q("styleId"))}


def style_chain(index: dict, style_id: str | None) -> list:
    """A style and its `w:basedOn` ancestors, nearest first."""
    out, seen = [], set()
    current = style_id
    for _ in range(MAX_CHAIN):
        if not current or current in seen or current not in index:
            break
        seen.add(current)
        node = index[current]
        out.append(node)
        based = node.find(q("basedOn"))
        current = based.get(q("val")) if based is not None else None
    return out


def _rfonts_of(container):
    """The `<w:rFonts>` under a `<w:rPr>` that is a child of `container`."""
    if container is None:
        return None
    rpr = container if local(container.tag) == "rPr" else container.find(q("rPr"))
    return rpr.find(q("rFonts")) if rpr is not None else None


def font_value(rfonts, slot: str) -> str | None:
    """A face name, or the theme slot that stands in for one, or None."""
    if rfonts is None:
        return None
    direct = rfonts.get(q(slot))
    if direct:
        return direct
    themed = rfonts.get(q(THEME_OF[slot]))
    return f"theme:{themed}" if themed else None


def doc_defaults_rfonts(styles_root):
    if styles_root is None:
        return None
    defaults = styles_root.find(q("docDefaults"))
    if defaults is None:
        return None
    return _rfonts_of(defaults.find(q("rPrDefault")))


def resolve_font(run, paragraph, styles_root, slot: str) -> tuple[str | None, str]:
    """Where this run's `slot` face comes from. Returns (value, source).

    `source` is one of `run`, `style:<id>`, `docDefaults` or `nothing` — and the
    last one is the only case where a fallback is honest, because it is the only
    case where the document has not already answered the question.
    """
    own = font_value(_rfonts_of(run), slot)
    if own:
        return own, "run"

    index = style_index(styles_root)
    rpr = run.find(q("rPr")) if run is not None else None
    rstyle = rpr.find(q("rStyle")) if rpr is not None else None
    ppr = paragraph.find(q("pPr")) if paragraph is not None else None
    pstyle = ppr.find(q("pStyle")) if ppr is not None else None

    for node in (style_chain(index, rstyle.get(q("val")) if rstyle is not None else None)
                 + style_chain(index,
                               pstyle.get(q("val")) if pstyle is not None else None)):
        value = font_value(_rfonts_of(node), slot)
        if value:
            return value, f"style:{node.get(q('styleId'))}"

    value = font_value(doc_defaults_rfonts(styles_root), slot)
    if value:
        return value, "docDefaults"
    return None, "nothing"


def ensure_rfonts(run):
    """The run's `<w:rFonts>`, created in schema order if it is not there yet."""
    rpr = run.find(q("rPr"))
    if rpr is None:
        rpr = run.makeelement(q("rPr"), {})
        insert_ordered(run, rpr)
    rfonts = rpr.find(q("rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(q("rFonts"), {})
        insert_ordered(rpr, rfonts)
    return rfonts


def ensure_style(styles_root, style_id: str, *, name: str, kind: str = "paragraph",
                 based_on: str | None = None, next_style: str | None = None,
                 ppr_xml: str = "", rpr_xml: str = "",
                 ui_priority: int | None = None) -> bool:
    """Add a style if the document has none by that id. True when one was added.

    Referring to a `w:pStyle` that no style defines is legal XML and silently
    formats as Normal — a table of contents whose entries are all flush left, with
    nothing anywhere saying why. Creating the style is the difference between a
    feature and a feature-shaped hole.
    """
    from lxml import etree
    if styles_root is None or style_id in style_index(styles_root):
        return False
    style = etree.SubElement(styles_root, q("style"))
    style.set(q("type"), kind)
    style.set(q("styleId"), style_id)
    etree.SubElement(style, q("name")).set(q("val"), name)
    if based_on:
        etree.SubElement(style, q("basedOn")).set(q("val"), based_on)
    if next_style:
        etree.SubElement(style, q("next")).set(q("val"), next_style)
    if ui_priority is not None:
        etree.SubElement(style, q("uiPriority")).set(q("val"), str(ui_priority))
    for xml in (ppr_xml, rpr_xml):
        if xml:
            style.append(etree.fromstring(f'<w:wrap xmlns:w="{MAIN_NS}">{xml}</w:wrap>')[0])
    # The children above are appended in CT_Style order already, but the caller may
    # have handed pPr/rPr in either order; put the whole thing back through the
    # ordering rules so this function cannot be the source of an invalid style.
    for child in list(style):
        style.remove(child)
        insert_ordered(style, child)
    return True
