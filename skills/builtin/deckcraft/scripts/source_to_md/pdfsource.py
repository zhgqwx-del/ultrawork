#!/usr/bin/env python3
"""The PDF reading layer for deckcraft's source_to_md (ultrawork, self-written).

WHY THIS FILE EXISTS
--------------------
``pdf_to_md.py`` was built on PyMuPDF (``import fitz``). PyMuPDF is AGPL-3.0 or a
paid commercial licence, and ``skills/builtin/`` ships inside the product — a
licence a commercial product cannot carry without buying it (059 §5·补.8c). This
module answers the same questions out of permissively licensed libraries:

    pdfplumber  (MIT, wraps pdfminer.six)  text geometry, tables, vector drawings
    pypdf       (BSD-3)                    encoded image payloads
    pypdfium2   (Apache-2.0/BSD-3)         rasterising a page region

It deliberately mimics the small slice of the PyMuPDF surface that
``pdf_to_md.py`` actually used — ``Rect``, ``page.get_text("dict")``,
``page.get_drawings()``, ``page.find_tables()``. That shape is a choice, not
laziness: keeping the 1100 lines of conversion logic byte-identical is what makes
the swap reviewable, because any change in the Markdown then has exactly one
possible cause, this file.

THE FOUR THINGS THAT ARE NOT A DIRECT TRANSLATION
-------------------------------------------------
1. **Bold/italic came from a bit field that no longer exists.** PyMuPDF handed
   over ``span["flags"]`` with bold at bit 4 and italic at bit 1. pdfplumber has
   no such field — only the font's name. See ``font_flags``.
2. **Subset prefixes.** pdfplumber reports ``AAAAAA+HelveticaNeue-Bold`` where
   PyMuPDF reported ``HelveticaNeue-Bold``. Left in place, every name test in the
   caller (bold, italic, monospace) still works by substring, but the tag leaks
   into anything that compares names — so it is stripped once, here.
3. **Kangxi radicals.** pdfminer returns what the font's ToUnicode map says, and
   Chrome's print-to-PDF maps a good deal of Chinese onto the Kangxi Radical
   block: ``力`` (U+529B) arrives as ``⼒`` (U+2F12). They look identical and are
   not equal, so search, diffing and any downstream model see different text.
   PyMuPDF folded these silently. See ``normalize_glyphs``.
4. **One block per line.** PyMuPDF grouped lines into paragraph blocks; pdfplumber
   has no equivalent and reproducing MuPDF's clustering by guesswork would create
   differences of its own. Each line is therefore its own block. The caller uses
   blocks for two things and both survive: the table-overlap test gets finer and
   safer, and the block-level noise test collapses onto the line-level one it
   already ran right after. (PyMuPDF's two noise tests never agreed on multi-line
   blocks anyway — one joined lines with "\\n" and the other with "", so nothing
   with a line break in it could match either way.)
"""
from __future__ import annotations

import logging
import re
import unicodedata
from pathlib import Path


def _quiet_pdfminer() -> None:
    """Stop pdfminer narrating every incomplete font descriptor to stdout.

    ⚠️ Measured, not guessed: converting the 10-page example deck printed
    "Could not get FontBBox from font descriptor because None cannot be parsed as
    4 floats" **168 times** — 172 lines and 14.7 KB of output where the PyMuPDF
    build printed 4 lines. Chrome's print-to-PDF writes Type3 fonts with no
    FontBBox, so the warning fires once per embedded face and says nothing the
    caller can act on.

    That is not merely untidy. These scripts run under an agent, and in Team mode
    their stdout crosses the delegation boundary — every one of those lines is
    context spent on a message that means "this PDF is normal".

    Scoped to pdfminer's own logger and raised to ERROR rather than disabled, so a
    real failure still speaks. Called from `Document.__init__` rather than at
    import time: a module that reconfigures logging just for being imported is a
    surprise to whatever imports it.
    """
    logging.getLogger("pdfminer").setLevel(logging.ERROR)

