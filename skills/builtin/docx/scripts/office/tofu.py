#!/usr/bin/env python3
"""Did the Chinese come out as boxes? (the tofu guard behind docx_pdf / xlsx_pdf)

LibreOffice exits 0 and writes a perfectly valid PDF when the machine has no font
that covers the document's CJK characters — every one of them is drawn as the
fallback font's `.notdef` glyph, a hollow rectangle. The blank-page check cannot see
it (a page of boxes has plenty of ink), the text layer cannot see it (see below), and
the skill reported success on exactly this output for two weeks in 2026-09 when the
macOS LibreOffice cask floated to 26.8 (gotchas §21⑧-bis). It is not a 26.8-only
problem: a Linux host without fonts-noto-cjk, or a Windows host without SimSun /
Microsoft YaHei, produces the same PDF today.

This module is the same file in the docx and xlsx skills' office/ trees — copies,
not a shared module (see office/__init__.py); scripts/test-docx-skill.py holds both
to one contract the way it does for soffice_env.

Two signatures, because PDFium reports a `.notdef` glyph in two different ways
depending on the fallback font's type (measured 2026-09-16 on the same tofu PDF,
LibreOffice 26.8 / svp backend):

  * **hollow** — the character survives in the text layer with its real code point
    (the Type1 fallback), and its rendered box has ink on the border and nothing in
    the middle. The centre-ink test below catches it: the middle 44% of a real CJK
    glyph is crossed by strokes; the middle of a box is paper.
  * **vanished** — the character is NOT in the text page at all (the TrueType
    fallback: LibreOffice's subsetter gives every notdef glyph code 0, which has no
    ToUnicode entry, and PDFium drops it from the text page), and PDFium's raster
    draws NOTHING for it — the labels are simply blank (a viewer with a different
    glyph fallback may show boxes instead). What is left is a text object with a
    font size and no extractable text (`FPDFTextObj_GetText` returns just the
    terminator), one per glyph. A tofu workbook measured 0 CJK characters in its
    text page and 117 of these; counting only text-page characters would have
    passed it with "no CJK to check".

So the question is asked per glyph and both kinds are in the denominator: of the
CJK glyphs on the page (the ones with a code point plus the ones that lost it), how
many have strokes in the middle?

One kind of noise wears the second signature: a trailing SPACE drawn in a CJK font
also comes out as an empty text object (pdfminer reads it as ' '; PDFium reads
nothing), about one per line end on a correct page. Two defences, because neither
alone is airtight: (1) an empty object is ignored when its FONT also draws a CJK
character that did reach the text page on the same page — a font that demonstrably
has the glyphs is not the one producing notdefs (the fallback font never has a CJK
character in the text page, so its empties all count); (2) the caller passes how
many CJK characters the SOURCE holds and only as many empty objects are believed as
the text page failed to account for (`expected - seen`), which also keeps a bullet
drawn from a glyphless symbol font (gotchas §21⓯) from being read as missing
Chinese. A document with one Chinese character and eight such spaces measured 1/1
with both in place, 1/9 with neither.

The render budget (TOFU_PAGES) is spent only on pages that have a CJK character in
the text page; empty text objects are counted on EVERY page without rendering, so
a document whose Chinese starts on page 4 behind three bulleted Latin pages is
still measured, and a document whose glyphs all vanished is caught wherever they are.

Thresholds are the ones scripts/office-skills-selftest.py calibrated on
2026-08-01 (gotchas §10⑭): real pages score 0.96-1.00, adversarial hollow-centre
characters 口囗田日 score 0.79, boxes score 0.00, and 0.50 sits inside the gap.
They are copied, not re-tuned — the self-test's constants carry the calibration
notes and are the place to change them.

Coordinates: `get_charbox` is in PAGE space (unrotated, origin bottom-left) while a
render is in DISPLAY space. On a page with /Rotate the two disagree and every box
lands on empty paper (gotchas §21⑨: invisible on an unrotated page, which is every
page LibreOffice writes — until someone rotates one). `set_rotation(0)` before
measuring puts the pixels in page space, and the rotation is put back afterwards
so a later --png render of the same page still comes out the way a viewer shows it.
"""
from __future__ import annotations

import ctypes
import re

TOFU_CENTER_INK = 0.05      # per-glyph: share of the centre box that counts as strokes
TOFU_MIN_FRACTION = 0.50    # per-document: share of CJK glyphs that must have them
TOFU_DPI = 200
TOFU_PAGES = 3              # pages measured; tofu is a whole-document condition

