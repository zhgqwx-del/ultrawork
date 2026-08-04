#!/usr/bin/env python3
"""Edit a .pptx: replace text, add a slide with a title. ultrawork pptx-edit skill.

Two measured limits, both stated in SKILL.md 「限制」: replacement is per-run, so a
phrase PowerPoint split across runs does not match; and only top-level shapes with a
text frame are visited, so text inside tables/groups is left untouched — while the
printed `replacements: N` counts only what WAS replaced and cannot warn about that.
"""
from __future__ import annotations
import argparse, sys

def _require():
    try:
        import pptx  # noqa: F401
        return pptx
    except ImportError:
        print("Missing dependency: python-pptx (pip install python-pptx)", file=sys.stderr)
        raise SystemExit(1)

def _replace_in_shape(shape, old, new):
    if not shape.has_text_frame:
        return 0
    n = 0
    for para in shape.text_frame.paragraphs:
        for run in para.runs:
            if old in run.text:
                run.text = run.text.replace(old, new)
                n += 1
    return n

def main(argv):
    ap = argparse.ArgumentParser(description="Edit a .pptx in place (or --out)")
    ap.add_argument("file")
    ap.add_argument("--replace", nargs=2, metavar=("OLD", "NEW"), action="append", default=[])
    ap.add_argument("--add-slide", action="store_true")
    ap.add_argument("--layout", type=int, default=1, help="slide layout index for --add-slide")
    ap.add_argument("--title", default="", help="title text for the new slide")
    ap.add_argument("--out", help="write to this path instead of in place")
    args = ap.parse_args(argv)
    pptx = _require()
    try:
        prs = pptx.Presentation(args.file)
    except Exception as exc:  # noqa: BLE001
        print(f"Error opening {args.file}: {exc}", file=sys.stderr)
        return 1
    total = 0
    for old, new in args.replace:
        for slide in prs.slides:
            for shape in slide.shapes:
                total += _replace_in_shape(shape, old, new)
    added = 0
    if args.add_slide:
        # len(prs.slide_layouts) itself reaches through slide_masters[0], which
        # raises IndexError on a .pptx that carries no master — minimal OOXML
        # generators produce those, and the bound check must not be the thing that
        # crashes (measured on a real 10-part .pptx with no ppt/slideMasters).
        try:
            n_layouts = len(prs.slide_layouts)
        except Exception as exc:  # noqa: BLE001
            print(f"Cannot add a slide to {args.file}: it has no slide master ({exc})", file=sys.stderr)
            return 1
        if args.layout < 0 or args.layout >= n_layouts:
            print(f"Bad --layout {args.layout} (have 0..{n_layouts - 1})", file=sys.stderr)
            return 1
        slide = prs.slides.add_slide(prs.slide_layouts[args.layout])
        if args.title and slide.shapes.title is not None:
            slide.shapes.title.text = args.title
        added = 1
    out = args.out or args.file
    prs.save(out)
    print(f"Saved {out} (replacements: {total}, slides added: {added})")
    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
