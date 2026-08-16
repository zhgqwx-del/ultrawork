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

So candidates are TRIED, not merely located. When none registers, callers refuse
loudly rather than silently emitting a document with no glyphs — a PDF written with
a font that lacks the characters is not tofu, it is a blank page (measured, see
pdf_create.py).

⚠️ A third thing, measured on macOS 2026-08-06 after a generated report came back
"all bold": REGISTERING IS NOT THE SAME AS BEING SUITABLE. The line above used to
say "the first one that actually registers wins", and on this platform the first
one is `Songti.ttc` face 0 = **STSongti-SC-Black** — the heaviest weight in the
file. One face draws the whole document, so body text got a display weight, and
nothing anywhere said so. Worse, of that file's eight faces it is the ONLY one with
no U+2022, so every bullet the layout drew came out as .notdef: a blank on the page,
`\\x00` in the text layer, and no error. Face order inside a .ttc is not stable
across OS releases, so the fix is not "use index 6": faces are ranked by what the
font SAYS ABOUT ITSELF (`_is_heavy`), and a text weight beats a display weight
wherever it is found.
"""
from __future__ import annotations

import hashlib
import platform
from pathlib import Path

# Per-platform CJK faces, best first. TrueType outlines only — CFF-outline .ttc
# files cannot be embedded by reportlab.
#
# The indices are a PREFERENCE HINT, not the mechanism: `_is_heavy` is what keeps a
# display weight out of body text, because .ttc face order changes between OS
# releases and a list of indices goes stale silently. Measured on macOS 15
# (darwin 24.6), Songti.ttc: 0=SC-Black 1=SC-Bold 2=TC-Bold 3=SC-Light 4=STSong
# 5=TC-Light 6=SC-Regular 7=TC-Regular.
CANDIDATES = {
    "Darwin": [
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 6),   # SC-Regular
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 4),   # STSong
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 3),   # SC-Light
        ("/Library/Fonts/Arial Unicode.ttf", None),
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 0),   # SC-Black, last
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

# Weight words a face uses to name itself. One face draws the entire document, so a
# display weight there is a display weight for BODY text — a last resort, never a
# first choice. Matched against the font's own name table rather than its position
# in a .ttc, because position is not stable across OS releases.
HEAVY_WORDS = ("black", "heavy", "ultra", "extrabold", "extralight", "semibold",
               "demibold", "bold")

# A marker word that means "this face is the bold companion of another one", ranked
# ahead of the display weights: pairing Regular with Bold is a legible contrast,
# pairing it with Black is a shout.
BOLD_WORDS = ("bold", "semibold", "demibold")


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


def _stable_name(path: str, index: int | None, prefix: str = "cjk") -> str:
    """A STABLE reportlab name for (path, index).

    This ends up as the /BaseFont of the embedded subset, and hash() is salted per
    process, so a random one would make two runs of the same command produce
    different bytes for no reason.
    """
    digest = hashlib.sha1(f"{path}#{index}".encode()).hexdigest()[:8]
    return f"{prefix}-{digest}"


def face_name(registered: str) -> str:
    """What a registered face calls itself, as text.

    reportlab keeps `face.name` as bytes for a TrueType face and as str for the
    standard 14; both reach this and both have to come back comparable.
    """
    from reportlab.pdfbase import pdfmetrics
    try:
        raw = getattr(pdfmetrics.getFont(registered).face, "name", "") or ""
    except Exception:  # noqa: BLE001 - not registered
        return ""
    return raw.decode("latin-1", "replace") if isinstance(raw, bytes) else str(raw)


def _squash(name: str) -> str:
    return name.lower().replace("-", "").replace("_", "").replace(" ", "")


def _is_heavy(name: str) -> bool:
    """Does this face's own name declare a display/bold weight?"""
    return any(word in _squash(name) for word in HEAVY_WORDS)


