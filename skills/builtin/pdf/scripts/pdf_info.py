#!/usr/bin/env python3
"""P4 — document metadata: page count, per-page size and rotation, encryption state.

    python3 pdf_info.py --in report.pdf
    python3 pdf_info.py --in locked.pdf --out info.json           # works while locked
    python3 pdf_info.py --in locked.pdf --password secret --out info.json

A locked document still answers "are you encrypted?", so this is the one entry
point that accepts a file it cannot read: it reports `locked: true`, the page
count, and a null page list rather than refusing. Everything derived from the page
CONTENTS is then absent instead of zero — `pages: []` would be indistinguishable
from an empty file, while `page_count: 1` is a fact the file gives up freely.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import compact, open_reader, run, write_json  # noqa: E402

PT_PER_MM = 72.0 / 25.4
# Common sizes, in points, keyed by (width, height) portrait. Tolerance is 3pt:
# A4 is 595.276 x 841.89 and producers round it in several different ways.
PAPER = {(595.28, 841.89): "A4", (612.0, 792.0): "Letter", (842.0, 1191.0): "A3",
         (420.0, 595.0): "A5", (612.0, 1008.0): "Legal"}
PAPER_TOLERANCE = 3.0

# The eight user-permission bits of the standard security handler, under the names
# a person would use rather than the spec's.
PERMISSION_BITS = {
    "print": "PRINT", "modify": "MODIFY", "copy": "EXTRACT",
    "annotate": "ADD_OR_MODIFY", "form": "FILL_FORM_FIELDS",
    "accessibility": "EXTRACT_TEXT_AND_GRAPHICS", "assemble": "ASSEMBLE_DOC",
    "print_hq": "PRINT_TO_REPRESENTATION",
}

# (V, R) of the encryption dictionary -> what people call it.
ALGORITHM = {(1, 2): "RC4 40-bit", (2, 3): "RC4 128-bit", (4, 4): "AES-128",
             (5, 5): "AES-256 (revision 5)", (5, 6): "AES-256"}


def paper_name(w: float, h: float) -> str | None:
    short, long = min(w, h), max(w, h)
    for (pw, ph), name in PAPER.items():
        if abs(short - pw) <= PAPER_TOLERANCE and abs(long - ph) <= PAPER_TOLERANCE:
            return name
    return None


def permission_flags(bits) -> dict | None:
    from pypdf.constants import UserAccessPermissions as Perm
    if bits is None:
        return None
    return {name: bool(int(bits) & int(getattr(Perm, flag)))
            for name, flag in PERMISSION_BITS.items()}


def algorithm_name(reader) -> str | None:
    enc = getattr(reader, "_encryption", None)
    if enc is None:
        return None
    key = (getattr(enc, "V", None), getattr(enc, "R", None))
    return ALGORITHM.get(key, f"V{key[0]} R{key[1]}")


def readable(reader) -> bool:
    """Can the page tree actually be walked, or is it still locked?

    pypdf keeps `is_encrypted` True even after a successful decrypt(), so that flag
    answers "was this file encrypted", not "can I read it". Those are different
    questions and this script reports both.
    """
    try:
        len(reader.pages)
        return True
    except Exception:  # noqa: BLE001 - FileNotDecryptedError and friends
        return False


def locked_page_count(reader) -> int | None:
    """How many pages a still-locked document has, or None if even that is hidden.

    Encryption in a PDF covers strings and streams, not the object graph: the page
    tree node is a plain dictionary and its /Count is a plain number, which is why
    "how many pages" is answerable without the password. pypdf refuses anyway — its
    guard is per-object rather than per-value — so it is lifted for this one read,
    which touches a number and nothing else.

    None is still possible and is the honest answer for it: a file whose catalogue
    lives in a compressed object stream keeps that stream encrypted, and then the
    count really is unreadable.
    """
    previous = reader._override_encryption
    try:
        reader._override_encryption = True
        count = reader.trailer["/Root"].get_object()["/Pages"].get_object().get("/Count")
        return int(count) if count is not None else None
    except Exception:  # noqa: BLE001 - an unreadable catalogue is not a crash
        return None
    finally:
        reader._override_encryption = previous


def safe_metadata(reader) -> dict:
    """The info dictionary, or {} while the file is still locked.

    Not just the page tree: `reader.metadata` reaches into encrypted objects too and
    raises FileNotDecryptedError. This entry point exists to answer questions about
    a file it cannot read, so every lookup on that path has to survive being locked.
    """
    try:
        raw = dict(reader.metadata or {})
    except Exception:  # noqa: BLE001 - FileNotDecryptedError and friends
        return {}
    return {k.lstrip("/").lower(): v for k, v in raw.items()}


def describe(src: Path, password: str | None) -> dict:
    reader = open_reader(src, password, allow_locked=True)
    encrypted = bool(reader.is_encrypted)
    locked = encrypted and not readable(reader)
    meta = safe_metadata(reader)
    info = {
        "file": str(src),
        "file_size": src.stat().st_size,
        "format": reader.pdf_header,
        "encrypted": encrypted,
        # Readable from the encryption dictionary even while locked, so
        # "encrypted but algorithm unknown" is not a state this can report.
        "encryption": algorithm_name(reader),
        "locked": locked,
        # The permission bits live outside the encrypted streams and are readable
        # while locked — reporting null would understate what is known.
        "permissions": permission_flags(reader.user_access_permissions)
        if encrypted else None,
        "metadata": {k: meta.get(k) for k in
                     ("title", "author", "subject", "keywords", "creator",
                      "producer", "creationdate", "moddate")},
    }
    if locked:
        info["page_count"] = locked_page_count(reader)
        info["pages"] = None
        info["pages_unavailable"] = ("document is locked; page geometry needs the "
                                     "password")
        return info
    pages = []
    for i, page in enumerate(reader.pages, 1):
        box = page.mediabox
        mw, mh = float(box.width), float(box.height)
        # What a viewer shows has the rotation applied; the mediabox is the box as
        # stored. A page authored landscape and rotated 90° displays portrait, so
        # reporting only one of the two makes "the page size" ambiguous.
        rot = int(page.rotation) % 360
        w, h = (mh, mw) if rot in (90, 270) else (mw, mh)
        pages.append({
            "number": i,
            "width_pt": round(w, 2), "height_pt": round(h, 2),
            "width_mm": round(w / PT_PER_MM, 1), "height_mm": round(h / PT_PER_MM, 1),
            "mediabox_pt": [round(mw, 2), round(mh, 2)],
            "paper": paper_name(w, h),
            "rotation": rot,
            "orientation": "landscape" if w > h else "portrait",
        })
    info["page_count"] = len(pages)
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
    print(json.dumps(compact(info, "pages", args.out), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(run(main))
