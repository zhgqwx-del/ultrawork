#!/usr/bin/env python3
"""The WordprocessingML body: paragraphs, runs, and text that crosses run boundaries.

This is the module the whole skill turns on, because the thing that goes wrong in
docx editing is not the zip and not the schema — it is that **a sentence is not a
string**. Word splits a paragraph into `<w:r>` runs on every change of formatting,
every spell-check pass, every revision-save id. The text you can see as one phrase
routinely lives in three runs, and the implementation everyone writes first —

    for p in doc.paragraphs:
        for r in p.runs:
            r.text = r.text.replace(old, new)

— finds only the occurrences that happen not to span a run. Measured 2026-08-02 on
this skill's own sample, which holds `第三季度` twice: once inside the title's single
run and once split as `"2026 年第" | "三季度"`. The per-run search finds **1 of 2**.
It does not crash, it does not warn, and it reports success — and because it is
partly right, nobody goes looking. A tool that found nothing would be reported as
broken within a minute.

So the model here is a character stream over the paragraph, with a map back to the
`<w:t>` node and offset each character came from. A replacement rewrites the first
node it touches, empties the ones in the middle, and keeps the tail of the last —
which means the replacement inherits the FIRST run's formatting. That is a choice,
not an accident: the alternative (splitting the replacement across the original
runs' formatting) puts a word boundary where the user did not ask for one.

Three things deliberately do NOT take part in the stream:

  * `<w:delText>` — text inside `<w:del>` has been deleted with change tracking on.
    It is not in the document any more; a reader who searches for it is searching
    for what a Word user cannot see.
  * `<w:tab>` / `<w:br>` — they occupy a position in the visible text but are not
    editable text nodes. A match that spans one is refused and named, rather than
    quietly rewritten into something that loses the break.
  * Field results, footnote references and the like keep their own runs; nothing
    here rewrites a run it did not match inside.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .xmlorder import MAIN_NS, insert_ordered, q

W = MAIN_NS
XML_NS = "http://www.w3.org/XML/1998/namespace"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# Ancestors of a run that change what the run MEANS. Used to report where an edit
# landed rather than to block it — see `Occurrence.context`.
REVISION_TAGS = ("ins", "del", "moveFrom", "moveTo")


def local(tag) -> str:
    return str(tag).rsplit("}", 1)[-1]


def r_attr(name: str) -> str:
    return f"{{{REL_NS}}}{name}"


def body(root):
    """The `<w:body>` of a document part, or the root itself for a header/footer."""
    if local(root.tag) in ("hdr", "ftr"):
        return root
    found = root.find(q("body"))
    if found is None:
        raise ValueError("this part has no <w:body> — is it a Word document part?")
    return found


def block_children(container):
    """Direct block-level children (paragraphs, tables) in document order."""
    return [el for el in container if local(el.tag) in ("p", "tbl", "sdt")]


def iter_paragraphs(container):
    """Every `<w:p>` under `container`, in document order, tables included."""
    for el in container.iter(q("p")):
        yield el


def iter_tables(container):
    for el in container.iter(q("tbl")):
        yield el


# ── the character stream ──────────────────────────────────────────────────────
@dataclass
class Segment:
    """One piece of a paragraph's visible text and where it came from."""
    kind: str                 # "text" (an editable <w:t>) or "break" (tab / line break)
    element: object           # the <w:t>, <w:tab> or <w:br>
    text: str
    start: int                # offset of this segment in the paragraph string


@dataclass
class Occurrence:
    start: int
    end: int
    segments: list[int]                       # indices into the Segment list
    context: list[str] = field(default_factory=list)   # ins / del / hyperlink / tc …

    @property
    def cross_run(self) -> bool:
        return len(self.segments) > 1


def _ancestors(el, stop) -> list[str]:
    names, cur = [], el.getparent()
    while cur is not None and cur is not stop:
        names.append(local(cur.tag))
        cur = cur.getparent()
    return names


