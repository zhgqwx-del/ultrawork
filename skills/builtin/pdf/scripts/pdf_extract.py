#!/usr/bin/env python3
"""P2 — extract text with bounding boxes.

    python3 pdf_extract.py --in report.pdf --out text.json
    python3 pdf_extract.py --in report.pdf --out text.json --granularity line \
                           --overlay boxes.pdf

Every item carries TWO boxes, in points, origin top-left, y growing downwards:

  bbox          page space — the unrotated frame. This is what PyMuPDF's own
                drawing and annotation calls expect, so it is the one to use when
                writing back into the PDF.
  bbox_display  image space — the frame a viewer (and pdf_render.py) shows. Scale
                by dpi/72 to land on the PNG.

They differ only when the page carries a /Rotate. Measured on fixtures/report-cjk.pdf
page 3 (rotated 90°): the extracted box is (60, 75, 450, 93) while the text is
rendered at (502, 60, 520, 450) — 36 dark pixels under the first box versus 2282
under the second. One box with a hand-wave about "the same coordinates" is how
overlays end up drawn on empty paper, so both are emitted and both are asserted in
scripts/test-pdf-skill.py.

--overlay writes a copy of the document with every reported box stroked onto the
page. It is the cheapest way to see whether the coordinates mean what they claim,
and it is deliberately a *copy*: the text layer must come through untouched.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import open_pdf, parse_pages, run, write_json  # noqa: E402

GRANULARITIES = ("word", "line", "block")
BOX_COLOR = {"word": (0.85, 0.25, 0.10), "line": (0.10, 0.35, 0.85),
             "block": (0.20, 0.55, 0.25)}


def _round_box(box) -> list[float]:
    return [round(float(v), 2) for v in box]


def _boxes(page, box) -> dict:
    """Both frames for one box. On an unrotated page they are the same numbers."""
    import fitz

    return {"bbox": _round_box(box),
            "bbox_display": _round_box(fitz.Rect(box) * page.rotation_matrix)}


def page_items(page, granularity: str) -> list[dict]:
    """One dict per word / line / block, each with its two boxes."""
    if granularity == "word":
        # (x0, y0, x1, y1, word, block_no, line_no, word_no)
        return [{"text": wd[4], **_boxes(page, wd[:4]),
                 "block": wd[5], "line": wd[6], "word": wd[7]}
                for wd in page.get_text("words")]
    items: list[dict] = []
    for bno, block in enumerate(page.get_text("dict")["blocks"]):
        lines = block.get("lines")
        if not lines:                      # image block: no text to report
            continue
        if granularity == "block":
            text = "".join(sp["text"] for ln in lines for sp in ln["spans"])
            items.append({"text": text, **_boxes(page, block["bbox"]), "block": bno})
            continue
        for lno, line in enumerate(lines):
            spans = line["spans"]
            items.append({
                "text": "".join(sp["text"] for sp in spans),
                **_boxes(page, line["bbox"]), "block": bno, "line": lno,
                "font": spans[0]["font"] if spans else None,
                "size": round(spans[0]["size"], 2) if spans else None,
            })
    return items


def extract(src: Path, pages: str | None, granularity: str,
            password: str | None, overlay: Path | None) -> dict:
    import fitz

    doc = open_pdf(src, password)
    with doc:
        indices = parse_pages(pages, doc.page_count)
        result = {"source": str(src), "granularity": granularity,
                  "page_count": doc.page_count, "pages": []}
        for i in indices:
            page = doc[i]
            items = page_items(page, granularity)
            result["pages"].append({
                "number": i + 1,
                # `size` is what a viewer shows (bbox_display lives in it); `mediabox`
                # is the unrotated page (bbox lives in it).
                "size": [round(page.rect.width, 2), round(page.rect.height, 2)],
                "mediabox": [round(page.mediabox.width, 2),
                             round(page.mediabox.height, 2)],
                "rotation": page.rotation,
                "text": page.get_text(),
                "items": items,
            })
            if overlay is not None:
                # draw_rect takes PAGE space, which is why `bbox` and not
                # `bbox_display` goes here — verified on the rotated fixture page.
                color = BOX_COLOR[granularity]
                for it in items:
                    page.draw_rect(fitz.Rect(it["bbox"]), color=color, width=0.4)
        if overlay is not None:
            overlay.parent.mkdir(parents=True, exist_ok=True)
            doc.save(str(overlay))
            result["overlay"] = str(overlay)
        return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", dest="out", required=True, type=Path,
                    help="JSON file to write")
    ap.add_argument("--pages", default=None, help="1-based, e.g. 1-3,7 (default: all)")
    ap.add_argument("--granularity", default="word", choices=list(GRANULARITIES))
    ap.add_argument("--password", default=None)
    ap.add_argument("--overlay", type=Path, default=None,
                    help="write a copy of the PDF with the boxes drawn on it")
    args = ap.parse_args()

    result = extract(args.src, args.pages, args.granularity, args.password, args.overlay)
    write_json(args.out, result)
    print(json.dumps({"out": str(args.out), "pages": len(result["pages"]),
                      "items": sum(len(p["items"]) for p in result["pages"]),
                      "overlay": result.get("overlay")}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(run(main))
