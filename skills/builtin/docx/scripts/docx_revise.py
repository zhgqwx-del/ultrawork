#!/usr/bin/env python3
"""W6 / W7 — edit WITH change tracking, and accept or reject what is tracked.

Two halves of one idea: a revision is the record of what a document used to say.

**W6 (`--replace` / `--delete` / `--insert-paragraph`)** makes the edit as a tracked
change instead of silently: the old text stays, wrapped in `<w:del>`, and the new
text arrives wrapped in `<w:ins>`, both stamped with an author and a date. Word shows
it as a revision a reviewer can act on. This shares the cross-run machinery with
`docx_edit.py` — a phrase Word split across runs has to be split back out into whole
runs before it can be wrapped at all, which is `office/document.py`'s `isolate_runs`.

**W7 (`--accept-all` / `--reject-all` / `--accept-author` / `--reject-id`)** resolves
them, in pure Python — no LibreOffice, no Word. That is the harder half, because
there are five shapes and knowing only the first two destroys documents:
run-level insert/delete · a move (delete + insert that know about each other, plus
range markers) · **a revision on the paragraph MARK, where accepting means MERGING
two paragraphs** · formatting revisions, whose old properties are stored inside and
have to be put back on reject · and nesting, `<w:ins><w:del>` being ordinary review
traffic.

So every run of this ends by re-scanning and reporting `remaining`. If a form
exists that this code does not handle, it shows up there instead of being silently
skipped. `--strict` turns leftovers into a refusal.

    python3 docx_revise.py --in a.docx --out b.docx --author 张三 \\
            --replace "第三季度=第四季度"
    python3 docx_revise.py --in a.docx --out b.docx --author 张三 --delete "待核对"
    python3 docx_revise.py --in a.docx --list
    python3 docx_revise.py --in a.docx --out final.docx --accept-all --strict
    python3 docx_revise.py --in a.docx --out clean.docx --reject-author 张审阅
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office import revision as rev  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import insert_ordered, local, q  # noqa: E402

DEFAULT_DATE = "2026-01-01T00:00:00Z"


def next_revision_id(root) -> int:
    """One past the highest id in the part.

    Reusing an id is not cosmetic: Word pairs a move's two halves by id, and two
    unrelated revisions sharing one is how a document ends up with a change that
    cannot be accepted on its own.
    """
    used = [int(v) for el in root.iter() for v in [el.get(q("id"))]
            if v is not None and v.lstrip("-").isdigit()]
    return max(used, default=100) + 1


def stamp(el, rid: int, author: str, date: str):
    el.set(q("id"), str(rid))
    el.set(q("author"), author)
    el.set(q("date"), date)
    return el


def track_replace(paragraph, old: str, new: str, author: str, date: str,
                  next_id) -> dict:
    """Mark `old` deleted and `new` inserted, back to front."""
    usable, refused = doc.find_occurrences(paragraph, old)
    done, skipped = 0, 0
    for occ in reversed(usable):
        runs = doc.isolate_runs(paragraph, occ.start, occ.end)
        if not runs:
            skipped += 1
            continue
        parent = runs[0].getparent()
        if any(r.getparent() is not parent for r in runs):
            # Half a match inside a hyperlink and half outside cannot be wrapped in
            # one element. Reported rather than wrapped in two, which would produce
            # a revision a reviewer cannot accept as a unit.
            skipped += 1
            continue
        dele = stamp(doc.element("del"), next_id(), author, date)
        runs[0].addprevious(dele)
        for r in runs:
            parent.remove(r)
            for node in r.iter(q("t")):
                node.tag = q("delText")     # deleted text is a DIFFERENT element
            dele.append(r)
        if new:
            ins = stamp(doc.element("ins"), next_id(), author, date)
            ins.append(doc.run_like(runs[0], new))
            dele.addnext(ins)
        done += 1
    return {"replaced": done, "skipped": skipped, "refused": len(refused)}


def track_insert_paragraph(body, text: str, author: str, date: str, next_id,
                           style: str | None) -> None:
    """Append a paragraph that is itself marked as inserted.

    Two marks, not one: the runs go inside `<w:ins>`, and the paragraph MARK gets its
    own `<w:pPr><w:rPr><w:ins/></w:rPr></w:pPr>`. Without the second one, rejecting
    the change removes the text and leaves an empty paragraph behind.
    """
    para = doc.element("p")
    ppr = doc.element("pPr")
    if style:
        insert_ordered(ppr, doc.element("pStyle", val=style))
    mark_rpr = doc.element("rPr")
    insert_ordered(mark_rpr, stamp(doc.element("ins"), next_id(), author, date))
    insert_ordered(ppr, mark_rpr)
    insert_ordered(para, ppr)
    ins = stamp(doc.element("ins"), next_id(), author, date)
    ins.append(doc.make_run(text))
    para.append(ins)
    doc.append_block(body, para)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--author", default="ultrawork")
    ap.add_argument("--date", default=DEFAULT_DATE,
                    help="ISO 8601; fixed by default so output is reproducible")
    ap.add_argument("--replace", action="append", default=[], metavar="OLD=NEW")
    ap.add_argument("--delete", action="append", default=[], metavar="TEXT")
    ap.add_argument("--insert-paragraph", action="append", default=[], metavar="TEXT")
    ap.add_argument("--style", help="paragraph style for --insert-paragraph")
    ap.add_argument("--list", action="store_true",
                    help="report the revisions in the document and write nothing")
    ap.add_argument("--accept-all", action="store_true")
    ap.add_argument("--reject-all", action="store_true")
    ap.add_argument("--accept-author", action="append", default=[], metavar="NAME")
    ap.add_argument("--reject-author", action="append", default=[], metavar="NAME")
    ap.add_argument("--accept-id", action="append", default=[], metavar="ID")
    ap.add_argument("--reject-id", action="append", default=[], metavar="ID")
    ap.add_argument("--strict", action="store_true",
                    help="refuse to write if any revision markup is left over")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        pkg: Package = open_document(args.src)
        root = pkg.tree(DOCUMENT)

        if args.list:
            emit({"in": args.src.name, "revisions": rev.inventory(root),
                  "remaining": rev.remaining(root)}, args.report, "revisions")
            return

        making = args.replace or args.delete or args.insert_paragraph
        resolving = (args.accept_all or args.reject_all or args.accept_author
                     or args.reject_author or args.accept_id or args.reject_id)
        if not making and not resolving:
            fail("nothing to do: pass --replace/--delete/--insert-paragraph to make "
                 "tracked changes, or --accept-*/--reject-* to resolve them, or "
                 "--list to see what is there")
        if making and resolving:
            fail("making tracked changes and resolving them in one call would leave "
                 "the result depending on which ran first; do them in two calls")
        if not args.out:
            fail("pass --out FILE")
        ensure_distinct(args.src, args.out)

        pre_existing = check_package(pkg)
        before = dict(pkg.parts)
        report: dict = {"in": args.src.name, "out": str(args.out)}

        if making:
            counter = [next_revision_id(root)]

            def next_id() -> int:
                counter[0] += 1
                return counter[0]

            body = doc.body(root)
            marked = []
            for spec in args.replace:
                if "=" not in spec:
                    fail(f"--replace expects OLD=NEW, got {spec!r}")
                old, new = spec.split("=", 1)
                totals = {"old": old, "new": new, "replaced": 0, "skipped": 0,
                          "refused": 0}
                for paragraph in doc.iter_paragraphs(body):
                    r = track_replace(paragraph, old, new, args.author, args.date,
                                      next_id)
                    for k in ("replaced", "skipped", "refused"):
                        totals[k] += r[k]
                marked.append(totals)
            for text in args.delete:
                totals = {"old": text, "new": "", "replaced": 0, "skipped": 0,
                          "refused": 0}
                for paragraph in doc.iter_paragraphs(body):
                    r = track_replace(paragraph, text, "", args.author, args.date,
                                      next_id)
                    for k in ("replaced", "skipped", "refused"):
                        totals[k] += r[k]
                marked.append(totals)
            for text in args.insert_paragraph:
                track_insert_paragraph(body, text, args.author, args.date, next_id,
                                       args.style)
                marked.append({"old": "", "new": text, "replaced": 1, "skipped": 0,
                               "refused": 0})
            report["tracked"] = marked
            report["author"] = args.author
            if not any(m["replaced"] for m in marked):
                report["note"] = ("nothing matched, so no revision was recorded and "
                                  "the document was copied unchanged")
        else:
            if (args.accept_all or args.accept_author or args.accept_id) and \
                    (args.reject_all or args.reject_author or args.reject_id):
                fail("accepting and rejecting in one call is ambiguous; do them in "
                     "two calls")
            accept = bool(args.accept_all or args.accept_author or args.accept_id)
            authors = set(args.accept_author or args.reject_author) or None
            ids = set(args.accept_id or args.reject_id) or None
            report["resolved"] = rev.apply(root, "accept" if accept else "reject",
                                           authors=authors, ids=ids)

        pkg.put_tree(DOCUMENT, root)
        leftovers = rev.remaining(pkg.tree(DOCUMENT))
        report["remaining"] = leftovers
        if args.strict and leftovers:
            fail(f"--strict, and the document still carries revision markup: "
                 f"{', '.join(leftovers)}. Nothing was written")

        still = save_checked(pkg, args.out, pre_existing)
        report["parts_changed"] = sorted(n for n in pkg.parts
                                         if before.get(n) != pkg.parts[n])
        report["parts_byte_identical"] = sum(1 for n in before
                                             if pkg.parts.get(n) == before[n])
        report["pre_existing_package_findings"] = still
        emit(report, args.report, "tracked", "parts_changed")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
