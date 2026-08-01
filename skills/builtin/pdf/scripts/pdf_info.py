#!/usr/bin/env python3
"""P4 — document metadata: page count, per-page size and rotation, encryption state.

    python3 pdf_info.py --in report.pdf
    python3 pdf_info.py --in locked.pdf --out info.json           # works while locked
    python3 pdf_info.py --in locked.pdf --password secret --out info.json

A locked document still answers "are you encrypted?", so this is the one entry
point that accepts a file it cannot read: it reports `locked: true` with a null
page count rather than refusing. Everything derived from the pages is then absent
instead of zero — `page_count: 0` would be indistinguishable from an empty file.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import open_pdf, run, write_json  # noqa: E402

PT_PER_MM = 72.0 / 25.4
# Common sizes, in points, keyed by (width, height) portrait. Tolerance is 3pt:
# A4 is 595.276 x 841.89 and producers round it in several different ways.
PAPER = {(595.28, 841.89): "A4", (612.0, 792.0): "Letter", (842.0, 1191.0): "A3",
         (420.0, 595.0): "A5", (612.0, 1008.0): "Legal"}
PAPER_TOLERANCE = 3.0


def paper_name(w: float, h: float) -> str | None:
    short, long = min(w, h), max(w, h)
    for (pw, ph), name in PAPER.items():
        if abs(short - pw) <= PAPER_TOLERANCE and abs(long - ph) <= PAPER_TOLERANCE:
            return name
    return None


def permission_flags(bits: int) -> dict:
    import fitz

    return {name.lower(): bool(bits & getattr(fitz, f"PDF_PERM_{name}")) for name in
            ("PRINT", "MODIFY", "COPY", "ANNOTATE", "FORM", "ACCESSIBILITY",
             "ASSEMBLE", "PRINT_HQ")}


def describe(src: Path, password: str | None) -> dict:
    doc = open_pdf(src, password, allow_locked=True)
    with doc:
        # While the document is still locked every metadata field comes back None —
        # including `encryption`. Deriving "encrypted" from that string alone answers
        # "no" for the one file everybody would call encrypted, so the lock state has
        # to be part of the evidence.
        locked = bool(doc.is_encrypted)
        meta = dict(doc.metadata or {})
        info = {
            "file": str(src),
            "file_size": src.stat().st_size,
            "format": meta.get("format"),
            "encrypted": locked or bool(meta.get("encryption")),
            # The algorithm string survives authentication but is unreadable while
            # locked, hence null-but-encrypted is a legitimate combination.
            "encryption": meta.get("encryption"),
            "locked": locked,
            "permissions": None if locked else permission_flags(int(doc.permissions)),
            "metadata": {k: meta.get(k) for k in
                         ("title", "author", "subject", "keywords", "creator",
                          "producer", "creationDate", "modDate")},
            # The page tree is not encrypted, so the count is readable even while the
            # content is not — reporting null here would understate what is known.
            "page_count": doc.page_count,
        }
        if locked:
            info["pages"] = None
            info["pages_unavailable"] = "document is locked; page geometry needs the password"
            return info
        pages = []
        for i, page in enumerate(doc, 1):
            # page.rect is what a viewer shows (rotation applied); mediabox is the
            # box as stored. A page authored landscape and rotated 90° has a portrait
            # rect, so reporting only one of the two makes "the page size" ambiguous.
            r, mb = page.rect, page.mediabox
            pages.append({
                "number": i,
                "width_pt": round(r.width, 2), "height_pt": round(r.height, 2),
                "width_mm": round(r.width / PT_PER_MM, 1),
                "height_mm": round(r.height / PT_PER_MM, 1),
                "mediabox_pt": [round(mb.width, 2), round(mb.height, 2)],
                "paper": paper_name(r.width, r.height),
                "rotation": page.rotation,
                "orientation": "landscape" if r.width > r.height else "portrait",
            })
        info["pages"] = pages
        info["uniform_size"] = len({(p["width_pt"], p["height_pt"]) for p in pages}) == 1
        return info


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", dest="out", type=Path, default=None,
                    help="write the JSON here (default: stdout only)")
    ap.add_argument("--password", default=None)
    args = ap.parse_args()

    info = describe(args.src, args.password)
    if args.out:
        write_json(args.out, info)
    print(json.dumps(info, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(run(main))
