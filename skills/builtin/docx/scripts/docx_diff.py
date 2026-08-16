#!/usr/bin/env python3
"""W18 — what changed between two documents, as a report and as a redline.

This was the last capability of the nineteen to be written, and the reason was never
the code: **a diff of two .docx files is trivial to produce and almost always
useless.** Word rewrites `w:rsidR` on every save, re-runs the spell checker, renumbers
bookmarks and re-splits runs. An XML diff of two files that say the same thing runs to
hundreds of lines, so the first question is not "how do I compare them" but "what
counts as a difference".

The answer this implements, decided before any of it was written:

**A difference is one paragraph's visible text changing.** Plus a short, explicit
whitelist of structural changes that a reader would also call differences:

    a paragraph added, removed or moved
    a table cell's text
    a paragraph's `w:pStyle`
    header and footer text
    an image added, removed or replaced

**And these are NOT differences — but they are COUNTED and reported**, because
"I looked at this and decided it did not matter" is a different statement from
silence, and only one of them can be checked:

    `w:rsid*`   `w:proofErr`   `w:bookmarkStart/End`   `w:lang`
    empty runs merged   ·   attribute order   ·   the order of entries in the zip

Two outputs come out of ONE comparison, so they can never disagree:

  1. a JSON summary — what changed, where, and what was ignored
  2. **a redline .docx**: the differences written into A as tracked changes, which is
     the form a person can actually act on. Open it in Word, accept the ones you
     want. It is built with `office/revision.py`, the same machinery W6 uses.

The claim that makes the redline worth trusting is closed-loop and this script checks
it on its own output before writing anything:

    accept every change in the redline  ->  the document reads exactly like B
    reject every change in the redline  ->  the document reads exactly like A

`--strict` turns a failure of that check into a refusal. Anything this script found
but could not express as a tracked change is listed in `not_redlined` and clears the
`roundtrip_exact` flag — a redline that silently covers four of five differences is
worse than no redline, because the fifth one now looks reviewed.

    python3 docx_diff.py --a old.docx --b new.docx --report diff.json
    python3 docx_diff.py --a old.docx --b new.docx --redline marked.docx --strict
"""
from __future__ import annotations

import argparse
import copy
import difflib
import hashlib
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, clip, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked, text_parts)
from office import document as doc  # noqa: E402
from office import revision as rev  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import insert_ordered, local, q  # noqa: E402

DEFAULT_DATE = "2026-01-01T00:00:00Z"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

MEDIA_PREFIX = "word/media/"


# ── which parts hold text ─────────────────────────────────────────────────────
# `text_parts` is imported from docxcommon rather than written again here: this
# capability's round trip is what proved that forgetting the headers is a defect with
# no symptom, so there is exactly one answer to "which parts hold text".
def style_of(paragraph) -> str | None:
    ppr = paragraph.find(q("pPr"))
    if ppr is None:
        return None
    node = ppr.find(q("pStyle"))
    return node.get(q("val")) if node is not None else None


def signature(pkg: Package) -> list[tuple]:
    """Everything this script considers to BE the document.

    Two documents with the same signature are the same document as far as W18 is
    concerned, and that is exactly the claim the accept/reject round trip checks.
    """
    out = []
    for name in text_parts(pkg):
        root = pkg.tree(name)
        for paragraph in doc.iter_paragraphs(doc.body(root)):
            out.append((name, style_of(paragraph), doc.paragraph_text(paragraph)))
    return out


# ── the things that are not differences ───────────────────────────────────────
def noise_of(pkg: Package, path: Path) -> dict:
    """Count every category this script deliberately ignores.

    Reported for both documents rather than as a delta: "A had 12 and B has 15" says
    what happened, where "3 more" leaves the reader to guess whether that is a save
    artefact or somebody's edit.
    """
    counts = {"rsid": 0, "proofErr": 0, "bookmark": 0, "lang": 0, "empty_runs": 0}
    for name in text_parts(pkg):
        for el in pkg.tree(name).iter():
            tag = local(el.tag)
            counts["rsid"] += sum(1 for a in el.attrib if local(a).startswith("rsid"))
            if tag in ("proofErr",):
                counts["proofErr"] += 1
            elif tag in ("bookmarkStart", "bookmarkEnd"):
                counts["bookmark"] += 1
            elif tag == "lang":
                counts["lang"] += 1
            elif tag == "r" and not len(el) and not (el.text or "").strip():
                counts["empty_runs"] += 1
            elif tag == "r" and not any(
                    local(c.tag) in ("t", "delText", "drawing", "tab", "br", "pict",
                                     "object", "fldChar", "instrText")
                    for c in el):
                counts["empty_runs"] += 1
    with zipfile.ZipFile(path) as z:
        counts["zip_entries"] = z.namelist()
    return counts