# byte -> 1 when inked. Antialiased grey counts: at any sane resolution most of a
# thin CJK stroke is grey, and a cutoff that only sees black calls light strokes
# hollow (the self-test's first cut did exactly that on a real deck).
GLYPH_INK = bytes(1 if v < 200 else 0 for v in range(256))

CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF),
              (0x20000, 0x2A6DF))
_CJK_RE = re.compile("[" + "".join(f"{chr(a)}-{chr(b)}" for a, b in CJK_RANGES) + "]")


def is_cjk(cp: int) -> bool:
    return any(a <= cp <= b for a, b in CJK_RANGES)


def has_cjk(s: str) -> bool:
    return any(is_cjk(ord(c)) for c in s)


def count_cjk(s: str) -> int:
    return sum(1 for c in s if is_cjk(ord(c)))


def _font_name(font) -> str:
    import pypdfium2.raw as raw
    fn = getattr(raw, "FPDFFont_GetBaseFontName", None) or raw.FPDFFont_GetFontName
    n = fn(font, None, 0)
    if n <= 1:
        return ""
    buf = ctypes.create_string_buffer(n)
    fn(font, buf, n)
    return buf.value.decode("utf-8", "replace")


def _cjk_fonts(textpage, indices) -> set[str]:
    """Names of the fonts that draw the text page's CJK characters."""
    import pypdfium2.raw as raw
    names: set[str] = set()
    flags = ctypes.c_int()
    for i in indices:
        n = raw.FPDFText_GetFontInfo(textpage, i, None, 0, ctypes.byref(flags))
        if n <= 1:
            continue
        buf = ctypes.create_string_buffer(n)
        raw.FPDFText_GetFontInfo(textpage, i, buf, n, ctypes.byref(flags))
        names.add(buf.value.decode("utf-8", "replace"))
    return names


def _empty_text_objects(page, textpage, cjk_fonts: set[str]) -> int:
    """Text objects that extract as nothing — the `.notdef`s.

    `FPDFTextObj_GetText` reports a length in BYTES (UTF-16LE, terminator included),
    so 2 is the empty string. Their bounding box is degenerate too (PDFium derives it
    from the characters it knows about), so the font size is the "this object draws
    a glyph" test — a size-0 text object puts nothing on the page. An empty object
    in a font that draws real CJK characters on this page is a space, not a notdef.
    """
    import pypdfium2.raw as raw
    n = 0
    size = ctypes.c_float()
    for obj in page.get_objects():
        if obj.type != raw.FPDF_PAGEOBJ_TEXT:
            continue
        if raw.FPDFTextObj_GetText(obj, textpage, None, 0) > 2:
            continue
        if not (raw.FPDFTextObj_GetFontSize(obj, ctypes.byref(size)) and size.value > 0):
            continue
        if cjk_fonts and _font_name(raw.FPDFTextObj_GetFont(obj)) in cjk_fonts:
            continue
        n += 1
    return n


def page_glyphs(page) -> dict:
    """Measure one page. Returns cjk / notdef / inked counts.

    `cjk` are text-page characters in the CJK ranges, `inked` how many of them have
    strokes in their centre, `notdef` the empty text objects (glyphs the text page
    does not list). The caller decides what to do with a page that has neither.
    """
    import pypdfium2.raw as raw
    rotation = page.get_rotation()
    page.set_rotation(0)
    try:
        return _measure_unrotated(page, raw)
    finally:
        page.set_rotation(rotation)   # the caller may still render this page for --png


def _measure_unrotated(page, raw) -> dict:
    textpage = page.get_textpage()
    try:
        indices = [i for i in range(textpage.count_chars())
                   if is_cjk(raw.FPDFText_GetUnicode(textpage, i))]
        boxes = [textpage.get_charbox(i) for i in indices]
        notdef = _empty_text_objects(page, textpage, _cjk_fonts(textpage, indices))
    finally:
        textpage.close()
    out = {"cjk": len(boxes), "notdef": notdef, "inked": 0}
    if not boxes:
        return out
    scale = TOFU_DPI / 72.0
    bitmap = page.render(scale=scale, grayscale=True)
    buf, stride, width, height = (bitmap.buffer, bitmap.stride, bitmap.width,
                                  bitmap.height)
    page_h = page.get_height()
    inked = 0
    for left, bottom, right, top in boxes:
        x0, x1 = left * scale, right * scale
        y0, y1 = (page_h - top) * scale, (page_h - bottom) * scale   # flip y
        bw, bh = x1 - x0, y1 - y0
        if bw < 3 or bh < 3:
            continue
        cl, cr = max(int(x0 + bw * 0.28), 0), min(int(x1 - bw * 0.28), width)
        ct, cb = max(int(y0 + bh * 0.28), 0), min(int(y1 - bh * 0.28), height)
        dark = total = 0
        for yy in range(ct, cb):
            row = bytes(buf[yy * stride + cl:yy * stride + cr])
            dark += row.translate(GLYPH_INK).count(1)
            total += len(row)
        if total and dark / total > TOFU_CENTER_INK:
            inked += 1
    out["inked"] = inked
    return out


