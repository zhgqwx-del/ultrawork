#!/usr/bin/env python3
"""P7 + P8 — fill a form, whether or not it has AcroForm fields.

    # P7: real widgets
    python3 pdf_form_fill.py --in form.pdf --out filled.pdf --values values.json

    # P8: no AcroForm — place text by anchor or by explicit box
    python3 pdf_form_fill.py --in flat.pdf --out filled.pdf \
            --values placements.json --mode overlay

values.json (AcroForm)   {"applicant": "张国强", "dept": "技术部", "agree": true}
values.json (overlay)    {"placements": [
                            {"name": "applicant", "text": "张国强",
                             "anchor": "姓名：", "offset": [12, 0], "width": 150},
                            {"name": "note", "text": "见附件",
                             "page": 1, "rect": [122, 256, 422, 273]}]}

`--mode auto` (the default) picks AcroForm when the document has one and overlay
when it does not, and says which it chose in the report. It never silently falls
back after a failure: a form that HAS fields but whose names do not match is a
wrong values file, and painting the text on top would hide that.

Both paths write the same fill report (--report), so pdf_form_check.py can check
overflow and draw the proof sheet without caring which path ran.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import fail, open_pdf, run, write_json  # noqa: E402
from pdfform import (CJK_FONT, collect_fields, has_acroform, has_cjk,  # noqa: E402
                     load_placements, round_box)

CHECKBOX_TRUE = {"true", "yes", "on", "1", "x", "✓"}


def _as_checkbox(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in CHECKBOX_TRUE


def fill_acroform(doc, values: dict) -> list[dict]:
    fields = {f["name"]: f for f in collect_fields(doc)}
    unknown = [k for k in values if k not in fields]
    if unknown:
        fail(f"no such field(s) in this form: {', '.join(sorted(unknown))}. "
             f"Available: {', '.join(sorted(fields))}")
    filled = []
    for i in range(doc.page_count):
        page = doc[i]
        for widget in page.widgets() or []:
            if widget.field_name not in values:
                continue
            value = values[widget.field_name]
            kind = (widget.field_type_string or "").lower()
            if kind == "checkbox":
                widget.field_value = _as_checkbox(value)
            elif kind in ("combobox", "listbox"):
                choices = list(widget.choice_values or [])
                # A value outside the list is data the form cannot hold. Writing it
                # anyway produces a file that looks filled and fails validation
                # somewhere the user is not watching.
                if choices and str(value) not in choices:
                    fail(f"{widget.field_name}: {value!r} is not one of its choices "
                         f"({', '.join(choices)})")
                widget.field_value = str(value)
            else:
                text = str(value)
                limit = int(widget.text_maxlen or 0)
                if limit and len(text) > limit:
                    fail(f"{widget.field_name}: value is {len(text)} characters, the "
                         f"field's /MaxLen is {limit} — it would be truncated on save")
                widget.field_value = text
            widget.update()
            filled.append({"name": widget.field_name, "page": i + 1,
                           "rect": round_box(widget.rect),
                           "rect_display": round_box(widget.rect * page.rotation_matrix),
                           "text": str(widget.field_value), "source": "acroform",
                           "font": widget.text_font,
                           "font_size": float(widget.text_fontsize or 0) or None})
    missing = set(values) - {f["name"] for f in filled}
    if missing:
        fail(f"field(s) declared but never reached on any page: {', '.join(sorted(missing))}")
    return filled


def _anchor_rect(page, item: dict):
    import fitz

    anchor = item["anchor"]
    hits = page.search_for(anchor)
    if not hits:
        fail(f"anchor {anchor!r} not found on page {page.number + 1}")
    if len(hits) > 1:
        # Silently taking the first match is how the value ends up next to the wrong
        # label on a form that repeats a word.
        fail(f"anchor {anchor!r} appears {len(hits)} times on page {page.number + 1}; "
             f"use an explicit \"rect\" or a longer anchor")
    box = hits[0]
    dx, dy = item.get("offset", [8, 0])
    width = item.get("width", 150)
    height = item.get("height", box.height + 2)
    x0 = box.x1 + dx
    y0 = box.y0 + dy
    return fitz.Rect(x0, y0, x0 + width, y0 + height)


def fill_overlay(doc, items: list[dict]) -> list[dict]:
    import fitz

    filled = []
    for item in items:
        number = int(item.get("page", 1))
        if not 1 <= number <= doc.page_count:
            fail(f"placement {item.get('name') or item['text']!r} targets page "
                 f"{number}, the document has {doc.page_count}")
        page = doc[number - 1]
        rect = fitz.Rect(item["rect"]) if "rect" in item else _anchor_rect(page, item)
        text = str(item["text"])
        size = float(item.get("size", 10))
        font = CJK_FONT if has_cjk(text) else item.get("font", "helv")
        # insert_textbox reports the leftover height; negative means it did not fit,
        # and it writes NOTHING in that case. Returning success there would produce a
        # blank line on the form.
        left = page.insert_textbox(rect, text, fontname=font, fontsize=size,
                                   align=item.get("align", 0))
        if left < 0:
            fail(f"{item.get('name') or text!r} does not fit its box "
                 f"{round_box(rect)} at size {size} (short by {abs(left):.1f}pt) — "
                 f"widen the box or lower --size")
        filled.append({"name": item.get("name") or text[:16], "page": number,
                       "rect": round_box(rect),
                       "rect_display": round_box(rect * page.rotation_matrix),
                       "text": text, "source": "overlay",
                       "font": font, "font_size": size})
    return filled


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--values", required=True, type=Path)
    ap.add_argument("--mode", default="auto", choices=["auto", "acroform", "overlay"])
    ap.add_argument("--password", default=None)
    ap.add_argument("--report", type=Path, default=None,
                    help="write the fill report (feeds pdf_form_check.py)")
    args = ap.parse_args()

    if not args.values.is_file():
        fail(f"no such values file: {args.values}")
    doc = open_pdf(args.src, args.password)
    with doc:
        mode = args.mode
        if mode == "auto":
            mode = "acroform" if has_acroform(doc) else "overlay"
        if mode == "acroform" and not has_acroform(doc):
            fail(f"{args.src.name} has no AcroForm fields; use --mode overlay")
        if mode == "acroform":
            values = json.loads(args.values.read_text(encoding="utf-8"))
            if not isinstance(values, dict) or not values:
                fail(f"{args.values.name}: expected a non-empty object of field -> value")
            filled = fill_acroform(doc, values)
        else:
            filled = fill_overlay(doc, load_placements(args.values))
        args.out.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(args.out), garbage=4, deflate=True, no_new_id=True)

    report = {"source": str(args.src), "out": str(args.out), "mode": mode,
              "filled": filled}
    if args.report:
        write_json(args.report, report)
    print(json.dumps({"out": str(args.out), "mode": mode, "filled": len(filled)},
                     ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(run(main))
