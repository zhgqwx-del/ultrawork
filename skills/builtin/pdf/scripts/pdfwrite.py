#!/usr/bin/env python3
"""Font embedding, glyph coverage and line breaking for PDF generation.

This is the half of P13/P14 that decides whether generated Chinese is readable on
anyone else's machine.

    fontname="china-s" (what the fixtures used) -> ext 'n/a'  = NOT embedded
    insert_font(fontbuffer=...)                 -> ext 'ttf'  = embedded

Only the second travels. The first renders correctly here and turns into empty
boxes on a machine without a CJK system font, which is the exact failure a
"generate a PDF" capability must not ship.

Embedding costs 3.5MB of font, so `Document.subset_fonts()` runs before saving and
cuts it to the glyphs actually used — measured 3,569,129 -> 10,675 bytes on a
one-line document, still embedded, text still extractable.

Coverage is checked BEFORE writing, because a glyph the font does not have is
drawn as a blank or a box with no error anywhere: `has_glyph` is the only place
that failure is visible.
"""
from __future__ import annotations

from pathlib import Path

from pdfcommon import fail

# Bundled with PyMuPDF (Droid Sans Fallback, Apache-2.0), so nothing extra ships in
# this repo and nothing extra has to be downloaded. --font overrides it with any
# TTF/OTF the caller supplies.
BUILTIN_CJK = "china-s"
BUILTIN_LATIN = "helv"

# PyMuPDF ships these by name and they all carry real, embeddable bytes (measured:
# helv 33,151 / cour 45,974 / tiro 48,556 / china-s 3,556,308). --font accepts a
# name from here as well as a file path, which means a Latin-only document does not
# have to carry a 3.5MB CJK face — and it means the coverage check can be exercised
# on every platform instead of hunting for a system font that only macOS has.
BUILTIN_FONTS = ("helv", "cour", "tiro", "china-s", "china-t", "japan", "korea")

CJK_RANGES = ((0x2E80, 0x2EFF), (0x3000, 0x303F), (0x3400, 0x4DBF),
              (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0xFF00, 0xFF60),
              (0x20000, 0x2A6DF))


def is_cjk(ch: str) -> bool:
    return any(a <= ord(ch) <= b for a, b in CJK_RANGES)


def has_cjk(s: str) -> bool:
    return any(is_cjk(c) for c in s)


class Typeface:
    """One font plus the two questions the layout keeps asking it."""

    def __init__(self, spec: Path | str | None = None):
        import fitz

        if spec is None:
            self.font = fitz.Font(BUILTIN_CJK)
            self.source = f"PyMuPDF built-in {BUILTIN_CJK!r}"
        elif Path(spec).is_file():
            try:
                self.font = fitz.Font(fontfile=str(spec))
            except Exception as e:  # noqa: BLE001 - fitz raises several types
                fail(f"{Path(spec).name} is not a usable font file: "
                     f"{type(e).__name__}: {e}")
            self.source = str(spec)
        elif str(spec) in BUILTIN_FONTS:
            # Checked AFTER the file test on purpose: a real file named `helv` in the
            # working directory is what the caller meant, not the built-in.
            self.font = fitz.Font(str(spec))
            self.source = f"PyMuPDF built-in {str(spec)!r}"
        else:
            fail(f"--font {spec}: no such file, and not one of the built-in names "
                 f"({', '.join(BUILTIN_FONTS)})")
        self.name = self.font.name
        if not self.font.buffer:
            fail(f"{self.name} carries no embeddable bytes, so a document using it "
                 f"would only name the font and rely on the reader having it")

    def width(self, text: str, size: float) -> float:
        return self.font.text_length(text, fontsize=size)

    def missing_glyphs(self, text: str) -> list[str]:
        """Characters this font cannot draw, in first-seen order, deduplicated."""
        seen, out = set(), []
        for ch in text:
            if ch in seen or ch in "\n\r\t":
                continue
            seen.add(ch)
            if not self.font.has_glyph(ord(ch)):
                out.append(ch)
        return out


def wrap(text: str, face: Typeface, size: float, width: float) -> list[str]:
    """Break `text` to fit `width`, honouring CJK and Latin word rules.

    CJK breaks between any two characters; Latin must break at spaces or the words
    come apart mid-word. A wrapper that only splits on spaces leaves a 40-character
    Chinese paragraph as one unbreakable line that silently overflows the page.
    """
    lines: list[str] = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        line = ""
        for token in tokenize(para):
            candidate = line + token
            if line and face.width(candidate.rstrip(), size) > width:
                lines.append(line.rstrip())
                line = token.lstrip() if not is_cjk(token[0]) else token
            else:
                line = candidate
        lines.append(line.rstrip())
    return lines


def tokenize(text: str) -> list[str]:
    """Split into pieces a line may break BEFORE: CJK chars, and Latin words."""
    out: list[str] = []
    buf = ""
    for ch in text:
        if is_cjk(ch):
            if buf:
                out.append(buf)
                buf = ""
            out.append(ch)
        elif ch == " ":
            buf += ch
            out.append(buf)
            buf = ""
        else:
            buf += ch
    if buf:
        out.append(buf)
    return out


def embed(page, alias: str, face: Typeface) -> None:
    """Put the real font bytes in the page's resources under `alias`."""
    page.insert_font(fontname=alias, fontbuffer=face.font.buffer)


def font_report(doc, face: Typeface, text: str) -> dict:
    """What a reader on another machine will actually get."""
    fonts = []
    for i in range(doc.page_count):
        # get_fonts yields 7 items in PyMuPDF 1.27 (a trailing xref) and 6 in older
        # ones; take the documented prefix so a version bump does not crash this.
        for entry in doc[i].get_fonts(full=True):
            xref, ext, ftype, basefont, alias, encoding = entry[:6]
            fonts.append({"page": i + 1, "basefont": basefont, "alias": alias,
                          "type": ftype, "encoding": encoding,
                          # 'n/a' means the file only NAMES a font and relies on the
                          # reader having it. That is the tofu case.
                          "embedded": ext != "n/a", "file_ext": ext})
    return {"typeface": face.name, "source": face.source,
            "all_embedded": all(f["embedded"] for f in fonts) if fonts else False,
            "fonts": fonts,
            "missing_glyphs": face.missing_glyphs(text)}