# ── geometry ──────────────────────────────────────────────────────────────────
# Every box in this module and in pdf_to_md.py is (x0, y0, x1, y1) in DISPLAY
# space with a top-left origin and y growing downwards — the frame pdfplumber
# reports and the one a rendered image uses. The PDF's own bottom-left origin
# appears in exactly one place, `Page.render_clip`, and is converted there.


class Rect:
    """The slice of ``fitz.Rect`` the converter uses: union, intersection, area.

    Kept as a real class rather than a tuple because the caller mutates ``.y1``
    in place (clipping a figure crop to sit above its caption) and relies on
    ``|=`` to accumulate a bounding box.
    """

    __slots__ = ("x0", "y0", "x1", "y1")

    def __init__(self, *args):
        if len(args) == 1:
            a = args[0]
            vals = (a.x0, a.y0, a.x1, a.y1) if isinstance(a, Rect) else tuple(a)
        elif len(args) == 4:
            vals = args
        else:
            raise TypeError(f"Rect takes a box or four numbers, got {args!r}")
        if len(vals) != 4:
            raise TypeError(f"Rect needs four numbers, got {vals!r}")
        self.x0, self.y0, self.x1, self.y1 = (float(v) for v in vals)

    @property
    def width(self) -> float:
        return max(0.0, self.x1 - self.x0)

    @property
    def height(self) -> float:
        return max(0.0, self.y1 - self.y0)

    @property
    def is_empty(self) -> bool:
        return self.x1 <= self.x0 or self.y1 <= self.y0

    def get_area(self) -> float:
        return self.width * self.height

    def __and__(self, other: "Rect") -> "Rect":
        """Intersection. A disjoint pair gives an empty rect, never a negative one."""
        other = other if isinstance(other, Rect) else Rect(other)
        x0, y0 = max(self.x0, other.x0), max(self.y0, other.y0)
        x1, y1 = min(self.x1, other.x1), min(self.y1, other.y1)
        if x1 <= x0 or y1 <= y0:
            return Rect(x0, y0, x0, y0)
        return Rect(x0, y0, x1, y1)

    def __or__(self, other: "Rect") -> "Rect":
        other = other if isinstance(other, Rect) else Rect(other)
        return Rect(min(self.x0, other.x0), min(self.y0, other.y0),
                    max(self.x1, other.x1), max(self.y1, other.y1))

    def __ior__(self, other: "Rect") -> "Rect":
        return self | other

    def intersects(self, other: "Rect") -> bool:
        return not (self & other).is_empty

    def __iter__(self):
        return iter((self.x0, self.y0, self.x1, self.y1))

    def __getitem__(self, i):
        return (self.x0, self.y0, self.x1, self.y1)[i]

    def __eq__(self, other):
        try:
            return tuple(self) == tuple(Rect(other))
        except (TypeError, AttributeError):
            return NotImplemented

    def __repr__(self):
        return f"Rect({self.x0:g}, {self.y0:g}, {self.x1:g}, {self.y1:g})"


# ── text: fonts and glyphs ────────────────────────────────────────────────────
SUBSET_TAG_RE = re.compile(r"^[A-Z]{6}\+")

# PyMuPDF's span["flags"] bit field. Only these two were ever read by the
# converter (bold for headings and **markers**, italic for *markers*); the rest
# of the field — superscript, serif, monospace — it either ignored or answered
# from the font name instead, which is why only these two need reproducing.
FLAG_ITALIC = 2
FLAG_BOLD = 16

_ITALIC_MARKERS = ("italic", "oblique")

# Kangxi Radicals (U+2F00..U+2FD5). Every codepoint here has an NFKC
# decomposition onto the ordinary ideograph it draws (U+2F12 ⼒ -> U+529B 力),
# which is exactly the wanted fold. Applying NFKC to the WHOLE string is not:
# it also rewrites ①->1, ％->%, Ａ->A and ﬁ->fi, none of which the document asked
# for. So the fold is applied per character, only inside this block.
_KANGXI_RANGE = (0x2F00, 0x2FD5)

