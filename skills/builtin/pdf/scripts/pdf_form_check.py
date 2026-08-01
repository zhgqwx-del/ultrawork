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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import fail, open_pdf, run, write_json  # noqa: E402
from pdfform import collect_fields, round_box, text_width  # noqa: E402

EDGE_TOLERANCE = 0.5    # points a glyph may poke SIDEWAYS past the box
WIDTH_MARGIN = 2.0      # points of padding a viewer keeps inside the box

# The vertical tolerances are asymmetric because the two directions are not the same
# phenomenon, and one shared 0.5pt figure produced false positives on correctly
# filled fields. Measured on the fixtures (excursion in points, + = outside the box):
#
#                          above the top      below the bottom
#   correctly filled ....  +0.40 .. +1.04     -2.51 and lower (always inside)
#   checkbox tick .......  +0.71              -0.71
#   remark overflowing ..  (inside)           +3.65   <- the real defect
#
# Sticking out at the TOP is glyph ascent: every correct fill does it. Sticking out
# at the BOTTOM is a value that ran out of room, and no correct fill did it. So the
# top gets a generous ascent allowance and the bottom a tight one, both scaled by
# font size rather than fixed, since both effects scale with the glyphs.
TOP_ASCENT_RATIO = 0.35     # 3.5pt at size 10; measured worst correct case 0.116x
BOTTOM_SPILL_RATIO = 0.15   # 1.5pt at size 10; sits inside the -2.51 .. +3.65 band
FITS, OVERFLOWS, UNKNOWN, NA = "fits", "overflows", "unknown", "not_applicable"

# Only these hold a value whose LENGTH can exceed the box. A checkbox is drawn by
# the viewer from a dingbat, and measuring it produced exactly the false positive
# this constant exists to stop: the tick in fixtures/form-acroform.pdf sits 0.71pt
# above its own box by ascent and was reported as an overflowing field. They are
# still listed and still drawn on the proof sheet, but as `not_applicable` and
# counted separately — "not measurable" must never be filed under "fine".
MEASURABLE = {"text", "combobox", "listbox", "overlay"}

GREEN, RED, GREY = (0.13, 0.55, 0.24), (0.80, 0.16, 0.16), (0.45, 0.45, 0.45)


def fields_to_check(doc, report: Path | None) -> list[dict]:
    """AcroForm widgets, plus whatever an overlay fill reported placing.

    Overlay text is not a widget — nothing in the file marks where it was meant to
    go — so without the fill report the overlay half of P8 would be unverifiable.
    """
    fields = [f for f in collect_fields(doc) if str(f.get("value") or "").strip()]
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
                       "flags": {}, "source": "overlay"})
    return fields


def check_field(page, field: dict) -> dict:
    import fitz

    rect = fitz.Rect(field["rect"])
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
        natural = text_width(value, field.get("font"), size)
        if natural is None:
            result["verdict"] = UNKNOWN
            result["reasons"].append(f"no usable font for {field.get('font')!r}; "
                                     f"natural width could not be measured")
        else:
            result["natural_width"] = round(natural, 2)
            result["box_width"] = round(rect.width, 2)
            if natural > rect.width - WIDTH_MARGIN:
                result["verdict"] = OVERFLOWS
                result["reasons"].append(
                    f"needs {natural:.1f}pt, box is {rect.width:.1f}pt wide")
    else:
        result["reasons"].append("font size 0 (viewer auto-sizes); width not measured")

    # 2) where the glyphs actually landed
    ref = size or 10.0
    top_tol = max(EDGE_TOLERANCE, TOP_ASCENT_RATIO * ref)
    bottom_tol = max(EDGE_TOLERANCE, BOTTOM_SPILL_RATIO * ref)
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                box = fitz.Rect(span["bbox"])
                if not box.intersects(rect) or not span["text"].strip():
                    continue
                why = None
                if box.x1 > rect.x1 + EDGE_TOLERANCE or box.x0 < rect.x0 - EDGE_TOLERANCE:
                    why = "sideways"
                elif box.y1 > rect.y1 + bottom_tol:
                    # The multiline case: the value needed more lines than the box has,
                    # and nothing else here can see it — the natural-width rule only
                    # measures one line.
                    why = f"below the bottom by {box.y1 - rect.y1:.1f}pt"
                elif box.y0 < rect.y0 - top_tol:
                    why = f"above the top by {rect.y0 - box.y0:.1f}pt"
                if why:
                    result["verdict"] = OVERFLOWS
                    result["reasons"].append(
                        f"rendered text {span['text'][:16]!r} runs {why}: span "
                        f"{round_box(box)}, box {round_box(rect)}")
    return result


def draw_proof(doc, results: list[dict], out: Path) -> None:
    import fitz

    for res in results:
        page = doc[res["page"] - 1]
        rect = fitz.Rect(res["rect"])
        color = {FITS: GREEN, OVERFLOWS: RED}.get(res["verdict"], GREY)  # grey = not measured
        page.draw_rect(rect, color=color, width=0.9)
        label = f"{res['name']} · {res['verdict']}"
        # Above the box when there is room, otherwise just below it — a label drawn
        # off the top of the page is a label nobody reads.
        y = rect.y0 - 3 if rect.y0 > 12 else rect.y1 + 9
        page.insert_text((rect.x0, y), label, fontname="helv", fontsize=6, color=color)
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out), garbage=4, deflate=True, no_new_id=True)


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

    doc = open_pdf(args.src, args.password)
    with doc:
        fields = fields_to_check(doc, args.report)
        results = [check_field(doc[f["page"] - 1], f) for f in fields]
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
            draw_proof(doc, results, args.proof)
            summary["proof"] = str(args.proof)

    if args.out:
        write_json(args.out, summary)
    print(json.dumps({k: v for k, v in summary.items() if k != "fields"},
                     ensure_ascii=False))
    if args.fail_on_overflow and summary["overflowing"]:
        sys.exit(3)


if __name__ == "__main__":
    sys.exit(run(main))
