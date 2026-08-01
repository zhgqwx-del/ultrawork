#!/usr/bin/env python3
"""P5 + P6 — is this PDF fillable, and what are its fields?

    python3 pdf_form_inspect.py --in form.pdf --summary       # P5: is it fillable
    python3 pdf_form_inspect.py --in form.pdf --out fields.json  # P6: every field

P5 is the cheap question a filler asks first — a PDF with no AcroForm needs the
overlay path (pdf_form_fill.py --mode overlay), not a better selector. P6 is the
full record: type, coordinates in both frames, choices, max length and the flags
that change how a field must be filled (multiline, comb, read-only, required).

A document with zero fields is a valid answer, not an error: exit 0 with
`has_acroform: false`. Reserve non-zero for "could not answer".
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import compact, open_pdf, parse_pages, run, write_json  # noqa: E402
from pdfform import collect_fields, has_acroform  # noqa: E402


def inspect(src: Path, pages: str | None, password: str | None) -> dict:
    doc = open_pdf(src, password)
    with doc:
        wanted = parse_pages(pages, doc.page_count)
        fields = collect_fields(doc, wanted)
        by_type = Counter(f["type"] for f in fields)
        return {
            "source": str(src),
            "page_count": doc.page_count,
            # Widgets can exist on a page while the document carries no AcroForm
            # dictionary; both halves are reported so a filler can tell a real form
            # from stray annotations.
            "has_acroform": has_acroform(doc),
            "field_count": len(fields),
            "by_type": dict(sorted(by_type.items())),
            "pages_with_fields": sorted({f["page"] for f in fields}),
            "required_unfilled": sorted(f["name"] for f in fields
                                        if f["flags"].get("required") and not f["value"]),
            "fields": fields,
        }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=None, help="write the JSON here")
    ap.add_argument("--pages", default=None, help="1-based, e.g. 1-3,7 (default: all)")
    ap.add_argument("--password", default=None)
    ap.add_argument("--summary", action="store_true",
                    help="drop the per-field detail (P5: just is it fillable)")
    args = ap.parse_args()

    result = inspect(args.src, args.pages, args.password)
    if args.summary:
        result.pop("fields")
    if args.out:
        write_json(args.out, result)
    print(json.dumps(compact(result, "fields", args.out), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(run(main))