# CJK Radicals Supplement (U+2E80..U+2EF3) is the awkward half: none of its 113
# codepoints has an NFKC decomposition, so the same trick does nothing and the
# lookalikes survive (measured: ⻅ ⻓ ⻛ came through untouched into the deck).
#
# Most of this block is COMPONENT forms — ⺅ is the left-hand form of 人, ⻌ of
# 辶, 纟/讠/钅/饣 are radicals you never type as words — and folding those onto a
# character would assert something the document did not say. What Chrome's
# ToUnicode actually emits, and all that is folded here, is the subset that is a
# standalone simplified character in its own right. Mappings follow Unicode's
# CJKRadicals.txt; the J-simplified (Japanese) forms are left alone for the same
# reason the components are.
_RADICAL_SUPPLEMENT = {
    "⻅": "见",  # ⻅ -> 见
    "⻆": "角",  # ⻆ -> 角
    "⻉": "贝",  # ⻉ -> 贝
    "⻋": "车",  # ⻋ -> 车
    "⻓": "长",  # ⻓ -> 长
    "⻔": "门",  # ⻔ -> 门
    "⻙": "韦",  # ⻙ -> 韦
    "⻚": "页",  # ⻚ -> 页
    "⻛": "风",  # ⻛ -> 风
    "⻜": "飞",  # ⻜ -> 飞
    "⻢": "马",  # ⻢ -> 马
    "⻥": "鱼",  # ⻥ -> 鱼
    "⻦": "鸟",  # ⻦ -> 鸟
    "⻧": "卤",  # ⻧ -> 卤
    "⻨": "麦",  # ⻨ -> 麦
    "⻩": "黄",  # ⻩ -> 黄
    "⻪": "黾",  # ⻪ -> 黾
    "⻬": "齐",  # ⻬ -> 齐
    "⻮": "齿",  # ⻮ -> 齿
    "⻰": "龙",  # ⻰ -> 龙
}


def _is_kangxi(ch: str) -> bool:
    return _KANGXI_RANGE[0] <= ord(ch) <= _KANGXI_RANGE[1]


def normalize_glyphs(text: str) -> str:
    """Fold radical-block codepoints onto the ideographs they are drawn as.

    Measured on ``examples/ai-coding-pilot/export/deck.pdf``: pdfminer reads
    ``压⼒``/``同⽐``/``⼈⼒``/``⼯具``/``⾏动``/``时⻓`` where the document means
    ``压力``/``同比``/``人力``/``工具``/``行动``/``时长``. Left alone these are
    lookalikes that compare unequal to anything a user types or searches for.
    """
    if not any(_is_kangxi(c) or c in _RADICAL_SUPPLEMENT for c in text):
        return text
    out = []
    for c in text:
        if _is_kangxi(c):
            out.append(unicodedata.normalize("NFKC", c))
        else:
            out.append(_RADICAL_SUPPLEMENT.get(c, c))
    return "".join(out)


def base_font_name(name: str) -> str:
    """``AAAAAA+HelveticaNeue-Bold`` -> ``HelveticaNeue-Bold``."""
    return SUBSET_TAG_RE.sub("", name or "")


