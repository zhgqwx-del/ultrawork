#!/usr/bin/env python3
"""Font embedding, glyph coverage and line breaking for PDF generation.

This is the half of P13/P14 that decides whether generated Chinese is readable on
anyone else's machine.

    a font the reader must already own -> the file only NAMES it
    a TrueType face registered here    -> the bytes travel, subset, inside the file

Only the second travels. The first renders correctly here and turns into empty
boxes on a machine without that face, which is the exact failure a "generate a PDF"
capability must not ship.

THE ONE EXCEPTION, stated rather than discovered later: the 14 standard PDF faces
(Helvetica, Courier, Times…) are not embedded and do not need to be — every
conforming reader is required to have them. `--font helv` therefore produces a
portable document that carries no font bytes, and the report says `embedded: false`
without calling it a defect. Any other name is a file path, and a file path is
embedded or the run fails.

Embedding a CJK face costs megabytes, so reportlab subsets it to the glyphs
actually used — measured 66,933,080 bytes of Songti.ttc down to a 16KB document,
still embedded, text still extractable.

Coverage is checked BEFORE writing, because a glyph the font does not have raises
nothing anywhere: `missing_glyphs` is the only place that failure is visible.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import fail  # noqa: E402
from pdffont import (STANDARD, available_candidates, has_cjk,  # noqa: E402,F401
                     missing_glyphs, register_cjk, wrap as _wrap)

# The abbreviations an AcroForm /DA uses, plus reportlab's own spellings. Accepting
# a name from here means a Latin-only document does not have to hunt for a CJK face
# it will never draw — and it means the coverage check can be exercised on every
# platform instead of only where a system font happens to live.
BUILTIN_FONTS = tuple(sorted(set(STANDARD) | set(STANDARD.values())))


class Typeface:
    """One font plus the two questions the layout keeps asking it."""

    def __init__(self, spec: Path | str | None = None):
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont

        if spec is None:
            name, source = register_cjk()
            if name is None:
                tried = ", ".join(available_candidates()) or "(none for this platform)"
                fail(f"no CJK font could be found on this machine, so any Chinese in "
                     f"the document would be drawn as blanks. Tried: {tried}. Pass "
                     f"--font with a TrueType path, or one of the standard names "
                     f"({', '.join(BUILTIN_FONTS)}) for a Latin-only document.")
            self.name, self.source, self.embedded = name, source, True
            return

        if Path(spec).is_file():
            # Checked BEFORE the built-in names on purpose: a real file named `helv`
            # in the working directory is what the caller meant, not the standard face.
            for index in (None, 0):
                registered = f"uwf-{Path(spec).stem}-{index}"
                try:
                    font = (TTFont(registered, str(spec)) if index is None else
                            TTFont(registered, str(spec), subfontIndex=index))
                    pdfmetrics.registerFont(font)
                except Exception:  # noqa: BLE001 - TTFError for CFF outlines, OSError…
                    continue
                self.name, self.source, self.embedded = registered, str(spec), True
                return
            fail(f"{Path(spec).name} is not a usable font file: it must be TrueType "
                 f"(a .ttf, or a .ttc whose first face is TrueType). PostScript/CFF "
                 f"outlines cannot be embedded.")

        standard = STANDARD.get(str(spec).strip().lstrip("/").lower().replace(" ", ""))
        if standard is None and str(spec) in BUILTIN_FONTS:
            standard = str(spec)
        if standard is None:
            fail(f"--font {spec}: no such file, and not one of the standard names "
                 f"({', '.join(BUILTIN_FONTS)})")
        try:
            pdfmetrics.getFont(standard)
        except Exception:  # noqa: BLE001
            fail(f"--font {spec}: {standard} is not available to this reportlab build")
        # Not embedded, and that is fine — see the module docstring.
        self.name, self.source, self.embedded = standard, f"standard face {standard!r}", False

    def width(self, text: str, size: float) -> float:
        from reportlab.pdfbase import pdfmetrics
        return pdfmetrics.stringWidth(text, self.name, size)

    def missing_glyphs(self, text: str) -> list[str]:
        """Characters this font cannot draw, in first-seen order, deduplicated."""
        return missing_glyphs(self.name, text)


def wrap(text: str, face: Typeface, size: float, width: float) -> list[str]:
    """Break `text` to fit `width`, honouring CJK and Latin word rules."""
    return _wrap(text, face.name, size, width)


def font_report(out: Path, face: Typeface, text: str) -> dict:
    """What a reader on another machine will actually get.

    Read back out of the WRITTEN FILE, not from what the writer meant to do. The
    failure being guarded against is precisely a writer that believes it embedded a
    font and did not, and asking the writer would agree with it.
    """
    from pypdf import PdfReader

    fonts = []
    reader = PdfReader(str(out))
    for number, page in enumerate(reader.pages, 1):
        resources = page.get("/Resources") or {}
        for alias, ref in (resources.get("/Font") or {}).items():
            node = ref.get_object()
            descendants = node.get("/DescendantFonts")
            holder = (descendants[0].get_object() if descendants else node)
            descriptor = holder.get("/FontDescriptor")
            descriptor = descriptor.get_object() if descriptor is not None else {}
            files = [k for k in ("/FontFile", "/FontFile2", "/FontFile3")
                     if k in descriptor]
            basefont = str(node.get("/BaseFont") or "").lstrip("/")
            fonts.append({"page": number, "basefont": basefont, "alias": str(alias),
                          "type": str(node.get("/Subtype") or "").lstrip("/"),
                          "encoding": str(node.get("/Encoding") or "").lstrip("/"),
                          # False means the file only NAMES a font and relies on the
                          # reader having it. That is the tofu case — unless the name
                          # is one of the standard 14, which every reader must have.
                          "embedded": bool(files),
                          "standard_14": basefont.split("+")[-1] in set(STANDARD.values()),
                          "file_ext": files[0].lstrip("/") if files else "n/a"})
    return {"typeface": face.name, "source": face.source,
            "all_embedded": all(f["embedded"] for f in fonts) if fonts else False,
            "portable": all(f["embedded"] or f["standard_14"] for f in fonts)
            if fonts else False,
            "fonts": fonts,
            "missing_glyphs": face.missing_glyphs(text)}