def attribute_order_differences(a: Package, b: Package) -> int | None:
    """Elements whose attributes carry the same values in a different order.

    None when the two trees diverge structurally before the walk finishes — in that
    case the number would be an artefact of where the walk gave up, and a number
    nobody can interpret is worse than saying it was not measured.
    """
    total = 0
    for name in text_parts(a):
        if name not in b.names():
            return None
        left = list(a.tree(name).iter())
        right = list(b.tree(name).iter())
        if len(left) != len(right):
            return None
        for x, y in zip(left, right):
            if x.tag != y.tag:
                return None
            if dict(x.attrib) == dict(y.attrib) and list(x.attrib) != list(y.attrib):
                total += 1
    return total


def media_of(pkg: Package) -> dict[str, str]:
    return {n: hashlib.sha256(pkg.parts[n]).hexdigest()[:16]
            for n in pkg.names() if n.startswith(MEDIA_PREFIX)}


def image_differences(a: Package, b: Package) -> list[dict]:
    left, right = media_of(a), media_of(b)
    out = []
    for name in sorted(set(left) | set(right)):
        if name not in right:
            out.append({"kind": "image-removed", "part": name})
        elif name not in left:
            out.append({"kind": "image-added", "part": name})
        elif left[name] != right[name]:
            out.append({"kind": "image-replaced", "part": name})
    return out


# ── comparing ─────────────────────────────────────────────────────────────────
def blocks_of(container) -> list:
    return [el for el in container if local(el.tag) in ("p", "tbl")]


def block_key(el, table_index: int) -> tuple:
    """What makes two blocks "the same block" for the purposes of alignment.

    A paragraph is keyed by its TEXT and not by its style, so that changing only the
    style aligns the paragraph with itself and shows up as a style change rather than
    as a delete plus an insert. Tables are keyed positionally: this script compares
    their cells, and a table that has moved is a structural change it reports rather
    than redlines.
    """
    if local(el.tag) == "p":
        return ("p", doc.paragraph_text(el))
    return ("tbl", table_index)


def keyed(container) -> list[tuple]:
    keys, seen_tables = [], 0
    for el in blocks_of(container):
        if local(el.tag) == "tbl":
            keys.append(block_key(el, seen_tables))
            seen_tables += 1
        else:
            keys.append(block_key(el, 0))
    return keys