def font_flags(name: str) -> int:
    """Reconstruct the bold/italic bits from the font's name.

    ⚠️ This is the one place where the answer is genuinely worse than PyMuPDF's,
    and the one place it is genuinely better — for different documents.

    WORSE: a face called ``Foo`` that is bold by its descriptor's ForceBold bit
    and says nothing in its name now reads as regular. The name is all pdfplumber
    exposes.

    BETTER, and this is the case the real corpus is made of: Chrome's
    print-to-PDF emits Chinese as Type3 fonts, which have no descriptor at all,
    so PyMuPDF reported flags=0 for every Chinese glyph in the deck — bold and
    regular alike. pdfminer resolves those same fonts to ``PingFangSC-Semibold``
    and ``PingFangSC-Thin``, so weight is recoverable here and was not there.

    ``semibold`` counts as bold. It is a bold-family weight, the substring test
    is the whole rule (no exclusion list to get out of sync), and the measured
    consequence on the real corpus is recorded in 059 §六·补四.
    """
    n = base_font_name(name).lower()
    flags = 0
    if "bold" in n:
        flags |= FLAG_BOLD
    if any(m in n for m in _ITALIC_MARKERS):
        flags |= FLAG_ITALIC
    return flags


# ── pages ─────────────────────────────────────────────────────────────────────
# Chars on one visual line share a text-matrix origin exactly, so lines are
# clustered on that number instead of on a y-tolerance. A tolerance has to be
# loose enough to hold a 10pt run and a 24pt run that sit on one baseline, and
# that is already loose enough to swallow the next line of a tight list.
# The matrix is in UNROTATED user space, so which of its two translation
# components is constant along a line depends on the page's /Rotate.
_BASELINE_EPS = 0.5


class _Frame:
    """Maps pdfplumber's DISPLAY box frame onto the frame the text reads in.

    ⚠️ These are not the same frame, and the difference is invisible until a page
    is rotated. pdfplumber reports boxes with /Rotate already applied — what a
    viewer shows — but the whole converter above is written for a frame where text
    runs left-to-right and lines stack downwards: it sorts elements by ``y0``,
    calls the top 15%% of the page a header band, and stacks paragraphs in that
    order. On a page whose text runs down the screen, display space satisfies none
    of that, and the output comes back with its lines in column order and its
    words glued together.

    So every box handed upwards — text, images, tables, drawings, the page itself
    — is expressed in the reading frame, and ``render_clip`` converts back. One
    frame everywhere is the point; a mixture is how the pdf skill shipped boxes
    drawn onto blank paper (gotchas §21.1⑨).

    ``k`` is how many quarter turns take display into reading, derived from where
    the text actually points rather than from /Rotate — a page can carry /Rotate 90
    with text authored to match it, in which case nothing needs turning at all.
    """

    __slots__ = ("k", "disp_w", "disp_h", "width", "height")

    def __init__(self, k: int, disp_w: float, disp_h: float):
        self.k = k % 4
        self.disp_w, self.disp_h = float(disp_w), float(disp_h)
        swap = self.k in (1, 3)
        self.width = self.disp_h if swap else self.disp_w
        self.height = self.disp_w if swap else self.disp_h

    def _point(self, x: float, y: float) -> tuple[float, float]:
        if self.k == 0:
            return (x, y)
        if self.k == 1:                       # text runs DOWN the screen
            return (y, self.disp_w - x)
        if self.k == 2:                       # text runs LEFT
            return (self.disp_w - x, self.disp_h - y)
        return (self.disp_h - y, x)           # text runs UP

    def _unpoint(self, u: float, v: float) -> tuple[float, float]:
        if self.k == 0:
            return (u, v)
        if self.k == 1:
            return (self.disp_w - v, u)
        if self.k == 2:
            return (self.disp_w - u, self.disp_h - v)
        return (v, self.disp_h - u)

    @staticmethod
    def _span(a, b):
        return (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))

    def box(self, box) -> tuple:
        """Display box -> reading box. Exact: every turn here is a right angle."""
        x0, y0, x1, y1 = (float(v) for v in box)
        return self._span(self._point(x0, y0), self._point(x1, y1))

    def unbox(self, box) -> tuple:
        u0, v0, u1, v1 = (float(v) for v in box)
        return self._span(self._unpoint(u0, v0), self._unpoint(u1, v1))


