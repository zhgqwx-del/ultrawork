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

An explicit "rect" is in PAGE space with a top-left origin — the same numbers
pdf_form_inspect.py reports as `rect`, so a rect can be copied straight out of it.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import (ensure_distinct, fail, open_reader,  # noqa: E402
                       pdf_rect_to_top_left, run, to_display_space,
                       to_page_space, write_json)
from pdffont import (available_candidates, missing_glyphs,  # noqa: E402
                     rejected_candidates, resolve)
from pdfform import (DEFAULT_SIZE, LINE_RATIO, PAD, build_appearances,  # noqa: E402
                     collect_fields, drawn_extent, first_baseline, has_acroform,
                     inherited, layout_lines, load_placements, page_geometry,
                     parse_da, round_box, type_name, widgets_on)

CHECKBOX_TRUE = {"true", "yes", "on", "1", "x", "✓"}
MIN_AUTO_SIZE = 4.0


def _as_checkbox(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in CHECKBOX_TRUE


def _on_state(annot) -> str:
    """The name a button's "checked" appearance is filed under (/Yes, /1, /On …).

    Guessing "/Yes" is right for most producers and silently draws nothing for the
    rest, because a viewer shows the /AP entry named by /AS and there would be none.
    """
    ap = annot.get_object().get("/AP")
    normal = ap.get("/N").get_object() if ap and "/N" in ap else None
    if normal is None:
        return "/Yes"
    on = [str(k) for k in normal.keys() if str(k) != "/Off"]
    return on[0] if on else "/Yes"


def _fitting_size(text: str, font: str, width: float, height: float,
                  multiline: bool) -> float:
    """The largest size at or below the default that fits, for a /DA that says 0.

    A font size of 0 in a /DA is the form author saying "the viewer decides". Taking
    that as a literal zero draws nothing at all; taking it as the default draws text
    that runs out of the box on the very fields whose author knew they might.
    """
    from reportlab.pdfbase import pdfmetrics
    size = DEFAULT_SIZE
    while size > MIN_AUTO_SIZE:
        lines = layout_lines(text, font, size, width, multiline)
        widest = max(pdfmetrics.stringWidth(ln, font, size) for ln in lines)
        _, bottom = drawn_extent(font, size, height, len(lines), multiline)
        if widest <= width - 2 * PAD and bottom <= height:
            return size
        size -= 0.5
    return MIN_AUTO_SIZE


def fill_acroform(reader, writer, values: dict) -> list[dict]:
    records = {f["name"]: f for f in collect_fields(reader)}
    unknown = [k for k in values if k not in records]
    if unknown:
        fail(f"no such field(s) in this form: {', '.join(sorted(unknown))}. "
             f"Available: {', '.join(sorted(records))}")

    filled: list[dict] = []
    requests: list[dict] = []
    targets: list = []
    for index, page in enumerate(writer.pages):
        rotation, page_w, page_h = page_geometry(page)
        for ref in widgets_on(page):
            annot = ref.get_object()
            raw_name = inherited(annot, "/T")
            name = str(raw_name) if raw_name is not None else None
            if name not in values:
                continue
            value = values[name]
            kind = type_name(annot)
            box = [float(v) for v in annot["/Rect"]]
            width, height = abs(box[2] - box[0]), abs(box[3] - box[1])
            rect = pdf_rect_to_top_left(box, page_h)
            da_font, da_size = parse_da(inherited(annot, "/DA"))
            record = {"name": name, "page": index + 1, "rect": round_box(rect),
                      "rect_display": round_box(
                          to_display_space(rect, rotation, page_w, page_h)),
                      "source": "acroform"}

            if kind in ("checkbox", "radiobutton"):
                state = _on_state(annot) if _as_checkbox(value) else "/Off"
                _write_name(annot, "/V", state)
                _write_name(annot, "/AS", state)
                # The two states were drawn into /AP when the form was made; the
                # value only chooses which one /AS points at.
                filled.append({**record, "text": state.lstrip("/"),
                               "font": da_font, "font_size": da_size})
                continue

            if kind in ("combobox", "listbox"):
                choices = records[name].get("choices") or []
                # A value outside the list is data the form cannot hold. Writing it
                # anyway produces a file that looks filled and fails validation
                # somewhere the user is not watching.
                if choices and str(value) not in choices:
                    fail(f"{name}: {value!r} is not one of its choices "
                         f"({', '.join(choices)})")
            elif kind in ("pushbutton", "signature", "unknown"):
                fail(f"{name} is a {kind} field; it holds no value this script can "
                     f"write")
            text = str(value)
            limit = records[name].get("max_length")
            if limit and len(text) > limit:
                fail(f"{name}: value is {len(text)} characters, the field's /MaxLen "
                     f"is {limit} — it would be truncated on save")

            font = resolve(text, da_font)
            if font is None:
                rejected = rejected_candidates()
                fail(f"{name}: {text!r} contains CJK characters and no USABLE CJK "
                     f"font is on this machine, so the value would be drawn as "
                     f"blanks."
                     + (f" Found but unusable (reportlab embeds TrueType outlines "
                        f"only; these carry CFF/PostScript ones): "
                        f"{', '.join(rejected)}." if rejected else "")
                     + f" Install one of: "
                       f"{', '.join(available_candidates()) or 'a CJK TrueType face'}")
            gaps = missing_glyphs(font, text)
            if gaps:
                fail(f"{name}: {font} has no glyph for {''.join(gaps[:10])} — it "
                     f"would be drawn as blanks with no error anywhere")
            multiline = bool(records[name]["flags"].get("multiline"))
            size = da_size or _fitting_size(text, font, width, height, multiline)
            _set_text_value(annot, text)
            requests.append({"width": width, "height": height, "size": size,
                             "font": font, "multiline": multiline,
                             "lines": layout_lines(text, font, size, width, multiline)})
            targets.append(annot)
            filled.append({**record, "text": text, "font": da_font, "font_size": size})

    missing = set(values) - {f["name"] for f in filled}
    if missing:
        fail(f"field(s) declared but never reached on any page: {', '.join(sorted(missing))}")

    for annot, stream in zip(targets, build_appearances(writer, requests)):
        _write_appearance(annot, stream)
    _drop_need_appearances(writer)
    return filled


def _write_name(annot, key: str, name: str) -> None:
    from pypdf.generic import NameObject
    node = annot.get_object()
    field = node if "/T" in node else (node.get("/Parent") or node).get_object()
    field[NameObject(key)] = NameObject(name)
    node[NameObject(key)] = NameObject(name)


def _write_appearance(annot, stream) -> None:
    from pypdf.generic import DictionaryObject, NameObject
    node = annot.get_object()
    ap = node.get("/AP")
    if not isinstance(ap, DictionaryObject):
        ap = DictionaryObject()
        node[NameObject("/AP")] = ap
    ap[NameObject("/N")] = stream


def _set_text_value(annot, text: str) -> None:
    from pypdf.generic import NameObject, TextStringObject
    node = annot.get_object()
    field = node if "/T" in node else (node.get("/Parent") or node).get_object()
    field[NameObject("/V")] = TextStringObject(text)


def _drop_need_appearances(writer) -> None:
    """We drew the appearances, so nothing should ask a viewer to redo it.

    Leaving /NeedAppearances true makes every reader that honours it discard the
    streams above and re-lay-out the text with whatever font IT has — which for a
    CJK value is the blank-box failure this whole path exists to avoid.
    """
    from pypdf.generic import BooleanObject, NameObject
    acro = writer._root_object.get("/AcroForm")
    if acro is not None:
        acro.get_object()[NameObject("/NeedAppearances")] = BooleanObject(False)


def _anchor_rect(src: Path, page_number: int, item: dict, rotation: int,
                 page_w: float, page_h: float, password: str | None) -> tuple:
    """A box positioned relative to text found on the page, in PAGE space."""
    import pdfplumber

    anchor = item["anchor"]
    with pdfplumber.open(str(src), password=password) as pdf:
        page = pdf.pages[page_number - 1]
        hits = page.search(anchor, regex=False)
    if not hits:
        fail(f"anchor {anchor!r} not found on page {page_number}")
    if len(hits) > 1:
        # Silently taking the first match is how the value ends up next to the wrong
        # label on a form that repeats a word.
        fail(f"anchor {anchor!r} appears {len(hits)} times on page {page_number}; "
             f"use an explicit \"rect\" or a longer anchor")
    hit = hits[0]
    # pdfplumber reports DISPLAY coordinates; everything written back into the file
    # is page space, and on a rotated page the two are not the same box.
    x0, y0, x1, y1 = to_page_space((hit["x0"], hit["top"], hit["x1"], hit["bottom"]),
                                   rotation, page_w, page_h)
    dx, dy = item.get("offset", [8, 0])
    width = float(item.get("width", 150))
    height = float(item.get("height", (y1 - y0) + 2))
    left, top = x1 + dx, y0 + dy
    return (left, top, left + width, top + height)


def fill_overlay(src: Path, writer, items: list[dict],
                 password: str | None) -> list[dict]:
    import io

    from pypdf import PdfReader
    from reportlab.pdfgen import canvas

    page_count = len(writer.pages)
    by_page: dict[int, list] = {}
    filled: list[dict] = []
    for item in items:
        number = int(item.get("page", 1))
        if not 1 <= number <= page_count:
            fail(f"placement {item.get('name') or item['text']!r} targets page "
                 f"{number}, the document has {page_count}")
        page = writer.pages[number - 1]
        rotation, page_w, page_h = page_geometry(page)
        rect = (tuple(float(v) for v in item["rect"]) if "rect" in item
                else _anchor_rect(src, number, item, rotation, page_w, page_h,
                                  password))
        text = str(item["text"])
        label = item.get("name") or text[:16]
        size = float(item.get("size", DEFAULT_SIZE))
        font = resolve(text, item.get("font"))
        if font is None:
            fail(f"{label}: {text!r} needs a CJK font and none could be found on "
                 f"this machine")
        gaps = missing_glyphs(font, text)
        if gaps:
            fail(f"{label}: {font} has no glyph for {''.join(gaps[:10])} — it would "
                 f"be drawn as blanks with no error anywhere")
        width, height = rect[2] - rect[0], rect[3] - rect[1]
        if width <= 2 * PAD or height <= 0:
            fail(f"{label}: the box {round_box(rect)} is too small to hold anything")
        lines = layout_lines(text, font, size, width, True)
        _, needed = drawn_extent(font, size, height, len(lines), True)
        if needed > height:
            fail(f"{label!r} does not fit its box {round_box(rect)} at size {size} "
                 f"({len(lines)} line(s) need {needed:.1f}pt, the box is "
                 f"{height:.1f}pt tall) — widen the box or lower \"size\"")
        by_page.setdefault(number - 1, []).append((rect, lines, size, font))
        filled.append({"name": label, "page": number, "rect": round_box(rect),
                       "rect_display": round_box(
                           to_display_space(rect, rotation, page_w, page_h)),
                       "text": text, "source": "overlay",
                       "font": font, "font_size": size})

    for index, marks in by_page.items():
        page = writer.pages[index]
        _, page_w, page_h = page_geometry(page)
        buf = io.BytesIO()
        # The canvas is the PAGE, unrotated: a merged overlay composes into the
        # page's own coordinate system before any /Rotate is applied for display.
        c = canvas.Canvas(buf, pagesize=(page_w, page_h))
        c.setFillColorRGB(0, 0, 0)
        for rect, lines, size, font in marks:
            c.setFont(font, size)
            base = rect[1] + first_baseline(font, size, rect[3] - rect[1],
                                            len(lines), True)
            for i, line in enumerate(lines):
                c.drawString(rect[0] + PAD,
                             page_h - base - i * size * LINE_RATIO, line)
        c.showPage()
        c.save()
        buf.seek(0)
        page.merge_page(PdfReader(buf).pages[0])
    return filled


def main() -> None:
    from pypdf import PdfWriter

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

    ensure_distinct(args.src, args.out)
    if not args.values.is_file():
        fail(f"no such values file: {args.values}")
    reader = open_reader(args.src, args.password)
    writer = PdfWriter(clone_from=reader)

    mode = args.mode
    if mode == "auto":
        mode = "acroform" if has_acroform(reader) else "overlay"
    if mode == "acroform" and not has_acroform(reader):
        fail(f"{args.src.name} has no AcroForm fields; use --mode overlay")
    if mode == "acroform":
        values = json.loads(args.values.read_text(encoding="utf-8"))
        if not isinstance(values, dict) or not values:
            fail(f"{args.values.name}: expected a non-empty object of field -> value")
        filled = fill_acroform(reader, writer, values)
    else:
        filled = fill_overlay(args.src, writer, load_placements(args.values),
                              args.password)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("wb") as fh:
        writer.write(fh)

    report = {"source": str(args.src), "out": str(args.out), "mode": mode,
              "filled": filled}
    if args.report:
        write_json(args.report, report)
    print(json.dumps({"out": str(args.out), "mode": mode, "filled": len(filled)},
                     ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(run(main))
