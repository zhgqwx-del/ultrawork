#!/usr/bin/env python3
"""P2 — extract text with bounding boxes.

    python3 pdf_extract.py --in report.pdf --out text.json
    python3 pdf_extract.py --in report.pdf --out text.json --granularity line \
                           --overlay boxes.pdf

Every item carries TWO boxes, in points, origin top-left, y growing downwards:

  bbox          page space — the unrotated frame the PDF stores. This is what
                anything writing back into the file (an annotation, a drawn box)
                has to use.
  bbox_display  image space — the frame a viewer, and pdf_render.py, shows. Scale
                by dpi/72 to land on the PNG.

They differ only when the page carries a /Rotate. Measured on fixtures/report-cjk.pdf
page 3 (rotated 90°): the display box is (502, 60, 517, 450) while the same text
lives at (60, 78, 450, 93) in page space. One box with a hand-wave about "the same
coordinates" is how overlays end up drawn on empty paper, so both are emitted and
both are asserted in scripts/test-pdf-skill.py.

⚠️ The direction of the conversion is the opposite of what it was. pdfplumber
reports DISPLAY coordinates (rotation already applied), so page space is derived by
rotating BACK. The previous implementation used PyMuPDF, which reports page space
and needed the forward rotation. Same two frames, mirrored plumbing — and getting
the direction wrong is silent, because on an unrotated page both are identical.

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
from pdfcommon import (draw_boxes_overlay, ensure_distinct, fail,  # noqa: E402
                       parse_pages, run, to_page_space, write_json)

GRANULARITIES = ("word", "line", "block")
BOX_COLOR = {"word": (0.85, 0.25, 0.10), "line": (0.10, 0.35, 0.85),
             "block": (0.20, 0.55, 0.25)}
# Vertical gap, in points, above which two lines belong to different blocks.
BLOCK_GAP = 12.0


def open_plumber(src: Path, password: str | None):
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect
    if not src.is_file():
        fail(f"no such file: {src}")
    try:
        return pdfplumber.open(str(src), password=password or "")
    except PDFPasswordIncorrect:
        if password is None:
            fail(f"{src.name} is password-protected: pass --password")
        fail(f"the supplied --password was rejected by {src.name}")
    except Exception as e:  # noqa: BLE001 - pdfminer raises several unrelated types
        fail(f"cannot open {src.name} as a PDF: {type(e).__name__}: {e}")


def _round(box) -> list[float]:
    return [round(float(v), 2) for v in box]


def _boxes(box, rotation: int, w: float, h: float) -> dict:
    """Both frames for one box. On an unrotated page they are the same numbers."""
    return {"bbox": _round(to_page_space(box, rotation, w, h)),
            "bbox_display": _round(box)}


def page_items(page, granularity: str) -> list[dict]:
    """One dict per word / line / block, each with its two boxes."""
    rot, w, h = int(page.rotation or 0) % 360, float(page.width), float(page.height)

    def wrap(box, **extra):
        return {**_boxes(box, rot, w, h), **extra}

    if granularity == "word":
        return [{"text": wd["text"],
                 **wrap((wd["x0"], wd["top"], wd["x1"], wd["bottom"]))}
                for wd in page.extract_words(use_text_flow=False)]

    lines = page.extract_text_lines()
    if granularity == "line":
        out = []
        for lno, ln in enumerate(lines):
            chars = ln.get("chars") or []
            out.append({"text": ln["text"],
                        **wrap((ln["x0"], ln["top"], ln["x1"], ln["bottom"])),
                        "line": lno,
                        "font": chars[0].get("fontname") if chars else None,
                        "size": round(chars[0]["size"], 2) if chars else None})
        return out

    # Blocks: consecutive lines separated by less than BLOCK_GAP. pdfplumber has no
    # block concept of its own, and inventing one is better than dropping the
    # granularity — but it IS a heuristic, which is why the report says so.
    blocks: list[dict] = []
    current: list[dict] = []
    for ln in lines:
        if current and ln["top"] - current[-1]["bottom"] > BLOCK_GAP:
            blocks.append(_merge_block(current, rot, w, h, len(blocks)))
            current = []
        current.append(ln)
    if current:
        blocks.append(_merge_block(current, rot, w, h, len(blocks)))
    return blocks


def _merge_block(lines: list[dict], rot: int, w: float, h: float, index: int) -> dict:
    box = (min(l["x0"] for l in lines), min(l["top"] for l in lines),
           max(l["x1"] for l in lines), max(l["bottom"] for l in lines))
    return {"text": "".join(l["text"] for l in lines),
            **_boxes(box, rot, w, h), "block": index,
            "grouping": "heuristic: lines closer than "
                        f"{BLOCK_GAP:g}pt vertically"}


def extract(src: Path, pages: str | None, granularity: str,
            password: str | None, overlay: Path | None) -> dict:
    pdf = open_plumber(src, password)
    try:
        page_count = len(pdf.pages)
        indices = parse_pages(pages, page_count)
        result = {"source": str(src), "granularity": granularity,
                  "page_count": page_count, "pages": []}
        overlay_boxes: dict[int, list] = {}
        for i in indices:
            page = pdf.pages[i]
            items = page_items(page, granularity)
            rot = int(page.rotation or 0) % 360
            w, h = float(page.width), float(page.height)
            # `size` is what a viewer shows (bbox_display lives in it); `mediabox`
            # is the unrotated page (bbox lives in it).
            mw, mh = (h, w) if rot in (90, 270) else (w, h)
            result["pages"].append({
                "number": i + 1,
                "size": [round(w, 2), round(h, 2)],
                "mediabox": [round(mw, 2), round(mh, 2)],
                "rotation": rot,
                "text": page.extract_text() or "",
                "items": items,
            })
            if overlay is not None:
                overlay_boxes[i] = [(it["bbox"], BOX_COLOR[granularity])
                                    for it in items]
        if overlay is not None:
            draw_boxes_overlay(src, overlay, overlay_boxes, password)
            result["overlay"] = str(overlay)
        return result
    finally:
        pdf.close()


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

    if args.overlay:
        ensure_distinct(args.src, args.overlay, "--overlay")
    result = extract(args.src, args.pages, args.granularity, args.password, args.overlay)
    write_json(args.out, result)
    print(json.dumps({"out": str(args.out), "pages": len(result["pages"]),
                      "items": sum(len(p["items"]) for p in result["pages"]),
                      "overlay": result.get("overlay")}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(run(main))