def _text_direction(chars: list[dict]) -> int:
    """Quarter turns from display to reading, from where the glyphs advance.

    A char's matrix is (a, b, c, d, e, f) with the advance pointing along (a, b)
    in the PDF's bottom-up frame, so on screen it points along (a, -b). Pages that
    mix directions (a rotated caption beside upright body text) get the direction
    the bulk of the characters use, and the minority comes out in the wrong order
    — stated here rather than discovered later.
    """
    votes = {0: 0, 1: 0, 2: 0, 3: 0}
    for ch in chars:
        m = ch.get("matrix")
        if not m:
            votes[0] += 1
            continue
        dx, dy = float(m[0]), -float(m[1])
        if abs(dx) >= abs(dy):
            votes[0 if dx >= 0 else 2] += 1
        else:
            votes[1 if dy >= 0 else 3] += 1
    return max(votes, key=lambda k: votes[k])

# Two runs of text can share a baseline and still be different things — the three
# statistics across a slide, or a card's label and the next card's label. PDF
# stores no space between them, only distance, so one has to be inferred or they
# come out glued ("+31%-24%83%").
#
# Calibrated on the real corpus (deck.pdf, 1044 adjacent char pairs), as a ratio
# of the gap to the font size:
#
#     0.00 .......... 187 pairs   ordinary adjacent glyphs
#     0.20 - 0.50 ... 180 pairs   CSS letter-spacing (the deck's kickers)
#     0.50 - 1.29 ..... 0 pairs   <- empty
#     1.29 - 39.5 .... 34 pairs   genuinely separate runs ("路线B" | "推荐")
#
# 0.9 sits in that empty band, 1.8x above the letter-spacing ceiling and 1.4x
# below the closest real separation. The band is what makes it a threshold rather
# than a guess, and the ruler holds both edges.
#
# Getting this too LOW re-creates the defect this stack was supposed to fix:
# PyMuPDF split the letter-spaced kickers into "E N G I N E E R I N G".
_SPACE_GAP_RATIO = 0.9


def _line_key(char: dict) -> float:
    """The char's signed distance from the origin perpendicular to its own baseline.

    Chars set on one baseline share this number exactly, whatever the rotation, so
    lines can be grouped on it instead of on a y-tolerance. A tolerance has to be
    loose enough to hold a 10pt run and a 24pt run that sit on one baseline, and
    that is already loose enough to swallow the next line of a tight list.
    """
    m = char.get("matrix")
    if not m:
        return float(char.get("y0", 0.0))
    a, b, e, f = float(m[0]), float(m[1]), float(m[4]), float(m[5])
    norm = (a * a + b * b) ** 0.5 or 1.0
    return (a * f - b * e) / norm


def _cluster(values: list[float]) -> list[float]:
    """Collapse near-equal baselines onto one representative each."""
    out: list[float] = []
    for v in sorted(values):
        if out and abs(v - out[-1]) <= _BASELINE_EPS:
            continue
        out.append(v)
    return out


class Table:
    """A ruled table found by pdfplumber, rendered the way the converter expects."""

    def __init__(self, bbox, rows: list[list]):
        self.bbox = tuple(float(v) for v in bbox)
        self.rows = rows
        self.row_count = len(rows)
        self.col_count = max((len(r) for r in rows), default=0)

    @staticmethod
    def _cell(value) -> str:
        # A cell holding a newline or a pipe would end the row early in Markdown.
        text = "" if value is None else str(value)
        return normalize_glyphs(text).replace("\n", " ").replace("|", r"\|").strip()

    def to_markdown(self) -> str:
        if not self.rows:
            return ""
        width = self.col_count
        lines = []
        for i, row in enumerate(self.rows):
            cells = [self._cell(c) for c in row] + [""] * (width - len(row))
            lines.append("|" + "|".join(cells) + "|")
            if i == 0:
                lines.append("|" + "|".join(["---"] * width) + "|")
        # The trailing blank line is what PyMuPDF's to_markdown produced and what
        # the caller's spacing was written against.
        return "\n".join(lines) + "\n\n"