def register_cjk(explicit: str | None = None) -> tuple[str | None, str | None]:
    """Register a CJK face with reportlab. Returns (font_name, source_path).

    (None, None) when nothing usable was found — the caller decides what to do, and
    every caller in this skill refuses rather than writing a document it knows will
    come out blank.

    A face that registers is not therefore the right one to set a whole document in:
    the first candidate on macOS is Songti's BLACK weight (see the module docstring).
    So candidates are ranked — a text weight wins outright, a display weight is only
    remembered in case nothing lighter turns up — and `chosen_is_heavy()` lets the
    caller report that it had to settle.
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

    fallback: tuple[str, str, int | None] | None = None
    for path, index in tries:
        name = _stable_name(path, index)
        if not _try_register(name, path, index):
            continue
        if _is_heavy(face_name(name)):
            # Usable, but it would set body text in a display weight. Keep looking;
            # come back to it only if nothing lighter registers at all.
            if fallback is None:
                fallback = (name, path, index)
            continue
        _REGISTERED[key], _SOURCES[key], _INDEXES[key] = name, path, index
        return name, path
    if fallback is not None:
        name, path, index = fallback
        _REGISTERED[key], _SOURCES[key], _INDEXES[key] = name, path, index
        _HEAVY_FALLBACK.add(key)
        return name, path
    return None, None


def chosen_is_heavy(explicit: str | None = None) -> bool:
    """True when the only face that registered was a display weight.

    Reported rather than hidden: the document is still readable, but every line of
    it is set heavier than it should be, and that is a fact about the OUTPUT the
    caller is entitled to pass on.
    """
    return (explicit or "auto") in _HEAVY_FALLBACK


def register_bold(explicit: str | None = None) -> str | None:
    """A heavier companion for the chosen text face, or None if the file has none.

    Headings distinguished only by SIZE are what a single-face document can manage,
    and it reads flat — measured on a real report where h1/h2/h3 came out at
    20.9/16.5/13.8pt of the same weight. A .ttc usually carries the whole family, so
    the companion is looked for among the sibling faces of the very file already
    chosen: same design, same metrics, no second font to find.

    Bold is preferred over Black: pairing Regular with Bold is a contrast, pairing it
    with Black is a shout. A single-face .ttf simply has no companion, and that is
    reported as None rather than faked with a synthetic bold — reportlab would happily
    smear the outlines, and a smeared CJK glyph is worse than no contrast at all.
    """
    key = explicit or "auto"
    if key in _BOLD:
        return _BOLD[key]
    _BOLD[key] = None                       # remember "looked, found nothing" too
    source = _SOURCES.get(key)
    if source is None or not source.lower().endswith(".ttc"):
        return None
    primary = _squash(face_name(_REGISTERED.get(key, "")))
    best: tuple[int, str] | None = None
    for index in range(16):
        if index == _INDEXES.get(key):
            continue
        name = _stable_name(source, index, prefix="cjkb")
        if not _try_register(name, source, index):
            break                           # past the last face in the collection
        candidate = face_name(name)
        if not _is_heavy(candidate):
            continue
        squashed = _squash(candidate)
        # Same family (STSongti-SC-Regular -> STSongti-SC-Bold, not the -TC- one)
        # beats a different one; Bold beats Black.
        score = (2 if _family(squashed) == _family(primary) else 0) + \
                (1 if any(w in squashed for w in BOLD_WORDS) else 0)
        if best is None or score > best[0]:
            best = (score, name)
    _BOLD[key] = best[1] if best else None
    return _BOLD[key]


def _family(squashed: str) -> str:
    """Everything up to the weight word — the part two siblings share."""
    for word in sorted(HEAVY_WORDS + ("regular", "light", "medium"), key=len,
                       reverse=True):
        cut = squashed.find(word)
        if cut > 0:
            return squashed[:cut]
    return squashed


_SOURCES: dict[str, str] = {}
_INDEXES: dict[str, int | None] = {}
_BOLD: dict[str, str | None] = {}
_HEAVY_FALLBACK: set[str] = set()


def available_candidates() -> list[str]:
    """Paths this platform would try, for an error message worth acting on.

    The curated list plus whatever the glob found, so "no CJK font" names both what
    was expected and what is actually installed — an error listing only paths that
    do not exist tells the reader nothing about their own machine.
    """
    curated = [p for p, _ in CANDIDATES.get(platform.system(), [])]
    found = [p for p, _ in _globbed_candidates()]
    return curated + [p for p in dict.fromkeys(found) if p not in curated]


def rejected_candidates() -> list[str]:
    """CJK fonts that ARE installed and that reportlab still cannot use.

    Measured on CI: a runner with 61 MB of Noto Sans CJK installed was told "no CJK
    font could be found on this machine". That message is false and it sends the
    reader to install another copy of the font they already have. The real reason is
    narrower — Noto Sans CJK carries CFF/PostScript outlines and reportlab embeds
    TrueType only (gotchas §21.1 ⑯) — so a caller needs to hear THAT, not a list of
    paths that do not exist on their disk.
    """
    out = []
    for path, index in _globbed_candidates():
        if path in out:
            continue
        if not _try_register(f"probe-{len(out)}", path, index):
            out.append(path)
    return out


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


# 行首/行尾禁则. CJK text may break between any two characters — which is what
# tokenize() encodes — but NOT every pair is a legal break. Closing punctuation may
# not open a line and opening punctuation may not close one. A Chinese reader sees
# "，销售费用率因…" at the head of a line as a typesetting error, and it is one.
#
# Measured on this implementation before the rule existed: 57 of 823 lines (6.9%) in
# a four-paragraph report, and at least one violation at 40 of the 80 column widths
# tried. It survived this long because both shipped fixtures happen to break
# elsewhere — the defect was in every generated document, and in none of the tests.
#
# Straight quotes are deliberately absent from both sets: `"` and `'` open and close
# alike, so no rule about them can be right in both directions, and tokenize() keeps
# them welded to their Latin word anyway.
NO_LINE_START = ("，。、；：？！．,.;:?!"        # terminators and separators
                 "）］｝〉》」』〕】〗)]}"      # closing brackets
                 "”’"                           # closing quotes
                 "%‰℃°")                        # units that trail a number
NO_LINE_END = ("（［｛〈《「『〔【〖([{"        # opening brackets
               "“‘")                            # opening quotes


def _kinsoku(tokens: list[str], font: str, size: float, width: float) -> list[str]:
    """Weld tokens so no line can START with closing punctuation or END with opening.

    Push-out (押出し): the punctuation stays attached to the character it belongs to
    and the pair moves down together. Hanging it past the margin is the other legal
    answer and is not used here — a column that sometimes overhangs is hard to tell
    from a real overflow, and this skill's own checks read overflow off the page.

    ⚠️ The escape hatch matters more than the rule. A welded run wider than the whole
    column can never fit on any line, and forcing it would push text past the margin
    — trading a typographic fault for a visible one. Such a run is handed back
    unwelded and the line breaks where it must; narrow table cells are why.
    """
    from reportlab.pdfbase import pdfmetrics
    groups: list[list[str]] = []
    for tok in tokens:
        # The last VISIBLE character of the whole group, not of its last token.
        # tokenize() emits a bare " " for a space following a CJK character, so an
        # opening bracket welds to that space, the space rstrips to nothing, and the
        # chain ends having achieved exactly nothing — 「…転合（」 still closes the
        # line. Found by fuzzing; the fixture has no bracket-then-space, so G10 was
        # green throughout.
        prev = "".join(groups[-1]).rstrip() if groups else ""
        # Both tests are guarded against the empty string: `"" in NO_LINE_START` is
        # True for every set, which would weld the whole paragraph into one token.
        starts_closed = bool(tok) and tok[0] in NO_LINE_START
        ends_open = bool(prev) and prev[-1] in NO_LINE_END
        if groups and (starts_closed or ends_open):
            groups[-1].append(tok)
        else:
            groups.append([tok])
    out: list[str] = []
    for group in groups:
        joined = "".join(group)
        if len(group) > 1 and \
                pdfmetrics.stringWidth(joined.rstrip(), font, size) > width:
            out.extend(group)
        else:
            out.append(joined)
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

    "Between any two characters" is nearly right and visibly wrong at the edges:
    `_kinsoku` removes the breaks that would leave a closing mark at the head of a
    line or an opening one at its foot.
    """
    from reportlab.pdfbase import pdfmetrics
    lines: list[str] = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        line = ""
        for token in _kinsoku(tokenize(para), font, size, width):
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
