#!/usr/bin/env python3
"""P9 + P10 — did the values stay inside their boxes, and show me.

    python3 pdf_form_check.py --in filled.pdf --out overflow.json
    python3 pdf_form_check.py --in filled.pdf --report fill.json \
            --out overflow.json --proof proof.pdf

P9 measures two independent things per field, because each misses what the other
catches:

  natural width  what the string NEEDS at its font size. Catches the case a viewer
                 hides by clipping — the value is simply not visible and the raster
                 looks fine.
  rendered span  where the glyphs actually ARE. Catches text that was drawn outside
                 its box, which a width calculation cannot see.

The second one is only answerable after the widgets are FLATTENED: an AcroForm
value lives in the widget's /AP stream, and every text reader in this skill's
toolbox — pdfplumber, pdfminer, PDFium — reads the page content stream and nothing
else. So a throwaway copy is made with each appearance painted onto its page, and
the glyphs are measured there. That copy is never written anywhere the caller can
mistake it for the document.

P10 (--proof) draws every field: green box = fits, red = overflows, with the field
name beside it. That is the artifact a human can check in one look, and it is a
real PDF so the L2 gate can check it too.

Exit 0 even when overflows are found — the report is the product. --fail-on-overflow
makes it exit 3 for use in a pipeline.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import (draw_boxes_overlay, ensure_distinct, fail,  # noqa: E402
                       open_reader, run, to_page_space, write_json)
from pdffont import resolve  # noqa: E402
from pdfform import (collect_fields, flatten_appearances, layout_lines,  # noqa: E402
                     round_box, text_width)

EDGE_TOLERANCE = 0.5    # points a glyph may poke SIDEWAYS past the box
WIDTH_MARGIN = 2.0      # points of padding a viewer keeps inside the box

# The vertical tolerances are asymmetric because the two directions are not the same
# phenomenon. Re-measured 2026-08-02 against the pypdf/reportlab implementation,
# reading the flattened copy with pdfplumber (excursion in points, + = outside the
# box); the numbers a PyMuPDF build produced are not these, and a tolerance carried
# over from it would be calibrated against a layout that no longer exists:
#
#                                         above the top      below the bottom
#   fixtures/form-filled.pdf, 4 values ..  -3.43 .. -3.50    -3.43 .. -18.84
#   this skill's own fill, 5 values .....  -3.12 .. -3.50    -3.50 .. -22.00
#   checkbox tick (never measured) ......  +2.80             -2.80
#   remark overflowing (the real defect)   (inside)          +2.00
#
# Every correct value now sits at least 3.1pt inside both edges, because the layout
# in pdfform.py places text from the font's real ascent and descent rather than
# from the em size. So the bottom tolerance is small: it only has to survive
# rounding, and a value that pokes out at all is the multiline case that ran out of
# room. The top keeps a wider allowance — sticking up is glyph ascent on a field
# whose /DA size is bigger than its box, which is ugly rather than wrong.
TOP_ASCENT_RATIO = 0.35     # 3.5pt at size 10
BOTTOM_SPILL_RATIO = 0.05   # 0.5pt at size 10; sits inside the -3.43 .. +2.00 band
FITS, OVERFLOWS, UNKNOWN, NA = "fits", "overflows", "unknown", "not_applicable"

# Only these hold a value whose LENGTH can exceed the box. A checkbox is drawn by
# the viewer from a dingbat, and measuring it produced exactly the false positive
# this constant exists to stop: the tick in fixtures/form-acroform.pdf sits 2.8pt
# above its own box by ascent and was reported as an overflowing field. They are
# still listed and still drawn on the proof sheet, but as `not_applicable` and
# counted separately — "not measurable" must never be filed under "fine".
MEASURABLE = {"text", "combobox", "listbox", "overlay"}

GREEN, RED, GREY = (0.13, 0.55, 0.24), (0.80, 0.16, 0.16), (0.45, 0.45, 0.45)


def fields_to_check(reader, report: Path | None) -> list[dict]:
    """AcroForm widgets, plus whatever an overlay fill reported placing.

    Overlay text is not a widget — nothing in the file marks where it was meant to
    go — so without the fill report the overlay half of P8 would be unverifiable.
    """
    fields = [f for f in collect_fields(reader) if str(f.get("value") or "").strip()]
    if report is None:
        return fields
    if not report.is_file():
        fail(f"no such fill report: {report}")
    data = json.loads(report.read_text(encoding="utf-8"))
    placed = data.get("filled") if isinstance(data, dict) else data
    if not isinstance(placed, list):
        fail(f"{report.name}: expected a \"filled\" list (written by pdf_form_fill.py --report)")
    known = {(f["name"], f["page"]) for f in fields}
    for item in placed:
        if (item.get("name"), item.get("page")) in known:
            continue      # already present as a widget; do not double-count
        fields.append({"name": item.get("name"), "page": int(item.get("page", 1)),
                       "rect": item["rect"],
                       "rect_display": item.get("rect_display", item["rect"]),
                       "value": item.get("text", ""), "type": "overlay",
                       "font": item.get("font"), "font_size": item.get("font_size"),
                       # Overlay text is always wrapped to its box by the filler, so
                       # it is measured the way a multiline field is: the question is
                       # whether the WRAPPED lines fit, not whether one line would.
                       "flags": {"multiline": True}, "source": "overlay"})
    return fields


def rendered_spans(src: Path, password: str | None, work: Path) -> dict:
    """{page number: [(box in PAGE space, text)]} for everything actually drawn."""
    import pdfplumber

    flat = work / "flattened.pdf"
    flatten_appearances(src, flat, password)
    spans: dict[int, list] = {}
    with pdfplumber.open(str(flat), password=password) as pdf:
        for number, page in enumerate(pdf.pages, 1):
            rotation = int(page.rotation or 0) % 360
            found = []
            for word in page.extract_words():
                if not word["text"].strip():
                    continue
                # pdfplumber reports DISPLAY coordinates; every box in this report is
                # page space, and on a /Rotate page the two are different rectangles.
                found.append((to_page_space(
                    (word["x0"], word["top"], word["x1"], word["bottom"]),
                    rotation, float(page.width), float(page.height)), word["text"]))
            spans[number] = found
    return spans


def natural_width(field: dict, size: float, width: float) -> float | None:
    """What the value needs on its widest line, or None when it cannot be measured.

    A multiline field is measured line by line after wrapping: comparing the whole
    string against the box width says "overflows" about every paragraph that was
    always going to take two lines, which is not a defect and drowns the ones that
    are.
    """
    value = str(field.get("value") or "")
    if not field["flags"].get("multiline"):
        return text_width(value, field.get("font"), size)
    font = resolve(value, field.get("font"))
    if font is None:
        return None
    widths = [text_width(line, font, size)
              for line in layout_lines(value, font, size, width, True)]
    return None if any(w is None for w in widths) else max(widths or [0.0])


def check_field(spans: list, field: dict) -> dict:
    rect = [float(v) for v in field["rect"]]
    x0, y0, x1, y1 = rect
    box_w, box_h = x1 - x0, y1 - y0
    value = str(field.get("value") or "")
    size = field.get("font_size") or 0
    result = {"name": field["name"], "page": field["page"], "type": field.get("type"),
              "rect": round_box(rect), "value": value, "verdict": FITS, "reasons": []}

    if field.get("type") not in MEASURABLE:
        result["verdict"] = NA
        result["reasons"].append(f"a {field.get('type')} field carries no text whose "
                                 f"length could exceed the box")
        return result

    # 1) natural width. A zero/absent font size means the viewer auto-sizes the text
    # to fit, so the measurement does not apply — say unknown, never "fits".
    if size:
        natural = natural_width(field, size, box_w)
        if natural is None:
            result["verdict"] = UNKNOWN
            result["reasons"].append(f"no usable font for {field.get('font')!r}; "
                                     f"natural width could not be measured")
        else:
            result["natural_width"] = round(natural, 2)
            result["box_width"] = round(box_w, 2)
            if natural > box_w - WIDTH_MARGIN:
                result["verdict"] = OVERFLOWS
                result["reasons"].append(
                    f"needs {natural:.1f}pt, box is {box_w:.1f}pt wide")
    else:
        result["reasons"].append("font size 0 (viewer auto-sizes); width not measured")

    # 2) where the glyphs actually landed
    ref = size or 10.0
    top_tol = max(EDGE_TOLERANCE, TOP_ASCENT_RATIO * ref)
    bottom_tol = max(EDGE_TOLERANCE, BOTTOM_SPILL_RATIO * ref)
    for box, text in spans:
        bx0, by0, bx1, by1 = box
        if bx1 <= x0 or bx0 >= x1 or by1 <= y0 or by0 >= y1:
            continue                       # does not touch this field's box at all
        why = None
        if bx1 > x1 + EDGE_TOLERANCE or bx0 < x0 - EDGE_TOLERANCE:
            why = "sideways"
        elif by1 > y1 + bottom_tol:
            # The multiline case: the value needed more lines than the box has, and
            # nothing else here can see it — the natural-width rule measures the
            # wrapped lines, which by construction all fit the width.
            why = f"below the bottom by {by1 - y1:.1f}pt"
        elif by0 < y0 - top_tol:
            why = f"above the top by {y0 - by0:.1f}pt"
        if why:
            result["verdict"] = OVERFLOWS
            result["reasons"].append(
                f"rendered text {text[:16]!r} runs {why}: span "
                f"{round_box(box)}, box {round_box(rect)}")
    return result


def draw_proof(src: Path, results: list[dict], out: Path,
               password: str | None) -> None:
    boxes: dict[int, list] = {}
    labels: dict[int, list] = {}
    for res in results:
        index = res["page"] - 1
        x0, y0, x1, y1 = (float(v) for v in res["rect"])
        color = {FITS: GREEN, OVERFLOWS: RED}.get(res["verdict"], GREY)  # grey = not measured
        boxes.setdefault(index, []).append(((x0, y0, x1, y1), color))
        # Above the box when there is room, otherwise just below it — a label drawn
        # off the top of the page is a label nobody reads.
        y = y0 - 3 if y0 > 12 else y1 + 9
        labels.setdefault(index, []).append(
            (x0, y, f"{res['name']} · {res['verdict']}", color))
    # Field names can be anything, including Chinese; Helvetica would draw those as
    # blanks and the proof sheet would label the wrong-looking box with nothing.
    joined = " ".join(str(r["name"] or "") for r in results)
    font = resolve(joined) or "Helvetica"
    draw_boxes_overlay(src, out, boxes, password=password, width=0.9,
                       labels_by_page=labels, label_font=font)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--report", type=Path, default=None,
                    help="fill report from pdf_form_fill.py (needed for overlay fills)")
    ap.add_argument("--out", type=Path, default=None, help="write the findings here")
    ap.add_argument("--proof", type=Path, default=None,
                    help="write an annotated copy: green = fits, red = overflows")
    ap.add_argument("--password", default=None)
    ap.add_argument("--fail-on-overflow", action="store_true")
    args = ap.parse_args()

    if args.proof:
        ensure_distinct(args.src, args.proof, "--proof")
    reader = open_reader(args.src, args.password)
    fields = fields_to_check(reader, args.report)
    with tempfile.TemporaryDirectory(prefix="pdf-form-check-") as tmp:
        spans = rendered_spans(args.src, args.password, Path(tmp))
    results = [check_field(spans.get(f["page"], []), f) for f in fields]
    measured = [r for r in results if r["verdict"] in (FITS, OVERFLOWS)]
    summary = {"source": str(args.src), "fields_seen": len(results),
               # "checked" counts only what was actually measured, so a run whose
               # fields were all unmeasurable cannot read as a clean check.
               "checked": len(measured),
               "overflowing": sum(1 for r in results if r["verdict"] == OVERFLOWS),
               "unknown": sum(1 for r in results if r["verdict"] == UNKNOWN),
               "not_applicable": sum(1 for r in results if r["verdict"] == NA),
               "fields": results}
    if args.proof:
        draw_proof(args.src, results, args.proof, args.password)
        summary["proof"] = str(args.proof)

    if args.out:
        write_json(args.out, summary)
    print(json.dumps({k: v for k, v in summary.items() if k != "fields"},
                     ensure_ascii=False))
    if args.fail_on_overflow and summary["overflowing"]:
        sys.exit(3)


if __name__ == "__main__":
    sys.exit(run(main))