class Page:
    """One page, answering the four questions ``pdf_to_md.py`` asks of it."""

    def __init__(self, document: "Document", index: int):
        self._doc = document
        self._page = document._pdf.pages[index]
        self.number = index
        self.rotation = int(getattr(self._page, "rotation", 0) or 0) % 360
        self._chars = [c for c in self._page.chars if c.get("text")]
        self.frame = _Frame(_text_direction(self._chars),
                            float(self._page.width), float(self._page.height))
        self.rect = Rect(0.0, 0.0, self.frame.width, self.frame.height)
        self._dict = None

    def _char_box(self, c: dict) -> tuple:
        return self.frame.box((c["x0"], c["top"], c["x1"], c["bottom"]))

    # -- text ---------------------------------------------------------------
    def _lines(self) -> list[dict]:
        """Visual lines, each a list of spans of uniform font and size."""
        chars = self._chars
        if not chars:
            return []
        keys = _cluster([_line_key(c) for c in chars])

        def bucket(c) -> int:
            k = _line_key(c)
            best, dist = 0, float("inf")
            for i, kk in enumerate(keys):
                d = abs(k - kk)
                if d < dist:
                    best, dist = i, d
            return best

        grouped: dict[int, list[dict]] = {}
        for c in chars:
            grouped.setdefault(bucket(c), []).append((c, self._char_box(c)))

        lines = []
        for entries in grouped.values():
            # Reading-frame coordinates: u runs along the line, v across it. On an
            # unrotated page these are display x and y and nothing has moved.
            entries.sort(key=lambda e: (e[1][0], e[1][1]))
            spans = []
            prev_box = None
            for c, box in entries:
                name = base_font_name(c.get("fontname", ""))
                # ⚠️ NOT pdfplumber's `size`: on a page whose text does not run
                # across the screen it reports the glyph's ADVANCE instead of its
                # height (measured: a 24pt heading came back as 18.67, and the
                # body/heading ranking that drives every heading level with it).
                # The reading-frame box height is the same number on every page.
                size = round(box[3] - box[1], 2)
                gapped = prev_box is not None and (
                    (box[0] - prev_box[2]) > _SPACE_GAP_RATIO
                    * max(prev_box[3] - prev_box[1], 1.0))
                if spans and spans[-1]["font"] == name and spans[-1]["size"] == size:
                    if gapped:
                        spans[-1]["_gaps"].add(len(spans[-1]["_chars"]))
                    spans[-1]["_chars"].append((c, box))
                else:
                    spans.append({"font": name, "size": size, "_chars": [(c, box)],
                                  "_gaps": set(), "_lead_gap": gapped})
                prev_box = box
            out_spans = []
            for s in spans:
                cs = s["_chars"]
                text = "".join((" " if i in s["_gaps"] else "") + c["text"]
                               for i, (c, _b) in enumerate(cs))
                box = (min(b[0] for _c, b in cs), min(b[1] for _c, b in cs),
                       max(b[2] for _c, b in cs), max(b[3] for _c, b in cs))
                # A gap that falls BETWEEN two spans cannot be carried inside
                # either one's text: the caller strips each span before wrapping
                # it in ** markers, so a leading or trailing space is discarded.
                # It already has a branch that passes whitespace-only spans
                # through untouched, which is exactly the shape needed here.
                if s["_lead_gap"] and out_spans:
                    out_spans.append({"text": " ", "size": s["size"], "flags": 0,
                                      "font": s["font"], "bbox": box})
                out_spans.append({
                    "text": normalize_glyphs(text),
                    "size": s["size"],
                    "flags": font_flags(s["font"]),
                    "font": s["font"],
                    "bbox": box,
                })
            lines.append({
                "bbox": (min(s["bbox"][0] for s in out_spans),
                         min(s["bbox"][1] for s in out_spans),
                         max(s["bbox"][2] for s in out_spans),
                         max(s["bbox"][3] for s in out_spans)),
                "spans": out_spans,
            })
        lines.sort(key=lambda l: (l["bbox"][1], l["bbox"][0]))
        return lines

    def _images(self) -> list[dict]:
        """Placed images: geometry from pdfplumber, encoded bytes from pypdf.

        Neither library answers both halves. pdfplumber knows where an image
        landed on the page but hands back a pdfminer stream, not a file; pypdf
        decodes the stream into real PNG/JPEG bytes but does not know where it was
        drawn. They are joined on the XObject name, falling back to position.
        """
        placed = list(self._page.images)
        if not placed:
            return []
        payloads = self._doc._payloads(self.number)
        blocks = []
        for i, im in enumerate(placed):
            key = str(im.get("name") or "")
            got = payloads.get(key)
            if got is None and i < len(payloads.get("_ordered", [])):
                got = payloads["_ordered"][i]
            if got is None:
                continue
            data, ext, size = got
            src = im.get("srcsize") or size
            blocks.append({
                "type": 1,
                "bbox": self.frame.box((im["x0"], im["top"],
                                        im["x1"], im["bottom"])),
                "width": int(src[0]), "height": int(src[1]),
                "ext": ext, "image": data,
            })
        return blocks

    def get_text(self, kind: str = "text"):
        """``"dict"`` and ``"blocks"``, the two shapes the converter asks for.

        Both are built from the same line list so the text the caller matches
        against detected noise is character-for-character the text that produced
        the noise list in the first place.
        """
        if self._dict is None:
            text_blocks = [{"type": 0, "bbox": l["bbox"], "lines": [l]}
                           for l in self._lines()]
            self._dict = {"blocks": text_blocks + self._images(),
                          "width": self.rect.width, "height": self.rect.height}
        if kind == "dict":
            return self._dict
        if kind == "blocks":
            out = []
            for n, b in enumerate(self._dict["blocks"]):
                if b["type"] != 0:
                    continue
                text = "".join(s["text"] for l in b["lines"] for s in l["spans"])
                out.append((*b["bbox"], text, n, 0))
            return out
        if kind == "text":
            return "\n".join(
                "".join(s["text"] for s in l["spans"])
                for b in self._dict["blocks"] if b["type"] == 0
                for l in b["lines"])
        raise ValueError(f"unsupported get_text kind: {kind!r}")

    # -- tables -------------------------------------------------------------
    def find_tables(self) -> list[Table]:
        """Ruled tables only.

        pdfplumber's default strategy needs drawn lines. PyMuPDF additionally
        guessed at tables from text alignment; dropping that guess loses some
        unruled tables and stops inventing others, and the same trade was already
        accepted for the pdf skill (059 §5·补.8c, P3).
        """
        found = []
        for t in self._page.find_tables():
            rows = t.extract()
            if not rows:
                continue
            table = Table(self.frame.box(t.bbox), rows)
            # ⚠️ A bordered box is not a table. pdfplumber's line strategy reports
            # any rectangle with a drawn outline as a 1x1 grid, and a slide deck
            # is made of those — measured on deck.pdf p4/p7, where each card came
            # back as a one-cell "table" whose Markdown was `||` over `|---|`,
            # AND which then swallowed the real text inside it, because the caller
            # drops every text block that overlaps a table region. Requiring two
            # rows and two columns is what separates a grid from a border.
            if table.row_count < 2 or table.col_count < 2:
                continue
            found.append(table)
        return found

    # -- vector drawings ----------------------------------------------------
    def get_drawings(self) -> list[dict]:
        """Filled/stroked path bounding boxes, as ``{"rect", "fill", "color"}``.

        ``fill``/``color`` are None when the path is not filled / not stroked,
        which is the distinction the caller uses to tell a white background
        rectangle from a real drawing.
        """
        out = []
        for kind in ("rects", "lines", "curves"):
            for obj in getattr(self._page, kind, []) or []:
                rect = Rect(self.frame.box((obj["x0"], obj["top"],
                                            obj["x1"], obj["bottom"])))
                out.append({
                    "rect": rect,
                    "fill": _color(obj.get("non_stroking_color")) if obj.get("fill") else None,
                    "color": _color(obj.get("stroking_color")) if obj.get("stroke") else None,
                })
        return out

    # -- raster -------------------------------------------------------------
    def render_clip(self, rect: Rect, dpi: int, dest: Path) -> tuple[int, int]:
        """Rasterise one region of the page to ``dest``; returns its pixel size.

        ⚠️ ``crop`` is how much to cut off each edge — (left, bottom, right, top)
        — and its bottom/top are measured from the PDF's own BOTTOM-left origin,
        while ``rect`` arrives top-left. Getting that flip wrong does not fail: it
        renders a different, equally plausible region of the same page. On this
        skill's own fixture the wrong region is *more* inked than the right one
        (it lands on a photo), so "the crop has ink in it" cannot catch the
        mistake — only comparing against the same region of a full-page render
        can, which is what the ruler does.
        """
        import pypdfium2 as pdfium

        doc = self._doc._raster()
        page = doc[self.number]
        page_w, page_h = page.get_size()
        scale = dpi / 72.0
        # Back out of the reading frame first: PDFium renders what a viewer shows,
        # which is the same display frame pdfplumber reported and NOT the frame the
        # caller's rectangle is expressed in.
        x0, y0, x1, y1 = self.frame.unbox(tuple(rect))
        crop = (max(0.0, x0), max(0.0, page_h - y1),
                max(0.0, page_w - x1), max(0.0, y0))
        image = page.render(scale=scale, crop=crop).to_pil()
        dest.parent.mkdir(parents=True, exist_ok=True)
        image.save(str(dest))
        return image.size