class Diff:
    """One comparison: the findings, the redline, and what it could not mark."""

    def __init__(self, author: str, date: str, start_id: int):
        self.author = author
        self.date = date
        self._next = start_id
        self.findings: list[dict] = []
        self.not_redlined: list[str] = []
        # Every revision id this comparison created. The round-trip check resolves
        # ONLY these: A may already carry tracked changes of its own (report.docx
        # does), and rejecting those as well would undo edits nobody asked about —
        # correct behaviour for `--reject-all`, and the wrong question here. The
        # claim being checked is "the changes THIS redline introduced", not "every
        # revision in the file".
        self.ids: set[str] = set()

    def stamp(self, el):
        self._next += 1
        el.set(q("id"), str(self._next))
        el.set(q("author"), self.author)
        el.set(q("date"), self.date)
        self.ids.add(str(self._next))
        return el

    def found(self, **kw):
        self.findings.append(kw)

    # -- paragraph level --------------------------------------------------------
    def redline_text(self, paragraph, new_text: str) -> bool:
        """Mark this paragraph's text as becoming `new_text`. True if fully marked."""
        old = doc.paragraph_text(paragraph)
        if old == new_text:
            return True
        ops = [op for op in difflib.SequenceMatcher(None, old, new_text,
                                                    autojunk=False).get_opcodes()
               if op[0] != "equal"]
        ok = True
        # Back to front: wrapping a range in <w:del> takes it out of the paragraph's
        # visible character stream, so every offset AFTER it moves and every offset
        # before it does not.
        for _, a1, a2, b1, b2 in reversed(ops):
            if rev.mark_replacement(paragraph, a1, a2, new_text[b1:b2],
                                    self.stamp) == "unmarkable":
                ok = False
        return ok

    def mark_style(self, paragraph, new_ppr) -> None:
        """Record a `w:pPr` change, keeping the OLD properties inside `w:pPrChange`.

        Rejecting the change puts them back, which is what makes a style change part
        of the round trip rather than a note in a report.
        """
        old = paragraph.find(q("pPr"))
        holder = doc.element("pPr")
        if old is not None:
            for child in list(old):
                holder.append(copy.deepcopy(child))
            paragraph.remove(old)
        fresh = copy.deepcopy(new_ppr) if new_ppr is not None else doc.element("pPr")
        change = self.stamp(doc.element("pPrChange"))
        change.append(holder)
        insert_ordered(fresh, change)
        insert_ordered(paragraph, fresh)

    def delete_paragraph(self, paragraph) -> None:
        """Mark every part of the paragraph, and its BREAK, as deleted.

        Both halves are needed. Marking only the content leaves an empty paragraph
        behind when the change is accepted; marking only the break merges two
        paragraphs whose text is still there.
        """
        content = [c for c in paragraph if local(c.tag) not in ("pPr",)]
        if content:
            dele = self.stamp(doc.element("del"))
            content[0].addprevious(dele)
            for child in content:
                paragraph.remove(child)
                for node in child.iter(q("t")):
                    node.tag = q("delText")
                dele.append(child)
        rev.mark_paragraph_mark(paragraph, "del", self.stamp)

    def inserted_paragraph(self, source):
        """A copy of B's paragraph, marked as inserted — content and break both."""
        new = copy.deepcopy(source)
        content = [c for c in new if local(c.tag) not in ("pPr",)]
        if content:
            ins = self.stamp(doc.element("ins"))
            content[0].addprevious(ins)
            for child in content:
                new.remove(child)
                ins.append(child)
        rev.mark_paragraph_mark(new, "ins", self.stamp)
        return new

    # -- containers -------------------------------------------------------------
    def compare_paragraphs(self, ap, bp, where: str) -> None:
        a_text, b_text = doc.paragraph_text(ap), doc.paragraph_text(bp)
        a_style, b_style = style_of(ap), style_of(bp)
        if a_text != b_text:
            self.found(kind="text", where=where, before=clip(a_text),
                       after=clip(b_text))
            if not self.redline_text(ap, b_text):
                self.not_redlined.append(
                    f"{where}: the change falls across a tab or a line break, which "
                    f"cannot be wrapped in one revision without moving the break")
        if a_style != b_style:
            self.found(kind="style", where=where, before=a_style, after=b_style)
            self.mark_style(ap, bp.find(q("pPr")))

    def compare_tables(self, a_tbl, b_tbl, where: str) -> None:
        a_rows, b_rows = a_tbl.findall(q("tr")), b_tbl.findall(q("tr"))
        if len(a_rows) != len(b_rows):
            self.found(kind="table-shape", where=where,
                       before=f"{len(a_rows)} rows", after=f"{len(b_rows)} rows")
            self.not_redlined.append(
                f"{where}: rows were added or removed. A tracked row change is "
                f"`w:trPr/w:ins`, which this capability reports rather than writes — "
                f"the whitelist it was built to is cell TEXT")
            return
        for ri, (ar, br) in enumerate(zip(a_rows, b_rows)):
            a_cells, b_cells = ar.findall(q("tc")), br.findall(q("tc"))
            if len(a_cells) != len(b_cells):
                self.found(kind="table-shape", where=f"{where} row {ri + 1}",
                           before=f"{len(a_cells)} cells", after=f"{len(b_cells)} cells")
                self.not_redlined.append(f"{where} row {ri + 1}: the cell count changed")
                continue
            for ci, (ac, bc) in enumerate(zip(a_cells, b_cells)):
                a_ps, b_ps = ac.findall(q("p")), bc.findall(q("p"))
                if len(a_ps) != len(b_ps):
                    self.found(kind="table-shape",
                               where=f"{where} r{ri + 1}c{ci + 1}",
                               before=f"{len(a_ps)} paragraphs",
                               after=f"{len(b_ps)} paragraphs")
                    self.not_redlined.append(
                        f"{where} r{ri + 1}c{ci + 1}: the paragraph count changed")
                    continue
                for pi, (ap, bp) in enumerate(zip(a_ps, b_ps)):
                    self.compare_paragraphs(
                        ap, bp, f"{where} r{ri + 1}c{ci + 1}"
                        + (f" ¶{pi + 1}" if len(a_ps) > 1 else ""))

    def compare_container(self, a_container, b_container, part: str) -> None:
        a_blocks, b_blocks = blocks_of(a_container), blocks_of(b_container)
        matcher = difflib.SequenceMatcher(None, keyed(a_container),
                                          keyed(b_container), autojunk=False)
        opcodes = matcher.get_opcodes()

        # A paragraph that leaves one place and appears in another is a MOVE, and
        # calling it a delete plus an insert makes a reader check two things that are
        # really one. Detected by text, before anything is marked.
        removed = {doc.paragraph_text(a_blocks[i])
                   for tag, i1, i2, _, _ in opcodes if tag in ("delete", "replace")
                   for i in range(i1, i2) if local(a_blocks[i].tag) == "p"}
        added = {doc.paragraph_text(b_blocks[j])
                 for tag, _, _, j1, j2 in opcodes if tag in ("insert", "replace")
                 for j in range(j1, j2) if local(b_blocks[j].tag) == "p"}
        moved = removed & added

        anchor = None
        for tag, i1, i2, j1, j2 in opcodes:
            if tag == "equal":
                for a_el, b_el in zip(a_blocks[i1:i2], b_blocks[j1:j2]):
                    if local(a_el.tag) == "p":
                        self.compare_paragraphs(a_el, b_el, f"{part} ¶{_index(a_el)}")
                    else:
                        self.compare_tables(a_el, b_el, f"{part} table")
                anchor = a_blocks[i2 - 1] if i2 > i1 else anchor
                continue

            pairs = min(i2 - i1, j2 - j1) if tag == "replace" else 0
            for k in range(pairs):
                a_el, b_el = a_blocks[i1 + k], b_blocks[j1 + k]
                if local(a_el.tag) == "p" and local(b_el.tag) == "p":
                    self.compare_paragraphs(a_el, b_el, f"{part} ¶{_index(a_el)}")
                elif local(a_el.tag) == "tbl" and local(b_el.tag) == "tbl":
                    self.compare_tables(a_el, b_el, f"{part} table")
                else:
                    self.found(kind="block-kind", where=f"{part} block {i1 + k + 1}",
                               before=local(a_el.tag), after=local(b_el.tag))
                    self.not_redlined.append(
                        f"{part} block {i1 + k + 1}: a paragraph became a table or "
                        f"the other way round")
                anchor = a_el

            for a_el in a_blocks[i1 + pairs:i2]:
                if local(a_el.tag) == "p":
                    text = doc.paragraph_text(a_el)
                    self.found(kind="paragraph-moved" if text in moved
                               else "paragraph-removed",
                               where=f"{part} ¶{_index(a_el)}", before=clip(text))
                    self.delete_paragraph(a_el)
                else:
                    self.found(kind="table-removed", where=part)
                    self.not_redlined.append(f"{part}: a whole table was removed")
                anchor = a_el

            for b_el in b_blocks[j1 + pairs:j2]:
                if local(b_el.tag) != "p":
                    self.found(kind="table-added", where=part)
                    self.not_redlined.append(f"{part}: a whole table was added")
                    continue
                text = doc.paragraph_text(b_el)
                self.found(kind="paragraph-moved" if text in moved
                           else "paragraph-added", where=part, after=clip(text))
                if _references_a_relationship(b_el):
                    self.not_redlined.append(
                        f"{part}: the added paragraph points at a relationship "
                        f"(a hyperlink or a picture) that does not exist in the "
                        f"first document, so copying it in would produce a dangling "
                        f"r:id")
                    continue
                new = self.inserted_paragraph(b_el)
                if anchor is not None:
                    anchor.addnext(new)
                elif a_blocks:
                    a_blocks[0].addprevious(new)
                else:
                    doc.append_block(a_container, new)
                anchor = new


