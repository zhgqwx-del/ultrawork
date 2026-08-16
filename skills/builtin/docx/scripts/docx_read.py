#!/usr/bin/env python3
"""W1 — read a .docx: structure, text, tables, styles, revisions, comments.

Three things this reports that a naive reader does not, each because getting it
wrong produces an answer that is confidently false:

  * **Text is joined at the paragraph, not the run.** Word splits a phrase across
    runs for reasons that have nothing to do with meaning. A reader that hands back
    runs hands back `"2026 年第" | "三季度"` and every consumer downstream has to
    solve the same problem again.
  * **Deleted text is not document text.** Text inside `<w:del>` was removed with
    change tracking on. Folding it into the paragraph makes a document say the
    opposite of what it says — so it is excluded from `text` and reported under
    `revisions`, where someone can ask for it deliberately.
  * **Inserted text IS document text.** The mirror of the above, and the one
    python-docx itself gets wrong: `paragraph.text` walks only direct `<w:r>`
    children, so a tracked insertion is silently missing from what it returns.

Usage:

    python3 scripts/docx_read.py --in report.docx
    python3 scripts/docx_read.py --in report.docx --outline --out doc.json
    python3 scripts/docx_read.py --in report.docx --tables --out tables.json
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import DOCUMENT, clip, emit, open_document, run  # noqa: E402
from office import document as doc  # noqa: E402
from office.package import Package  # noqa: E402
from office.xmlorder import local, q  # noqa: E402

HEADER_FOOTER = ("word/header", "word/footer")


def style_of(paragraph) -> str | None:
    ppr = paragraph.find(q("pPr"))
    if ppr is None:
        return None
    pstyle = ppr.find(q("pStyle"))
    return pstyle.get(q("val")) if pstyle is not None else None


def list_level(paragraph) -> dict | None:
    ppr = paragraph.find(q("pPr"))
    numpr = ppr.find(q("numPr")) if ppr is not None else None
    if numpr is None:
        return None
    ilvl = numpr.find(q("ilvl"))
    numid = numpr.find(q("numId"))
    return {"level": int(ilvl.get(q("val"))) if ilvl is not None else 0,
            "num_id": int(numid.get(q("val"))) if numid is not None else None}


def deleted_text(paragraph) -> str:
    return "".join(t.text or "" for t in paragraph.iter(q("delText")))


def inserted_text(paragraph) -> str:
    out = []
    for ins in paragraph.iter(q("ins")):
        out += [t.text or "" for t in ins.iter(q("t"))]
    return "".join(out)


def in_table(paragraph) -> bool:
    parent = paragraph.getparent()
    while parent is not None:
        if local(parent.tag) == "tc":
            return True
        parent = parent.getparent()
    return False


def paragraph_entry(index: int, paragraph, *, sample: bool) -> dict:
    text = doc.paragraph_text(paragraph)
    entry: dict = {"index": index, "style": style_of(paragraph),
                   "runs": len(paragraph.findall(q("r"))),
                   "chars": len(text),
                   "text": clip(text) if sample else text}
    lvl = list_level(paragraph)
    if lvl:
        entry["list"] = lvl
    if in_table(paragraph):
        entry["in_table"] = True
    dele, ins = deleted_text(paragraph), inserted_text(paragraph)
    if dele:
        entry["deleted_text"] = dele
    if ins:
        entry["inserted_text"] = ins
    return entry


def table_entry(index: int, table) -> dict:
    rows = []
    for tr in table.findall(q("tr")):
        rows.append([" ".join(doc.paragraph_text(p) for p in tc.findall(q("p"))).strip()
                     for tc in tr.findall(q("tc"))])
    return {"index": index, "rows": len(rows),
            "columns": max((len(r) for r in rows), default=0), "cells": rows}


def revisions_of(root) -> dict:
    def collect(tag: str) -> list[dict]:
        return [{"id": el.get(q("id")), "author": el.get(q("author")),
                 "date": el.get(q("date")),
                 "text": "".join(t.text or "" for t in el.iter(q("t"), q("delText")))}
                for el in root.iter(q(tag))]
    return {"insertions": collect("ins"), "deletions": collect("del")}


def comments_of(pkg: Package) -> list[dict]:
    if not pkg.has("word/comments.xml"):
        return []
    root = pkg.tree("word/comments.xml")
    return [{"id": c.get(q("id")), "author": c.get(q("author")),
             "date": c.get(q("date")),
             "text": " ".join(doc.paragraph_text(p) for p in c.iter(q("p"))).strip()}
            for c in root.iter(q("comment"))]


def header_footer_entries(pkg: Package) -> list[dict]:
    """Headers and footers, with their text and their field count.

    A page number is a FIELD, not the digit you see: `{ PAGE }` is five runs, one of
    which holds a stale cached "1". Reporting the cached digit as the footer's text
    is how a reader ends up believing every page is page 1 — so the field count is
    reported next to it and the text is what is actually stored.
    """
    out = []
    for name in sorted(n for n in pkg.names() if n.startswith(HEADER_FOOTER)):
        root = pkg.tree(name)
        out.append({
            "part": name,
            "kind": "header" if "header" in name else "footer",
            "paragraphs": len(list(root.iter(q("p")))),
            "fields": len([f for f in root.iter(q("fldChar"))
                           if f.get(q("fldCharType")) == "begin"]),
            "text": " ".join(doc.paragraph_text(p) for p in root.iter(q("p"))).strip(),
        })
    return out


def sections_of(root) -> list[dict]:
    out = []
    for sect in root.iter(q("sectPr")):
        pg = sect.find(q("pgSz"))
        out.append({
            "page": {"width": pg.get(q("w")), "height": pg.get(q("h"))}
            if pg is not None else None,
            "headers": [h.get(q("type")) for h in sect.findall(q("headerReference"))],
            "footers": [f.get(q("type")) for f in sect.findall(q("footerReference"))],
        })
    return out


def build_report(pkg: Package, path: Path, *, outline: bool, tables: bool,
                 full_text: bool) -> dict:
    root = pkg.tree(DOCUMENT)
    body = doc.body(root)
    paragraphs = list(doc.iter_paragraphs(body))
    tbls = list(doc.iter_tables(body))
    revs = revisions_of(root)

    report: dict = {
        "file": path.name,
        "counts": {
            "paragraphs": len(paragraphs),
            "paragraphs_outside_tables": sum(1 for p in paragraphs if not in_table(p)),
            "tables": len(tbls),
            "runs": sum(len(p.findall(q("r"))) for p in paragraphs),
            "characters": sum(len(doc.paragraph_text(p)) for p in paragraphs),
            "images": len(root.findall(f".//{q('drawing')}")),
            "hyperlinks": len(root.findall(f".//{q('hyperlink')}")),
            "fields": len([f for f in root.iter(q("fldChar"))
                           if f.get(q("fldCharType")) == "begin"]),
            "insertions": len(revs["insertions"]),
            # every count above is scoped to the document BODY; headers and footers
            # are separate parts and are reported separately, because folding them
            # in makes "how long is this document" answer a different question
            "deletions": len(revs["deletions"]),
            "comments": len(comments_of(pkg)),
        },
        "sections": sections_of(root),
        "styles_used": sorted({s for s in (style_of(p) for p in paragraphs) if s}),
        "headers_and_footers": header_footer_entries(pkg),
        "has_numbering": pkg.has("word/numbering.xml"),
        "has_custom_xml": any(n.startswith("customXml/") for n in pkg.names()),
    }
    if revs["insertions"] or revs["deletions"]:
        report["revisions"] = revs
    if comments_of(pkg):
        report["comments"] = comments_of(pkg)
    if outline or full_text:
        report["paragraphs"] = [paragraph_entry(i, p, sample=not full_text)
                                for i, p in enumerate(paragraphs)]
    if tables:
        report["table_contents"] = [table_entry(i, t) for i, t in enumerate(tbls)]
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--outline", action="store_true",
                    help="list every paragraph with its style, list level and a sample")
    ap.add_argument("--tables", action="store_true", help="dump table cell text")
    ap.add_argument("--text", action="store_true",
                    help="full paragraph text instead of a clipped sample")
    ap.add_argument("--out", help="write the full report here (stdout stays a summary)")
    args = ap.parse_args()

    def entry():
        src = Path(args.src)
        pkg = open_document(src)
        report = build_report(pkg, src, outline=args.outline, tables=args.tables,
                              full_text=args.text)
        emit(report, Path(args.out) if args.out else None,
             "paragraphs", "table_contents", "comments")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