def _color(value):
    """pdfplumber colours arrive as a scalar (grey), a 3-tuple or a 4-tuple."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return (float(value),) * 3
    try:
        return tuple(float(v) for v in value)
    except (TypeError, ValueError):
        return None


class Document:
    def __init__(self, path):
        import pdfplumber

        _quiet_pdfminer()
        self.path = Path(path)
        self._pdf = pdfplumber.open(str(self.path))
        self._raster_doc = None
        self._payload_cache: dict[int, dict] = {}
        self._pages: dict[int, Page] = {}

    # pypdf is opened lazily and only for documents that actually place images;
    # most decks place none (measured: the ai-coding-pilot deck has zero).
    def _payloads(self, index: int) -> dict:
        if index in self._payload_cache:
            return self._payload_cache[index]
        out: dict = {"_ordered": []}
        try:
            from pypdf import PdfReader

            reader = PdfReader(str(self.path))
            for img in reader.pages[index].images:
                name = str(img.name or "")
                ext = Path(name).suffix.lstrip(".").lower() or "png"
                entry = (img.data, ext, img.image.size)
                out[Path(name).stem] = entry
                out[name] = entry
                out["_ordered"].append(entry)
        except Exception as exc:  # noqa: BLE001 - a file we cannot decode is not fatal
            print(f"  [WARN] could not read image payloads on page {index + 1}: {exc}")
        self._payload_cache[index] = out
        return out

    def _raster(self):
        if self._raster_doc is None:
            import pypdfium2 as pdfium

            self._raster_doc = pdfium.PdfDocument(str(self.path))
        return self._raster_doc

    def __len__(self) -> int:
        return len(self._pdf.pages)

    def __getitem__(self, index: int) -> Page:
        if index not in self._pages:
            self._pages[index] = Page(self, index)
        return self._pages[index]

    def __iter__(self):
        for i in range(len(self)):
            yield self[i]

    def close(self) -> None:
        try:
            self._pdf.close()
        finally:
            if self._raster_doc is not None:
                self._raster_doc.close()
                self._raster_doc = None


def open_document(path) -> Document:
    return Document(path)
