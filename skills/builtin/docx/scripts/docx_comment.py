#!/usr/bin/env python3
"""W8 — read, add and remove comments.

A comment is **five things**, and a tool that writes three of them produces a file
Word offers to repair:

    word/comments.xml               the comment text itself
    an [Content_Types].xml Override that part's type
    a Relationship                  from word/document.xml to that part
    <w:commentRangeStart/End>       what the comment is ABOUT, in the body
    a run holding <w:commentReference>  the anchor Word draws the balloon from

Removing one is the same five in reverse, and dropping the last comment means
dropping the part — which is itself three things (bytes, Override, Relationship).
`office/package.py` does that symmetrically; doing it by hand is how a package ends
up with a relationship pointing at nothing.

The anchor is placed with the same machinery tracked changes use: the commented
phrase is split out into whole runs first (`isolate_runs`), because a range marker
cannot start in the middle of a run. That is why a phrase Word split across runs can
be commented on at all.

    python3 docx_comment.py --in a.docx --list
    python3 docx_comment.py --in a.docx --out b.docx \\
            --add-on "应收账款余额" --text "请与银行流水核对" --author 李复核
    python3 docx_comment.py --in a.docx --out b.docx --delete 1
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
from office.xmlorder import MAIN_NS, local, q  # noqa: E402

COMMENTS = "word/comments.xml"
COMMENTS_CT = ("application/vnd.openxmlformats-officedocument.wordprocessingml."
               "comments+xml")
COMMENTS_REL = ("http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
                "comments")
DEFAULT_DATE = "2026-01-01T00:00:00Z"


def comments_root(pkg: Package):
    from lxml import etree
    if pkg.has(COMMENTS):
        return pkg.tree(COMMENTS)
    return etree.Element(q("comments"), nsmap={"w": MAIN_NS})


def ensure_comments_part(pkg: Package, root) -> list[str]:
    """Write the part and the two things that make it reachable. Returns what it did."""
    created = []
    if not pkg.has(COMMENTS):
        created.append("part")
    pkg.put_tree(COMMENTS, root)
    if pkg.content_type(COMMENTS) != COMMENTS_CT:
        pkg.set_override(COMMENTS, COMMENTS_CT)
        created.append("content-type Override")
    rels_part = Package.rels_part_of(DOCUMENT)
    if not any(r["resolved"] == COMMENTS for r in pkg.relationships(rels_part)):
        pkg.add_relationship(rels_part, COMMENTS_REL, "comments.xml")
        created.append("relationship")
    return created


def listing(pkg: Package) -> list[dict]:
    if not pkg.has(COMMENTS):
        return []
    root = pkg.tree(COMMENTS)
    body = pkg.tree(DOCUMENT)
    anchored = {el.get(q("id")) for el in body.iter(q("commentRangeStart"))}
    out = []
    for c in root.iter(q("comment")):
        cid = c.get(q("id"))
        out.append({
            "id": cid, "author": c.get(q("author")), "date": c.get(q("date")),
            "initials": c.get(q("initials")),
            "text": " ".join(doc.paragraph_text(p) for p in c.iter(q("p"))).strip(),
            # A comment whose range markers are gone still shows in Word, anchored
            # to nothing. Saying so is the difference between a list and an audit.
            "anchored": cid in anchored,
        })
    return out


def add_comment(pkg: Package, phrase: str, text: str, author: str, date: str,
                initials: str | None) -> dict:
    root = pkg.tree(DOCUMENT)
    croot = comments_root(pkg)
    used = [int(c.get(q("id"))) for c in croot.iter(q("comment"))
            if (c.get(q("id")) or "").isdigit()]
    cid = max(used, default=-1) + 1

    target = None
    for paragraph in doc.iter_paragraphs(doc.body(root)):
        usable, _ = doc.find_occurrences(paragraph, phrase)
        if usable:
            target = (paragraph, usable[0])
            break
    if target is None:
        fail(f"--add-on {phrase!r} does not appear in the document body, so there is "
             f"nothing to anchor the comment to. A comment anchored to nothing is a "
             f"balloon Word shows next to the wrong paragraph")
    paragraph, occ = target
    runs = doc.isolate_runs(paragraph, occ.start, occ.end)
    if not runs:
        fail(f"{phrase!r} was found but could not be isolated into whole runs")
    start = doc.element("commentRangeStart", id=cid)
    end = doc.element("commentRangeEnd", id=cid)
    runs[0].addprevious(start)
    runs[-1].addnext(end)
    ref = doc.element("r")
    rpr = doc.element("rPr")
    rpr.append(doc.element("rStyle", val="CommentReference"))
    ref.append(rpr)
    ref.append(doc.element("commentReference", id=cid))
    end.addnext(ref)

    comment = doc.element("comment", id=cid, author=author, date=date)
    if initials:
        comment.set(q("initials"), initials)
    para = doc.element("p")
    para.append(doc.make_run(text))
    comment.append(para)
    croot.append(comment)

    pkg.put_tree(DOCUMENT, root)
    created = ensure_comments_part(pkg, croot)
    return {"id": cid, "author": author, "anchored_to": phrase,
            "cross_run": occ.cross_run, "runs_wrapped": len(runs),
            "package_pieces_created": created}


def delete_comments(pkg: Package, ids: set[str]) -> dict:
    if not pkg.has(COMMENTS):
        fail("this document has no word/comments.xml, so there is nothing to delete")
    croot = pkg.tree(COMMENTS)
    root = pkg.tree(DOCUMENT)
    removed, missing = [], sorted(ids)
    for c in list(croot.iter(q("comment"))):
        cid = c.get(q("id"))
        if cid in ids:
            croot.remove(c)
            removed.append(cid)
            missing = [m for m in missing if m != cid]
    for el in list(root.iter()):
        name = local(el.tag)
        if name in ("commentRangeStart", "commentRangeEnd") and el.get(q("id")) in ids:
            el.getparent().remove(el)
        elif name == "commentReference" and el.get(q("id")) in ids:
            # The reference lives inside a run that exists only to hold it; taking
            # the reference and leaving the run behind puts an empty run in the text.
            holder = el.getparent()
            el.getparent().remove(el)
            if holder is not None and local(holder.tag) == "r" and \
                    all(local(c.tag) == "rPr" for c in holder):
                holder.getparent().remove(holder)
    pkg.put_tree(DOCUMENT, root)
    dropped_part = False
    if not list(croot.iter(q("comment"))):
        # The last comment is gone: drop the part AND its Override AND the
        # relationship. Removing only the bytes leaves a package pointing at nothing.
        pkg.drop(COMMENTS)
        dropped_part = True
    else:
        pkg.put_tree(COMMENTS, croot)
    return {"removed": removed, "not_found": missing,
            "comments_part_dropped": dropped_part}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--add-on", metavar="PHRASE",
                    help="the text in the body the comment is about")
    ap.add_argument("--text", help="the comment itself")
    ap.add_argument("--author", default="ultrawork")
    ap.add_argument("--initials")
    ap.add_argument("--date", default=DEFAULT_DATE)
    ap.add_argument("--delete", action="append", default=[], metavar="ID")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        pkg = open_document(args.src)
        if args.list or not (args.add_on or args.delete):
            if not args.list:
                fail("nothing to do: pass --add-on PHRASE --text TEXT, --delete ID, "
                     "or --list")
            emit({"in": args.src.name, "comments": listing(pkg)}, args.report,
                 "comments")
            return
        if not args.out:
            fail("pass --out FILE")
        ensure_distinct(args.src, args.out)
        if args.add_on and not args.text:
            fail("--add-on needs --text: a comment with no text is a balloon that "
                 "says nothing")
        pre_existing = check_package(pkg)
        before = dict(pkg.parts)
        report: dict = {"in": args.src.name, "out": str(args.out)}
        if args.add_on:
            report["added"] = add_comment(pkg, args.add_on, args.text, args.author,
                                          args.date, args.initials)
        if args.delete:
            report["deleted"] = delete_comments(pkg, set(args.delete))
        still = save_checked(pkg, args.out, pre_existing)
        report["comments"] = listing(pkg)
        report["parts_changed"] = sorted(n for n in pkg.parts
                                         if before.get(n) != pkg.parts[n])
        report["parts_byte_identical"] = sum(1 for n in before
                                             if pkg.parts.get(n) == before[n])
        report["pre_existing_package_findings"] = still
        emit(report, args.report, "comments", "parts_changed")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
