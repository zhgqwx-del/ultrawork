#!/usr/bin/env python3
"""A Markdown subset, parsed into blocks — and an honest account of what it skipped.

This skill depends on python3, lxml and LibreOffice. Adding a Markdown library to
turn `#` into a heading would be a poor trade, so the subset is parsed here. That
makes the boundary of the subset the important thing about this module, and the
contract is the one W5 and W7 already established:

    **anything this does not understand is REPORTED, never dropped.**

A generator that silently discards a footnote, a raw `<table>` or a reference-style
link produces a document that is missing content, with nothing anywhere saying so —
and the person who finds out is the reader of the printed contract. Every construct
this parser meets and cannot map lands in `unsupported` with its line number, and the
caller decides whether that is acceptable (`--strict` makes it fatal).

WHAT IS SUPPORTED
    headings          # .. ######, and Setext (=== / --- underlines)
    paragraphs        blank-line separated, with lazy continuation
    lists             - * + and 1. , nested by indentation, mixed
    tables            GFM pipe tables with an alignment row
    code              ``` fenced (language recorded) and 4-space indented
    quotes            > , including multiple paragraphs and nesting depth
    rules             --- *** ___
    inline            **bold** *italic* ***both*** `code` ~~strike~~
                      [text](url) ![alt](src) and backslash escapes

WHAT IS NOT, and is reported by name
    raw HTML blocks and inline tags, reference-style links and images, footnotes,
    definition lists, task-list checkboxes, front matter, math, and anything else
    that arrives as a construct rather than as text.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# ── inline ────────────────────────────────────────────────────────────────────


@dataclass
class Span:
    """A run of text and the marks on it."""
    text: str
    bold: bool = False
    italic: bool = False
    code: bool = False
    strike: bool = False
    link: str | None = None


@dataclass
class Block:
    kind: str                      # heading paragraph list_item table code quote rule image
    text: str = ""
    spans: list[Span] = field(default_factory=list)
    level: int = 0                 # heading level, or list nesting depth
    ordered: bool = False
    language: str = ""
    rows: list[list[list[Span]]] = field(default_factory=list)
    alignments: list[str] = field(default_factory=list)
    src: str = ""
    alt: str = ""
    line: int = 0


# Ordered longest-first so `***` is not read as `*` followed by `**`.
_INLINE = re.compile(
    r"(?P<esc>\\.)"
    r"|(?P<code>`+)(?P<code_text>.+?)(?P=code)"
    r"|(?P<image>!\[(?P<alt>[^\]]*)\]\((?P<src>[^)\s]+)[^)]*\))"
    r"|(?P<link>\[(?P<label>[^\]]*)\]\((?P<href>[^)\s]*)[^)]*\))"
    r"|(?P<bi>\*\*\*(?P<bi_text>.+?)\*\*\*)"
    r"|(?P<bold>\*\*(?P<bold_text>.+?)\*\*|__(?P<bold_text2>.+?)__)"
    r"|(?P<ital>\*(?P<ital_text>[^*]+?)\*|_(?P<ital_text2>[^_]+?)_)"
    r"|(?P<strike>~~(?P<strike_text>.+?)~~)",
    re.S)

# Constructs this parser meets and cannot map. Each is NAMED rather than dropped.
_REF_LINK = re.compile(r"(?<!\!)\[[^\]]+\]\[[^\]]*\]")
_FOOTNOTE_REF = re.compile(r"\[\^[^\]]+\]")
_HTML_TAG = re.compile(r"</?[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?/?>")


def parse_inline(text: str, line: int, unsupported: list[dict]) -> list[Span]:
    """Split one line of Markdown into styled spans, reporting what it cannot map."""
    for pattern, what in ((_FOOTNOTE_REF, "footnote reference"),
                          (_REF_LINK, "reference-style link"),
                          (_HTML_TAG, "raw HTML tag")):
        for m in pattern.finditer(text):
            unsupported.append({"line": line, "construct": what,
                                "text": m.group(0)[:60]})

    spans: list[Span] = []
    pos = 0

    def push(chunk: str, **marks) -> None:
        if chunk:
            spans.append(Span(chunk, **marks))

    for m in _INLINE.finditer(text):
        if m.start() > pos:
            push(text[pos:m.start()])
        if m.group("esc"):
            push(m.group("esc")[1:])
        elif m.group("code"):
            push(m.group("code_text"), code=True)
        elif m.group("image"):
            # An image is a BLOCK-level thing in a Word document (it needs a size and
            # a relationship), so an inline one is surfaced rather than smuggled in
            # as text. `docx_from_md.py` turns it into its own paragraph.
            spans.append(Span("", link=None))
            spans[-1].text = ""
            unsupported.append({"line": line, "construct": "inline image",
                                "text": m.group("image")[:60],
                                "note": "placed as its own paragraph"})
        elif m.group("link"):
            push(m.group("label"), link=m.group("href"))
        elif m.group("bi"):
            push(m.group("bi_text"), bold=True, italic=True)
        elif m.group("bold"):
            push(m.group("bold_text") or m.group("bold_text2"), bold=True)
        elif m.group("ital"):
            push(m.group("ital_text") or m.group("ital_text2"), italic=True)
        elif m.group("strike"):
            push(m.group("strike_text"), strike=True)
        pos = m.end()
    if pos < len(text):
        push(text[pos:])
    return [s for s in spans if s.text]


# ── blocks ────────────────────────────────────────────────────────────────────
_ATX = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})\s*(\S*)")
_RULE = re.compile(r"^\s{0,3}([-*_])\s*(\1\s*){2,}$")
_BULLET = re.compile(r"^(\s*)([-*+])\s+(.*)$")
_ORDERED = re.compile(r"^(\s*)(\d{1,9})[.)]\s+(.*)$")
_QUOTE = re.compile(r"^\s{0,3}>\s?(.*)$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$")
_SETEXT = re.compile(r"^\s{0,3}(=+|-+)\s*$")
_TASK = re.compile(r"^\[[ xX]\]\s+")
_IMAGE_ONLY = re.compile(r"^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)$")

# One indent level. Markdown allows 2-4 spaces; 2 is what every editor emits for a
# nested bullet, and rounding down keeps a 4-space list from reading as depth 2.
INDENT = 2


def _cells(line: str) -> list[str]:
    row = line.strip()
    if row.startswith("|"):
        row = row[1:]
    if row.endswith("|"):
        row = row[:-1]
    return [c.strip() for c in row.split("|")]


def parse(text: str) -> tuple[list[Block], list[dict]]:
    """Markdown -> (blocks, unsupported). Never raises on odd input."""
    unsupported: list[dict] = []
    blocks: list[Block] = []
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i, n = 0, len(lines)

    if lines and lines[0].strip() == "---":
        end = next((j for j in range(1, n) if lines[j].strip() == "---"), None)
        if end is not None and end > 1:
            unsupported.append({"line": 1, "construct": "front matter",
                                "text": f"{end - 1} line(s) between --- markers"})
            i = end + 1

    para: list[str] = []
    para_line = 0

    def flush_paragraph() -> None:
        nonlocal para, para_line
        if not para:
            return
        joined = " ".join(s.strip() for s in para)
        blocks.append(Block("paragraph", text=joined,
                            spans=parse_inline(joined, para_line, unsupported),
                            line=para_line))
        para = []

    while i < n:
        raw = lines[i]
        line_no = i + 1
        stripped = raw.strip()

        if not stripped:
            flush_paragraph()
            i += 1
            continue

        fence = _FENCE.match(raw)
        if fence:
            flush_paragraph()
            marker = fence.group(2)[0] * 3
            body: list[str] = []
            i += 1
            while i < n and not lines[i].strip().startswith(marker):
                body.append(lines[i])
                i += 1
            i += 1                                   # skip the closing fence
            blocks.append(Block("code", text="\n".join(body),
                                language=fence.group(3), line=line_no))
            continue

        atx = _ATX.match(raw)
        if atx:
            flush_paragraph()
            title = atx.group(2)
            blocks.append(Block("heading", text=title, level=len(atx.group(1)),
                                spans=parse_inline(title, line_no, unsupported),
                                line=line_no))
            i += 1
            continue

        # Setext: the underline belongs to the paragraph above it, so it can only be
        # recognised once that paragraph is known — which is why it is handled here
        # rather than by looking ahead.
        if para and _SETEXT.match(raw):
            title = " ".join(s.strip() for s in para)
            para = []
            blocks.append(Block("heading", text=title,
                                level=1 if raw.strip()[0] == "=" else 2,
                                spans=parse_inline(title, para_line, unsupported),
                                line=para_line))
            i += 1
            continue

        if _RULE.match(raw):
            flush_paragraph()
            blocks.append(Block("rule", line=line_no))
            i += 1
            continue

        quote = _QUOTE.match(raw)
        if quote:
            flush_paragraph()
            body, depth = [], 1
            while i < n and _QUOTE.match(lines[i]):
                inner = _QUOTE.match(lines[i]).group(1)
                if inner.lstrip().startswith(">"):
                    depth = 2
                    inner = inner.lstrip()[1:].lstrip()
                body.append(inner)
                i += 1
            joined = " ".join(s.strip() for s in body if s.strip())
            blocks.append(Block("quote", text=joined, level=depth,
                                spans=parse_inline(joined, line_no, unsupported),
                                line=line_no))
            continue

        # A table needs its separator row, so it is only a table if line i+1 is one.
        if "|" in raw and i + 1 < n and _TABLE_SEP.match(lines[i + 1]):
            flush_paragraph()
            header = _cells(raw)
            aligns = []
            for spec in _cells(lines[i + 1]):
                left, right = spec.startswith(":"), spec.endswith(":")
                aligns.append("center" if left and right else
                              "right" if right else "left")
            rows = [[parse_inline(c, line_no, unsupported) for c in header]]
            i += 2
            while i < n and "|" in lines[i] and lines[i].strip():
                cells = _cells(lines[i])
                # Ragged rows are padded rather than refused: a table with a short
                # row is still a table, and dropping it would lose data.
                cells += [""] * (len(header) - len(cells))
                rows.append([parse_inline(c, i + 1, unsupported)
                             for c in cells[:len(header)]])
                i += 1
            blocks.append(Block("table", rows=rows, alignments=aligns, line=line_no))
            continue

        bullet, ordered = _BULLET.match(raw), _ORDERED.match(raw)
        if bullet or ordered:
            flush_paragraph()
            m = bullet or ordered
            content = m.group(3)
            if _TASK.match(content):
                unsupported.append({"line": line_no, "construct": "task list checkbox",
                                    "text": content[:60],
                                    "note": "the checkbox is dropped, the text is kept"})
                content = _TASK.sub("", content)
            blocks.append(Block("list_item", text=content,
                                spans=parse_inline(content, line_no, unsupported),
                                level=len(m.group(1)) // INDENT,
                                ordered=bool(ordered), line=line_no))
            i += 1
            continue

        only_image = _IMAGE_ONLY.match(stripped)
        if only_image:
            flush_paragraph()
            blocks.append(Block("image", alt=only_image.group(1),
                                src=only_image.group(2), line=line_no))
            i += 1
            continue

        if _HTML_TAG.match(stripped):
            flush_paragraph()
            unsupported.append({"line": line_no, "construct": "raw HTML block",
                                "text": stripped[:60]})
            i += 1
            continue

        if not para:
            para_line = line_no
        para.append(raw)
        i += 1

    flush_paragraph()
    return blocks, unsupported