def segments_of(paragraph) -> list[Segment]:
    """The paragraph's visible text, in order, split by where it is stored.

    `<w:delText>` is skipped: it is text the document no longer contains. A run
    inside `<w:del>` may also carry a plain `<w:t>` in malformed input — that case
    belongs to the validator, not here, and it is skipped for the same reason.
    """
    out: list[Segment] = []
    pos = 0
    for el in paragraph.iter():
        name = local(el.tag)
        if name == "t":
            if any(a in ("del", "delText") for a in _ancestors(el, paragraph)):
                continue
            text = el.text or ""
            out.append(Segment("text", el, text, pos))
            pos += len(text)
        elif name == "tab":
            out.append(Segment("break", el, "\t", pos))
            pos += 1
        elif name == "br":
            out.append(Segment("break", el, "\n", pos))
            pos += 1
    return out


def paragraph_text(paragraph) -> str:
    return "".join(s.text for s in segments_of(paragraph))


def find_occurrences(paragraph, needle: str) -> tuple[list[Occurrence], list[Occurrence]]:
    """Every occurrence of `needle` in the paragraph's visible text.

    Returns (usable, refused). A match that spans a tab or a line break is refused:
    rewriting across one would silently delete the break, and a replacement that
    changes the layout of a document nobody asked to reflow is a worse outcome than
    saying "this one I did not touch".
    """
    if not needle:
        return [], []
    segs = segments_of(paragraph)
    text = "".join(s.text for s in segs)
    usable: list[Occurrence] = []
    refused: list[Occurrence] = []
    at = text.find(needle)
    while at != -1:
        end = at + len(needle)
        touched = [i for i, s in enumerate(segs)
                   if s.start < end and s.start + len(s.text) > at]
        context = sorted({name for i in touched
                          for name in _ancestors(segs[i].element, paragraph)})
        occ = Occurrence(at, end, touched, context)
        (refused if any(segs[i].kind == "break" for i in touched) else usable).append(occ)
        at = text.find(needle, end)
    return usable, refused


def set_text(node, value: str) -> None:
    """Write a `<w:t>`, keeping whitespace that XML would otherwise collapse."""
    node.text = value
    if value != value.strip() or value == "":
        node.set(f"{{{XML_NS}}}space", "preserve")
    elif node.get(f"{{{XML_NS}}}space") is not None:
        del node.attrib[f"{{{XML_NS}}}space"]


def near_miss(paragraph, needle: str) -> dict | None:
    """Why a phrase that is visibly there did not match.

    "0 replacements" with no explanation is the answer that wastes an afternoon: the
    phrase IS in the document, a person can see it, and the tool says nothing. The
    two reasons it happens are both invisible on screen — a line break or tab inside
    the phrase, and whitespace that is not the whitespace you typed (a full-width
    space, a double space). Both are reported by name; neither is silently matched
    through, because doing that reflows a document nobody asked to reflow.
    """
    segs = segments_of(paragraph)
    text = "".join(s.text for s in segs)
    if not needle or needle in text:
        return None
    if needle in text.replace("\t", "").replace("\n", ""):
        return {"phrase": needle, "reason": "a tab or line break falls inside it",
                "paragraph": text[:60]}
    squashed = "".join(text.split())
    if "".join(needle.split()) in squashed:
        return {"phrase": needle,
                "reason": "the whitespace in the document is not the whitespace in "
                          "the search string",
                "paragraph": text[:60]}
    return None