def _index(el) -> int:
    parent = el.getparent()
    return [c for c in parent if local(c.tag) == "p"].index(el) + 1


def _references_a_relationship(el) -> bool:
    return any(a.startswith(f"{{{REL_NS}}}") for node in el.iter() for a in node.attrib)


# ── the round trip ────────────────────────────────────────────────────────────
def resolved_signature(pkg: Package, mode: str, ids: set[str]) -> list[tuple]:
    """Signature of a COPY of the package with every revision accepted or rejected.

    A copy, because this runs BEFORE the redline is written and must not disturb the
    tree that is about to be saved — the check would otherwise consume the very
    revisions it is checking.
    """
    clone = Package(dict(pkg.parts), list(pkg.parts))
    for name in text_parts(clone):
        root = clone.tree(name)
        rev.apply(root, mode, ids=ids or None)
        clone.put_tree(name, root)
    return signature(clone)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", dest="left", required=True, type=Path,
                    help="the earlier document")
    ap.add_argument("--b", dest="right", required=True, type=Path,
                    help="the later document")
    ap.add_argument("--redline", type=Path,
                    help="write the differences into A as tracked changes")
    ap.add_argument("--author", default="ultrawork")
    ap.add_argument("--date", default=DEFAULT_DATE,
                    help="ISO 8601; fixed by default so output is reproducible")
    ap.add_argument("--strict", action="store_true",
                    help="refuse to write a redline that does not round-trip exactly")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        a: Package = open_document(args.left)
        b: Package = open_document(args.right)
        if args.redline:
            ensure_distinct(args.left, args.redline, "--redline")
            ensure_distinct(args.right, args.redline, "--redline")

        before_signature = signature(a)
        target_signature = signature(b)
        pre_existing = check_package(a)

        highest = max((int(v) for name in text_parts(a)
                       for el in a.tree(name).iter()
                       for v in [el.get(q("id"))]
                       if v is not None and v.lstrip("-").isdigit()), default=100)
        diff = Diff(args.author, args.date, highest)

        roots = {}
        for name in text_parts(a):
            if name not in b.names():
                diff.found(kind="part-removed", where=name)
                diff.not_redlined.append(f"{name}: the part is not in the second "
                                         f"document at all")
                continue
            a_root, b_root = a.tree(name), b.tree(name)
            roots[name] = a_root
            diff.compare_container(doc.body(a_root), doc.body(b_root), name)
        for name in text_parts(b):
            if name not in a.names():
                diff.found(kind="part-added", where=name)
                diff.not_redlined.append(f"{name}: the part is only in the second "
                                         f"document")

        for finding in image_differences(a, b):
            diff.found(**finding)
            diff.not_redlined.append(
                f"{finding['part']}: {finding['kind']}. Copying a media part and its "
                f"relationship across is a package edit, not a tracked change, so "
                f"this is reported and left for a person")

        for name, root in roots.items():
            a.put_tree(name, root)

        noise_a = noise_of(a, args.left)
        noise_b = noise_of(b, args.right)
        ignored = {k: {"a": noise_a[k], "b": noise_b[k]}
                   for k in ("rsid", "proofErr", "bookmark", "lang", "empty_runs")}
        ignored["attribute_order"] = attribute_order_differences(a, b)
        ignored["zip_entry_order"] = (
            "identical" if noise_a["zip_entries"] == noise_b["zip_entries"]
            else "different")

        report = {
            "a": args.left.name, "b": args.right.name,
            "differences": diff.findings,
            "counted": len(diff.findings),
            "not_redlined": diff.not_redlined,
            # Never omitted when empty. A report that mentions ignored categories only
            # when it found some cannot be told from one that never looked.
            "ignored_not_counted_as_differences": ignored,
        }

        if not args.redline:
            report["roundtrip"] = "not checked: no --redline was asked for"
            emit(report, args.report, "differences", "not_redlined")
            return

        # Named so the round trip can be reproduced from outside this script:
        # `docx_revise.py --reject-id ...` with these puts the document back, and a
        # claim somebody else can re-run is worth more than one only its author can.
        report["revision_ids"] = sorted(diff.ids, key=int)
        accepted = resolved_signature(a, "accept", diff.ids)
        rejected = resolved_signature(a, "reject", diff.ids)
        checks = {
            "accept_all_matches_b": accepted == target_signature,
            "reject_all_matches_a": rejected == before_signature,
            "everything_found_was_marked": not diff.not_redlined,
        }
        checks["exact"] = all(checks.values())
        report["roundtrip"] = checks
        if not checks["accept_all_matches_b"]:
            report["roundtrip"]["accept_first_divergence"] = _first_divergence(
                accepted, target_signature)
        if not checks["reject_all_matches_a"]:
            report["roundtrip"]["reject_first_divergence"] = _first_divergence(
                rejected, before_signature)

        if args.strict and not checks["exact"]:
            fail("--strict, and the redline does not round-trip exactly "
                 f"(accept==B: {checks['accept_all_matches_b']}, "
                 f"reject==A: {checks['reject_all_matches_a']}, "
                 f"everything marked: {checks['everything_found_was_marked']}). "
                 "Nothing was written")

        still = save_checked(a, args.redline, pre_existing)
        report["redline"] = str(args.redline)
        report["pre_existing_package_findings"] = still
        emit(report, args.report, "differences", "not_redlined")

    return run(entry)


def _first_divergence(got: list[tuple], want: list[tuple]) -> dict:
    for i, (x, y) in enumerate(zip(got, want)):
        if x != y:
            return {"at": i, "got": clip(str(x)), "want": clip(str(y))}
    return {"at": min(len(got), len(want)),
            "got": f"{len(got)} paragraphs", "want": f"{len(want)} paragraphs"}


if __name__ == "__main__":
    raise SystemExit(main())