def _scan_page(page) -> dict:
    """The text-layer half of page_glyphs, without rendering: CJK characters PDFium
    extracts and empty text objects. For the pages past the render budget."""
    import pypdfium2.raw as raw
    textpage = page.get_textpage()
    try:
        indices = [i for i in range(textpage.count_chars())
                   if is_cjk(raw.FPDFText_GetUnicode(textpage, i))]
        notdef = _empty_text_objects(page, textpage, _cjk_fonts(textpage, indices))
    finally:
        textpage.close()
    return {"cjk": len(indices), "notdef": notdef}


def check_tofu(doc, expected_cjk: int | None = None, max_pages: int = TOFU_PAGES) -> dict:
    """Tofu verdict for an open pypdfium2 document.

    Renders and measures the first `max_pages` pages that carry a CJK character in
    the text page (a Latin cover page is skipped, not counted as evidence); every
    page's text layer and empty text objects are read without rendering, so the
    source's CJK count can be reconciled against what PDFium sees and glyphs that
    vanished anywhere in the document are counted. `expected_cjk` is that source
    count; None believes every empty text object the font test lets through (only
    for callers that have no source to compare with).

        cjk_glyphs           CJK glyphs judged: rendered text-page ones + believed empties
        cjk_inked            how many have strokes in the middle
        cjk_inked_fraction   cjk_inked / cjk_glyphs, or None when nothing was seen
        notdef_glyphs        empty text objects believed to be missing glyphs
        empty_text_objects   empty text objects seen (whole document, font-filtered)
        cjk_in_text_layer    CJK characters PDFium extracts, whole document
        pages_checked        1-based page numbers that were rendered and measured
        tofu                 True / False, or None when nothing was there to judge
    """
    cjk = inked = empties = in_text = 0
    checked: list[int] = []
    for i in range(len(doc)):
        page = doc[i]
        if len(checked) >= max_pages:
            m = _scan_page(page)
        else:
            m = page_glyphs(page)
            if m["cjk"]:
                checked.append(i + 1)
                cjk += m["cjk"]
                inked += m["inked"]
        in_text += m["cjk"]
        empties += m["notdef"]
    unaccounted = empties if expected_cjk is None else max(0, expected_cjk - in_text)
    notdef = min(empties, unaccounted)
    total = cjk + notdef
    frac = inked / total if total else None
    return {"cjk_glyphs": total, "cjk_inked": inked, "cjk_inked_fraction": frac,
            "notdef_glyphs": notdef, "empty_text_objects": empties,
            "cjk_in_text_layer": in_text, "pages_checked": checked,
            "tofu": None if frac is None else frac < TOFU_MIN_FRACTION}


def describe(t: dict) -> str:
    """The sentence that travels: what was measured, in numbers, so a relay cannot
    soften it into "the preview may have font issues"."""
    pct = f"{t['cjk_inked_fraction']:.0%}" if t["cjk_inked_fraction"] is not None else "0%"
    where = (f"on page(s) {', '.join(map(str, t['pages_checked']))}" if t["pages_checked"]
             else "in the document (none reached the text layer)")
    return (f"the Chinese text in this PDF did not render (tofu — hollow boxes or blank "
            f"where the characters should be): only {t['cjk_inked']} of "
            f"{t['cjk_glyphs']} CJK glyph(s) {where} have strokes ({pct}, "
            f"need {TOFU_MIN_FRACTION:.0%}). The machine running LibreOffice has no font "
            f"that covers these characters — Linux: install fonts-noto-cjk; Windows: a "
            f"CJK font such as SimSun or Microsoft YaHei; macOS with LibreOffice >= 26.8: "
            f"the skill sets SAL_USE_VCLPLUGIN=osx for soffice, check nothing overrides it")
