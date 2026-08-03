#!/usr/bin/env python3
"""Finding a CJK-capable font, and measuring text with it.

This exists because moving off PyMuPDF removed a font. PyMuPDF ships Droid Sans
Fallback — a 3.4 MB embeddable CJK face — and the pdf skill used it for two things:
measuring how wide a string would be, and embedding glyphs into a generated
document. Neither reportlab nor pypdf nor PDFium supplies a CJK font.

The answer is NOT to bundle one (≈10 MB into a 3.2 MB skill tree) and NOT to use
reportlab's built-in CID fonts, which are not embedded and therefore render only on
a machine that already has the typeface — precisely the failure P14 exists to
prevent. Instead: find one on the generating machine and EMBED it, subsetted, into
the output. The output stays portable; only the machine doing the generating needs
a font.

⚠️ Two things measured on macOS 2026-08-02 that a naive search gets wrong:

  * the first candidate found is not necessarily usable. `Hiragino Sans GB.ttc` has
    PostScript (CFF) outlines and reportlab refuses it outright. A search that stops
    at the first existing path fails on the most common Mac.
  * a .ttc needs a subfont index, and the useful face is not always index 0.

So candidates are TRIED, not merely located, and the first one that actually
registers wins. When none does, callers refuse loudly rather than silently emitting
a document with no glyphs — a PDF written with a font that lacks the characters is
not tofu, it is a blank page (measured, see pdf_create.py).
"""
from __future__ import annotations

import hashlib
import platform
from pathlib import Path

# Per-platform CJK faces, best first. TrueType outlines only — CFF-outline .ttc
# files cannot be embedded by reportlab.
CANDIDATES = {
    "Darwin": [
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 0),
        ("/Library/Fonts/Arial Unicode.ttf", None),
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 1),
        ("/System/Library/Fonts/PingFang.ttc", 0),
    ],
    "Windows": [
        (r"C:\Windows\Fonts\msyh.ttc", 0),
        (r"C:\Windows\Fonts\simsun.ttc", 0),
        (r"C:\Windows\Fonts\msjh.ttc", 0),
        (r"C:\Windows\Fonts\simhei.ttf", None),
    ],
    "Linux": [
        ("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf", None),
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
        ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
        ("/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc", 0),
    ],
}

# A list of EXACT paths is a list that goes stale, and it goes stale silently: the
# skill says "no CJK font on this machine" on a machine that has one under a name
# nobody predicted. Measured on CI (ubuntu-latest with fonts-noto-cjk installed):
# every path above missed, because the package now ships the variable-font build
# `NotoSansCJK-VF.otf.ttc`, and four capabilities refused to run.
# So the exact list is a PREFERENCE order, and this is the fallback: look for
# anything CJK-shaped in the standard font trees. Globbing is second, not first,
# because the curated paths pick a face known to have TrueType outlines — reportlab
# cannot embed CFF ones (gotchas §21.1 ⑯) — and a glob may land on one that fails.
GLOB_ROOTS = {
    "Linux": ("/usr/share/fonts", "/usr/local/share/fonts"),
    "Darwin": ("/System/Library/Fonts", "/Library/Fonts"),
    "Windows": (r"C:\Windows\Fonts",),
}
# Substrings that mark a face as CJK-capable in every distribution's naming.
GLOB_HINTS = ("notosanscjk", "notoserifcjk", "sourcehansans", "sourcehanserif",
              "wqy", "droidsansfallback", "arphic", "uming", "ukai", "fandol",
              "msyh", "simsun", "simhei", "songti", "pingfang", "hiragino")


def _globbed_candidates() -> list[tuple[str, int | None]]:
    """Every CJK-looking font file under this platform's font trees, sorted."""
    out: list[tuple[str, int | None]] = []
    for root in GLOB_ROOTS.get(platform.system(), ()):
        base = Path(root)
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.suffix.lower() not in (".ttf", ".ttc", ".otf"):
                continue
            if not any(h in path.name.lower().replace("-", "").replace("_", "")
                       for h in GLOB_HINTS):
                continue
            # A .ttc holds several faces and the useful one is not always index 0
            # (gotchas §21.1 ⑯), so both are offered and `_try_register` decides.
            out += [(str(path), None), (str(path), 0)] if path.suffix.lower() == ".ttc" \
                else [(str(path), None)]
    return out

# Ideographs AND the punctuation/fullwidth blocks that travel with them. A string
# whose only non-Latin character is a fullwidth comma still needs the CJK face —
# Helvetica has no glyph for U+FF0C either, and the blank it draws raises nothing.
# These are also the characters a line may break BEFORE, which is why `tokenize`
# reads the same table.
CJK_RANGES = ((0x2E80, 0x2EFF), (0x3000, 0x303F), (0x3400, 0x4DBF),
              (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0xFF00, 0xFF60),
              (0x20000, 0x2A6DF))
_REGISTERED: dict[str, str] = {}


def is_cjk(ch: str) -> bool:
    return any(a <= ord(ch) <= b for a, b in CJK_RANGES)


def has_cjk(s: str) -> bool:
    return any(is_cjk(c) for c in s)


def _try_register(name: str, path: str, index: int | None) -> bool:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    try:
        font = TTFont(name, path) if index is None else \
            TTFont(name, path, subfontIndex=index)
        pdfmetrics.registerFont(font)
        return True
    except Exception:  # noqa: BLE001 - TTFError for CFF outlines, OSError, ...
        return False


