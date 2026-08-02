#!/usr/bin/env python3
"""W2 / W3 — replace text in place, and append paragraphs.

**The whole point of this script is that a phrase is not a run.** Word splits a
paragraph into `<w:r>` runs on every formatting change, spell-check pass and
revision id — so the text a person reads as one phrase routinely lives in three
runs, and the implementation everyone writes first:

    for p in doc.paragraphs:
        for r in p.runs:
            r.text = r.text.replace(old, new)

finds only what does not span a run. Measured on this skill's own sample, which
holds `第三季度` twice — once in the title as a single run, once split as
`"2026 年第" | "三季度"`: the per-run search gets **1 of 2** and reports success.
Partial correctness is why it survives. Every replacement here runs over the
paragraph's character stream instead, and the report says how many matches crossed a
run boundary — a number that is the difference between the two implementations,
present in the artifact rather than in a claim.

The edit is **surgical**: only the parts it actually changes are rewritten. Every
other byte of the package — the custom XML, the comments, the image, the theme —
comes through untouched, which is checked by reopening the result before it is
written.

Usage:

    python3 scripts/docx_edit.py --in report.docx --out out.docx \\
            --replace "第三季度=第四季度" --replace "{{客户名称}}=示例公司"
    python3 scripts/docx_edit.py --in report.docx --out out.docx \\
            --append-paragraph "结论：维持增长预期。" --style Heading1
    python3 scripts/docx_edit.py --in report.docx --out out.docx \\
            --replace "内部资料=公开资料" --in-headers
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import q  # noqa: E402

HEADER_FOOTER_PREFIX = ("word/header", "word/footer")


def split_pair(spec: str) -> tuple[str, str]:
    """`OLD=NEW`, where OLD may itself contain `=` only if escaped as `\\=`.

    Refused rather than guessed when there is no separator: silently treating
    `--replace 第三季度` as "delete this" is the kind of helpfulness that edits a
    contract in a way nobody asked for.
    """
    marker = "\x00"
    protected = spec.replace("\\=", marker)
    if "=" not in protected:
        fail(f"--replace expects OLD=NEW, got {spec!r} (write \\= for a literal =)")
    old, new = protected.split("=", 1)
    old, new = old.replace(marker, "="), new.replace(marker, "=")
    if not old:
        fail("--replace was given an empty search string; that matches everywhere "
             "and nowhere")
    return old, new


def target_parts(pkg: Package, in_headers: bool) -> list[str]:
    parts = [DOCUMENT]
    if in_headers:
        parts += sorted(n for n in pkg.names()
                        if n.startswith(HEADER_FOOTER_PREFIX) and n.endswith(".xml"))
    return parts


def replace_everywhere(pkg: Package, pairs: list[tuple[str, str]],
                       in_headers: bool) -> list[dict]:
    """Apply every pair to every target part. Returns one report entry per pair."""
    reports = [{"old": o, "new": n, "replaced": 0, "cross_run": 0, "refused": 0,
                "parts": {}, "contexts": [], "refused_reason": [], "near_misses": []}
               for o, n in pairs]
    for part in target_parts(pkg, in_headers):
        root = pkg.tree(part)
        container = doc.body(root)
        touched = False
        for entry, (old, new) in zip(reports, pairs):
            hits = 0
            for paragraph in doc.iter_paragraphs(container):
                r = doc.replace_in_paragraph(paragraph, old, new)
                hits += r["replaced"]
                entry["replaced"] += r["replaced"]
                entry["cross_run"] += r["cross_run"]
                entry["refused"] += r["refused"]
                entry["contexts"] = sorted(set(entry["contexts"]) | set(r["contexts"]))
                entry["refused_reason"] = sorted(set(entry["refused_reason"])
                                                 | set(r["refused_reason"]))
                entry["near_misses"] += r["near_misses"]
            if hits:
                entry["parts"][part] = hits
                touched = True
        if touched:
            pkg.put_tree(part, root)
    return reports


def append_paragraphs(pkg: Package, texts: list[str], style: str | None,
                      num_id: int | None) -> list[dict]:
    """Add paragraphs at the end of the body — before `<w:sectPr>`, which is the trap.

    `body.append(p)` puts the paragraph after the section properties. Word repairs
    such a file by discarding what it cannot place, and what it cannot place is the
    section: page size, margins, and the header/footer bindings all go.
    """
    if num_id is not None and not pkg.has("word/numbering.xml"):
        fail("--list was asked for but this document has no word/numbering.xml, so "
             "there is no list definition to join; add one first or drop --list")
    root = pkg.tree(DOCUMENT)
    body = doc.body(root)
    added = []
    for text in texts:
        para = doc.make_paragraph(text, style=style, num_id=num_id)
        doc.append_block(body, para)
        added.append({"text": text, "style": style, "num_id": num_id,
                      "cjk": doc.has_cjk(text)})
    pkg.put_tree(DOCUMENT, root)
    return added


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--replace", action="append", default=[], metavar="OLD=NEW",
                    help="replace text anywhere in the body, across run boundaries")
    ap.add_argument("--in-headers", action="store_true",
                    help="also replace inside header and footer parts")
    ap.add_argument("--append-paragraph", action="append", default=[], metavar="TEXT",
                    help="add a paragraph at the end of the body")
    ap.add_argument("--style", help="paragraph style id for --append-paragraph")
    ap.add_argument("--list", dest="num_id", type=int, metavar="NUMID",
                    help="join an existing numbered list (w:numId) ")
    ap.add_argument("--report", help="write the full report here")
    args = ap.parse_args()

    def entry():
        src, out = Path(args.src), Path(args.out)
        ensure_distinct(src, out)
        if not args.replace and not args.append_paragraph:
            fail("nothing to do: pass --replace and/or --append-paragraph")
        pkg = open_document(src)
        # Damage the input already had is reported, not treated as fatal — the
        # documents most in need of an edit are the ones already a bit broken.
        pre_existing = check_package(pkg)
        before = dict(pkg.parts)

        pairs = [split_pair(s) for s in args.replace]
        replaced = replace_everywhere(pkg, pairs, args.in_headers) if pairs else []
        appended = (append_paragraphs(pkg, args.append_paragraph, args.style,
                                      args.num_id)
                    if args.append_paragraph else [])

        still = save_checked(pkg, out, pre_existing)
        changed = sorted(n for n in pkg.parts if before.get(n) != pkg.parts[n])
        report = {
            "in": src.name, "out": str(out),
            "replacements": replaced,
            "appended": appended,
            "parts_total": len(pkg.parts),
            "parts_changed": changed,
            "parts_byte_identical": sum(1 for n in before if pkg.parts.get(n) == before[n]),
            # Never only reported when non-empty: a report that mentions damage only
            # when there is some is indistinguishable from one nobody wrote.
            "pre_existing_package_findings": still,
        }
        if pairs and not any(r["replaced"] for r in replaced):
            report["note"] = ("no occurrence of any search string was found — the "
                              "document was copied unchanged")
        emit(report, Path(args.report) if args.report else None, "parts_changed")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