def replace_in_paragraph(paragraph, old: str, new: str) -> dict:
    """Replace every occurrence of `old` in this paragraph. Returns a report.

    Occurrences are rewritten back to front so that the offsets computed once stay
    valid for the ones not yet done.
    """
    usable, refused = find_occurrences(paragraph, old)
    if not usable:
        miss = near_miss(paragraph, old)
        return {"replaced": 0, "cross_run": 0, "refused": len(refused),
                "refused_reason": ["spans a tab or line break"] if refused else [],
                "contexts": [], "near_misses": [miss] if miss else []}
    segs = segments_of(paragraph)
    cross = 0
    contexts: list[str] = []
    for occ in reversed(usable):
        first = segs[occ.segments[0]]
        last = segs[occ.segments[-1]]
        head = first.text[: occ.start - first.start]
        tail = last.text[occ.end - last.start:]
        if occ.cross_run:
            cross += 1
        for name in occ.context:
            if name in REVISION_TAGS or name == "hyperlink":
                contexts.append(name)
        if first is last:
            set_text(first.element, head + new + tail)
        else:
            set_text(first.element, head + new)
            for i in occ.segments[1:-1]:
                if segs[i].kind == "text":
                    set_text(segs[i].element, "")
            set_text(last.element, tail)
        # The stream is rebuilt because an earlier (later-in-text) rewrite changed
        # the lengths this one's offsets were computed against.
        segs = segments_of(paragraph)
    return {"replaced": len(usable), "cross_run": cross, "refused": len(refused),
            "refused_reason": ["spans a tab or line break"] if refused else [],
            "contexts": sorted(set(contexts)), "near_misses": []}


# ── building ──────────────────────────────────────────────────────────────────
# Anything this skill WRITES goes through here, so that the two rules a Word
# document is judged by — element order and the East Asian font binding — are
# satisfied by construction rather than by remembering.

CJK_RANGES = ((0x2E80, 0x2FD5), (0x3000, 0x303F), (0x3400, 0x4DBF), (0x4E00, 0x9FFF),
              (0xF900, 0xFAFF), (0xFF00, 0xFF60), (0x20000, 0x2A6DF))


def has_cjk(s: str) -> bool:
    return any(any(a <= ord(c) <= b for a, b in CJK_RANGES) for c in s)


def element(tag: str, **attrs):
    from lxml import etree
    el = etree.Element(q(tag))
    for k, v in attrs.items():
        el.set(q(k) if ":" not in k else k, str(v))
    return el


def make_run(text: str, *, bold: bool = False, italic: bool = False,
             size_pt: float | None = None, color: str | None = None,
             ascii_font: str = "Calibri", east_asia_font: str = "宋体",
             style: str | None = None):
    """A `<w:r>` whose properties are in schema order and whose CJK binds a font.

    `w:rFonts/@w:eastAsia` is not decoration. Without it Word picks the East Asian
    face from the theme, and a document handed to a machine with a different theme
    renders Chinese in whatever that machine felt like — which is the defect L2's
    D6 exists to catch. The binding is written for every run this skill creates,
    Latin ones included, because a run that gains Chinese text later should not
    quietly become wrong.
    """
    from lxml import etree
    run = element("r")
    rpr = element("rPr")
    if style:
        rpr.append(element("rStyle", val=style))
    rpr.append(element("rFonts", ascii=ascii_font, hAnsi=ascii_font,
                       eastAsia=east_asia_font, cs=ascii_font))
    if bold:
        rpr.append(element("b"))
        rpr.append(element("bCs"))
    if italic:
        rpr.append(element("i"))
        rpr.append(element("iCs"))
    if color:
        rpr.append(element("color", val=color))
    if size_pt is not None:
        half = str(int(round(size_pt * 2)))
        rpr.append(element("sz", val=half))
        rpr.append(element("szCs", val=half))
    run.append(rpr)
    node = etree.SubElement(run, q("t"))
    set_text(node, text)
    return run


def make_paragraph(text: str = "", *, style: str | None = None,
                   align: str | None = None, num_id: int | None = None,
                   level: int = 0, **run_kwargs):
    """A `<w:p>`; `pPr` is built in schema order and only if something needs it."""
    para = element("p")
    if style or align or num_id is not None:
        ppr = element("pPr")
        if style:
            insert_ordered(ppr, element("pStyle", val=style))
        if num_id is not None:
            numpr = element("numPr")
            insert_ordered(numpr, element("ilvl", val=level))
            insert_ordered(numpr, element("numId", val=num_id))
            insert_ordered(ppr, numpr)
        if align:
            insert_ordered(ppr, element("jc", val=align))
        insert_ordered(para, ppr)
    if text:
        para.append(make_run(text, **run_kwargs))
    return para