def register_cjk(explicit: str | None = None) -> tuple[str | None, str | None]:
    """Register a CJK face with reportlab. Returns (font_name, source_path).

    (None, None) when nothing usable was found — the caller decides what to do, and
    every caller in this skill refuses rather than writing a document it knows will
    come out blank.
    """
    key = explicit or "auto"
    if key in _REGISTERED:
        return _REGISTERED[key], _SOURCES.get(key)
    tries: list[tuple[str, int | None]] = []
    if explicit:
        # An explicit --font may be a .ttc, so index 0 is tried as well as no index.
        tries = [(explicit, None), (explicit, 0)]
    else:
        tries = [(p, i) for p, i in CANDIDATES.get(platform.system(), [])
                 if Path(p).is_file()]
        # Curated paths first, then anything CJK-shaped the machine actually has.
        # Without this the skill reports "no CJK font on this machine" on machines
        # that have several — measured on CI, see GLOB_HINTS.
        tries += [t for t in _globbed_candidates() if t not in tries]
    for path, index in tries:
        # A STABLE name: this ends up as the /BaseFont of the embedded subset, and
        # hash() is salted per process, so a random one would make two runs of the
        # same command produce different bytes for no reason.
        digest = hashlib.sha1(f"{path}#{index}".encode()).hexdigest()[:8]
        name = f"cjk-{digest}"
        if _try_register(name, path, index):
            _REGISTERED[key] = name
            _SOURCES[key] = path
            return name, path
    return None, None


_SOURCES: dict[str, str] = {}


def available_candidates() -> list[str]:
    """Paths this platform would try, for an error message worth acting on.

    The curated list plus whatever the glob found, so "no CJK font" names both what
    was expected and what is actually installed — an error listing only paths that
    do not exist tells the reader nothing about their own machine.
    """
    curated = [p for p, _ in CANDIDATES.get(platform.system(), [])]
    found = [p for p, _ in _globbed_candidates()]
    return curated + [p for p in dict.fromkeys(found) if p not in curated]


def text_width(text: str, font: str | None, size: float) -> float | None:
    """Natural width of `text` at `size`, or None when no font could be resolved.

    None is not zero. A width of zero would say "it fits", which is the wrong answer
    to give when the question could not be answered at all.
    """
    from reportlab.pdfbase import pdfmetrics
    if has_cjk(text):
        name, _ = register_cjk()
        if name is None:
            return None
        try:
            return pdfmetrics.stringWidth(text, name, size)
        except Exception:  # noqa: BLE001
            return None
    for candidate in (_standard_name(font), "Helvetica"):
        if not candidate:
            continue
        try:
            return pdfmetrics.stringWidth(text, candidate, size)
        except Exception:  # noqa: BLE001 - unmapped font name
            continue
    return None


# The 14 standard PDF faces, under the abbreviations an AcroForm /DA uses.
STANDARD = {"helv": "Helvetica", "hebo": "Helvetica-Bold", "heit": "Helvetica-Oblique",
            "cour": "Courier", "cobo": "Courier-Bold", "tiro": "Times-Roman",
            "tibo": "Times-Bold", "tiit": "Times-Italic", "symb": "Symbol",
            "zadb": "ZapfDingbats"}


def resolve(text: str, requested: str | None = None) -> str | None:
    """The reportlab font name to DRAW `text` with, or None if there is none.

    CJK wins over the request: a /DA naming Helv is not a claim that the value is
    Latin, it is what the form's author wrote before anyone typed Chinese into it.
    Honouring it would emit a byte the face has no glyph for, which is a blank on
    the page and an error nowhere.
    """
    if has_cjk(text):
        name, _ = register_cjk()
        return name
    return _standard_name(requested) or "Helvetica"


def missing_glyphs(font: str, text: str) -> list[str]:
    """Characters `font` cannot draw, first-seen order, deduplicated.

    A glyph a font lacks is drawn as a blank or a box and raises nothing anywhere,
    so this is the only place that failure is visible before the file is written.
    """
    from reportlab.pdfbase import pdfmetrics
    face = pdfmetrics.getFont(font).face
    table = getattr(face, "charToGlyph", None)
    seen, out = set(), []
    for ch in text:
        if ch in seen or ch in "\n\r\t":
            continue
        seen.add(ch)
        if table is not None:
            if ord(ch) not in table:
                out.append(ch)
            continue
        try:                       # a standard-14 face: WinAnsi is all it can say
            ch.encode("cp1252")
        except UnicodeEncodeError:
            out.append(ch)
    return out


def tokenize(text: str) -> list[str]:
    """Split into pieces a line may break BEFORE: CJK characters, and Latin words."""
    out: list[str] = []
    buf = ""
    for ch in text:
        if is_cjk(ch):
            if buf:
                out.append(buf)
                buf = ""
            out.append(ch)
        elif ch == " ":
            out.append(buf + ch)
            buf = ""
        else:
            buf += ch
    if buf:
        out.append(buf)
    return out


def wrap(text: str, font: str, size: float, width: float) -> list[str]:
    """Break `text` to fit `width`, honouring CJK and Latin word rules.

    CJK breaks between any two characters; Latin must break at spaces or words come
    apart mid-word. A wrapper that only splits on spaces leaves a 40-character
    Chinese paragraph as one unbreakable line that silently overflows.
    """
    from reportlab.pdfbase import pdfmetrics
    lines: list[str] = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        line = ""
        for token in tokenize(para):
            candidate = line + token
            if line and pdfmetrics.stringWidth(candidate.rstrip(), font, size) > width:
                lines.append(line.rstrip())
                line = token.lstrip(" ")
            else:
                line = candidate
        lines.append(line.rstrip())
    return lines


def _standard_name(font: str | None) -> str | None:
    if not font:
        return None
    key = font.strip().lstrip("/").lower().replace(" ", "")
    if key in STANDARD:
        return STANDARD[key]
    # Already a reportlab name?
    from reportlab.pdfbase import pdfmetrics
    try:
        pdfmetrics.getFont(font)
        return font
    except Exception:  # noqa: BLE001
        return None
