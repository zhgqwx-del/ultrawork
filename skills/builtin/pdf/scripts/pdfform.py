#!/usr/bin/env python3
"""The form field model shared by inspect / fill / check (ultrawork, self-written).

P5-P10 are one capability family on purpose: detection, extraction, AcroForm fill,
overlay fill, overflow checking and the proof sheet all need the same record. The
important part is that a field filled by the overlay path produces the SAME record
as an AcroForm widget — otherwise "does the value fit its box" would need two
implementations and only one of them would get tested.

    {"name": "applicant", "type": "text", "page": 1,
     "rect": [x0, y0, x1, y1],          # page space (what draw_rect wants)
     "rect_display": [...],             # display space (what the render shows)
     "value": "张国强", "choices": [...], "max_length": 18,
     "flags": {"required": true, ...}, "font": "Helv", "font_size": 11,
     "source": "acroform" | "overlay"}
"""
from __future__ import annotations

from pathlib import Path

# Ff bit meanings from the PDF spec. Only the ones that change how a field behaves
# for a filler are decoded; the raw value is kept alongside so nothing is lost.
COMMON_FLAGS = {"read_only": 1 << 0, "required": 1 << 1, "no_export": 1 << 2}
TEXT_FLAGS = {"multiline": 1 << 12, "password": 1 << 13, "comb": 1 << 24}
CHOICE_FLAGS = {"combo": 1 << 17, "editable": 1 << 18, "multi_select": 1 << 21}
BUTTON_FLAGS = {"no_toggle_off": 1 << 14, "radio": 1 << 15, "pushbutton": 1 << 16}

CJK_FONT = "china-s"


def type_name(widget) -> str:
    """PyMuPDF already names the type; lower-case it so the JSON is stable."""
    return (widget.field_type_string or "unknown").lower()


def decode_flags(raw: int, kind: str) -> dict:
    table = dict(COMMON_FLAGS)
    if kind == "text":
        table.update(TEXT_FLAGS)
    elif kind in ("combobox", "listbox"):
        table.update(CHOICE_FLAGS)
    elif kind in ("checkbox", "radiobutton", "button"):
        table.update(BUTTON_FLAGS)
    out = {name: bool(raw & bit) for name, bit in table.items()}
    out["raw"] = int(raw)
    return out


def round_box(box) -> list[float]:
    return [round(float(v), 2) for v in box]


def describe_widget(page, widget, number: int) -> dict:
    import fitz

    kind = type_name(widget)
    rect = fitz.Rect(widget.rect)
    return {
        "name": widget.field_name,
        "type": kind,
        "page": number,
        "rect": round_box(rect),
        # Same two-frame rule as pdf_extract.py: a /Rotate page makes these differ,
        # and a proof sheet drawn in the wrong one lands on empty paper.
        "rect_display": round_box(rect * page.rotation_matrix),
        "value": widget.field_value,
        "choices": list(widget.choice_values) if widget.choice_values else None,
        "max_length": int(widget.text_maxlen or 0) or None,
        "flags": decode_flags(widget.field_flags or 0, kind),
        "font": widget.text_font,
        "font_size": float(widget.text_fontsize or 0) or None,
        "source": "acroform",
    }


def collect_fields(doc, pages: list[int] | None = None) -> list[dict]:
    """Every AcroForm widget in the document, in page order."""
    out = []
    for i in range(doc.page_count):
        if pages is not None and i not in pages:
            continue
        page = doc[i]
        for widget in page.widgets() or []:
            out.append(describe_widget(page, widget, i + 1))
    return out


def has_acroform(doc) -> bool:
    """True when the document carries a real AcroForm.

    `is_form_pdf` is not a boolean: PyMuPDF returns the root field COUNT, or False
    when there is no form. bool() collapses both of the empty cases (False and 0)
    correctly, but the value must not be reported to callers as-is — a count reads
    as a field total when it is only the count of top-level fields.
    """
    return bool(doc.is_form_pdf)


def text_width(text: str, font: str | None, size: float) -> float | None:
    """Natural width of `text`, or None when no font could be resolved.

    None is not zero. A width of zero would say "it fits", which is the wrong
    answer to give when the question could not be answered at all.
    """
    import fitz

    for candidate in (font, "helv"):
        if not candidate:
            continue
        name = CJK_FONT if has_cjk(text) else candidate.lower().replace(" ", "")
        try:
            return fitz.get_text_length(text, fontname=name, fontsize=size)
        except Exception:  # noqa: BLE001 - unmapped font name
            continue
    return None


CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))


def has_cjk(s: str) -> bool:
    return any(any(a <= ord(c) <= b for a, b in CJK_RANGES) for c in s)


def load_placements(path: Path) -> list[dict]:
    """Overlay instructions: either an explicit rect or an anchor to search for."""
    import json

    from pdfcommon import fail

    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("placements") if isinstance(data, dict) else data
    if not isinstance(items, list) or not items:
        fail(f"{path.name}: expected a non-empty list under \"placements\"")
    for i, item in enumerate(items):
        if not isinstance(item, dict) or "text" not in item:
            fail(f"{path.name}: placement #{i} has no \"text\"")
        if "rect" not in item and "anchor" not in item:
            fail(f"{path.name}: placement #{i} ({item.get('name') or item['text']!r}) "
                 f"needs either \"rect\" or \"anchor\"")
    return items