def run_like(source, text: str):
    """A run carrying `text` in `source`'s formatting.

    Used when a replacement has to look like what it replaced. The East Asian font
    binding is repaired rather than trusted: if the source run has no `w:rFonts`
    (perfectly legal — it inherits from the style) and the new text is Chinese, a
    plain copy produces a run L2's D6 rejects, and a document whose Chinese renders
    in whatever face the reader's theme picks.
    """
    from copy import deepcopy
    from lxml import etree
    run = element("r")
    rpr = source.find(q("rPr")) if source is not None else None
    rpr = deepcopy(rpr) if rpr is not None else element("rPr")
    if has_cjk(text):
        rfonts = rpr.find(q("rFonts"))
        if rfonts is None:
            rfonts = element("rFonts", ascii="Calibri", hAnsi="Calibri",
                             eastAsia="宋体", cs="Calibri")
            insert_ordered(rpr, rfonts)
        else:
            for attr, value in (("ascii", "Calibri"), ("hAnsi", "Calibri"),
                                ("eastAsia", "宋体")):
                if not rfonts.get(q(attr)) and not rfonts.get(q(attr + "Theme")):
                    rfonts.set(q(attr), value)
    run.append(rpr)
    node = etree.SubElement(run, q("t"))
    set_text(node, text)
    return run


def split_run_at(t_node, offset: int):
    """Split the run holding `t_node` so that `text[offset:]` starts a fresh run.

    The new run copies the original's properties, and anything that followed the
    text node inside the run moves with it. Returns the new run, or None when the
    offset falls on a boundary and no split is needed.
    """
    from copy import deepcopy
    from lxml import etree
    run = t_node.getparent()
    if run is None or local(run.tag) != "r":
        return None
    text = t_node.text or ""
    if offset <= 0 or offset >= len(text):
        return None
    new_run = element("r")
    rpr = run.find(q("rPr"))
    if rpr is not None:
        new_run.append(deepcopy(rpr))
    tail = etree.SubElement(new_run, t_node.tag)     # w:t or w:delText, whichever
    set_text(tail, text[offset:])
    set_text(t_node, text[:offset])
    kids = list(run)
    for sibling in kids[kids.index(t_node) + 1:]:
        run.remove(sibling)
        new_run.append(sibling)
    run.addnext(new_run)
    return new_run


def isolate_runs(paragraph, start: int, end: int) -> list:
    """Split runs so that the text in [start, end) occupies whole runs; return them.

    This is what makes tracked changes and comment anchors possible at all: both
    have to WRAP the matched text, and you cannot wrap half a run. The split is done
    tail-first so the offsets computed against the original stream stay valid.
    """
    segs = [s for s in segments_of(paragraph) if s.kind == "text"]
    for seg in reversed(segs):
        seg_end = seg.start + len(seg.text)
        if seg.start < end < seg_end:
            split_run_at(seg.element, end - seg.start)
    segs = [s for s in segments_of(paragraph) if s.kind == "text"]
    for seg in reversed(segs):
        seg_end = seg.start + len(seg.text)
        if seg.start < start < seg_end:
            split_run_at(seg.element, start - seg.start)
    out = []
    for seg in segments_of(paragraph):
        if seg.kind != "text":
            continue
        if seg.start >= start and seg.start + len(seg.text) <= end and seg.text:
            run = seg.element.getparent()
            if run is not None and local(run.tag) == "r" and run not in out:
                out.append(run)
    return out


def append_block(container, node) -> None:
    """Add a block to a body, keeping `<w:sectPr>` last.

    `container.append(node)` is the natural way to write this and it produces an
    invalid document: `<w:sectPr>` closes the section and the schema puts it at the
    end of `<w:body>`. Word repairs the file and the section properties — page size,
    margins, the header and footer bindings — are what it drops.
    """
    insert_ordered(container, node)
