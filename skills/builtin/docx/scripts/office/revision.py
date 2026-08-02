#!/usr/bin/env python3
"""Tracked changes: reading them, making them, accepting them, rejecting them.

A revision is not a formatting flourish — it is the record of what a document used
to say. Getting it wrong loses text that a person deliberately kept, which is why
this file is written around one rule: **never assume a shape you have not handled.**
Every operation re-scans afterwards and reports what is still marked, so a form this
code does not know about surfaces as `remaining` rather than as a silent success.

Five shapes exist, and a half implementation that knows only the first two will
quietly destroy documents:

  ``<w:ins>`` / ``<w:del>``      inserted / deleted runs
  ``<w:moveFrom>`` / ``<w:moveTo>``  a move, which is a delete and an insert that
                                     know about each other, plus range markers
  paragraph-mark revisions      ``<w:pPr><w:rPr><w:ins/>`` — the paragraph BREAK was
                                inserted or deleted. Accepting or rejecting one MERGES
                                two paragraphs, which no amount of unwrapping does
  ``<w:*Change>``               formatting revisions: the old properties are stored
                                inside, so rejecting means putting them back
  nesting                       ``<w:ins><w:del>`` = inserted, then deleted. Ordinary
                                review traffic; the repo's own L2 check used to reject
                                it until the ECMA-376 schema settled the argument

⚠️ The nesting case is why the loop below repeats instead of iterating a snapshot:
unwrapping an insertion can expose a deletion that was inside it, and that deletion
still has to be handled.
"""
from __future__ import annotations

from .xmlorder import MAIN_NS, local, q

RUN_LEVEL = ("ins", "del", "moveFrom", "moveTo")
# Bookmark-like markers that delimit a move. They carry no text, and leaving them
# behind after the move itself is resolved produces a document Word shows as still
# having revisions in it.
RANGE_MARKERS = ("moveFromRangeStart", "moveFromRangeEnd",
                 "moveToRangeStart", "moveToRangeEnd")
# Formatting revisions: `<w:pPrChange>` holds the pPr the paragraph had BEFORE.
FORMAT_CHANGES = ("pPrChange", "rPrChange", "tblPrChange", "trPrChange",
                  "tcPrChange", "tblGridChange", "sectPrChange")

# What "accept" does to each run-level kind. Reject is the mirror.
KEEP_ON_ACCEPT = {"ins": True, "del": False, "moveTo": True, "moveFrom": False}


def is_paragraph_mark(el) -> bool:
    """A revision on the paragraph MARK rather than on a run.

    `<w:p><w:pPr><w:rPr><w:ins/></w:rPr></w:pPr>` means the paragraph break itself
    was inserted. Treating it like a run-level insertion and unwrapping it leaves the
    document looking unchanged while the two paragraphs stay split — the edit is
    silently not applied.
    """
    rpr = el.getparent()
    return (rpr is not None and local(rpr.tag) == "rPr"
            and rpr.getparent() is not None
            and local(rpr.getparent().tag) == "pPr")


def revision_text(el) -> str:
    return "".join(t.text or "" for t in el.iter(q("t"), q("delText")))


def inventory(root) -> list[dict]:
    """Every revision in the part, in document order."""
    out = []
    for el in root.iter():
        name = local(el.tag)
        if name in RUN_LEVEL:
            out.append({"id": el.get(q("id")), "author": el.get(q("author")),
                        "date": el.get(q("date")), "kind": name,
                        "scope": "paragraph-mark" if is_paragraph_mark(el) else "run",
                        "text": revision_text(el)})
        elif name in FORMAT_CHANGES:
            out.append({"id": el.get(q("id")), "author": el.get(q("author")),
                        "date": el.get(q("date")), "kind": name,
                        "scope": "formatting", "text": ""})
    return out


def remaining(root) -> list[str]:
    """Revision markup still present. The honest end of every operation."""
    names = set(RUN_LEVEL) | set(FORMAT_CHANGES) | set(RANGE_MARKERS)
    return sorted({local(el.tag) for el in root.iter() if local(el.tag) in names})


def _unwrap(el) -> None:
    """Replace `el` with its children, in place."""
    parent = el.getparent()
    for child in list(el):
        el.remove(child)
        el.addprevious(child)
    parent.remove(el)


def _to_plain_text(el) -> None:
    for node in el.iter(q("delText")):
        node.tag = q("t")


def _merge_with_next(paragraph) -> bool:
    """Fold `paragraph` into the one after it. True if there was one.

    The surviving paragraph keeps the NEXT paragraph's properties, because the mark
    that is going away is this paragraph's. Content moves in front of the next
    paragraph's content, which is the order a reader expects.
    """
    nxt = paragraph.getnext()
    while nxt is not None and local(nxt.tag) != "p":
        nxt = nxt.getnext()
    if nxt is None:
        return False
    anchor = nxt.find(q("pPr"))
    moving = [c for c in paragraph if local(c.tag) != "pPr"]
    for child in moving:
        paragraph.remove(child)
    for i, child in enumerate(moving):
        if anchor is not None:
            anchor.addnext(child)
            anchor = child
        else:
            nxt.insert(i, child)
    paragraph.getparent().remove(paragraph)
    return True


def _matches(el, authors: set[str] | None, ids: set[str] | None) -> bool:
    if authors is not None and (el.get(q("author")) or "") not in authors:
        return False
    if ids is not None and (el.get(q("id")) or "") not in ids:
        return False
    return True


def apply(root, mode: str, *, authors: set[str] | None = None,
          ids: set[str] | None = None, max_steps: int = 100_000) -> dict:
    """Accept or reject revisions. Returns a report, always including what is left.

    One element per pass, re-scanning each time: unwrapping an insertion can expose
    a deletion that lived inside it, and a snapshot taken up front would hold stale
    element references after a paragraph merge.
    """
    if mode not in ("accept", "reject"):
        raise ValueError(f"mode must be accept or reject, got {mode!r}")
    applied: list[dict] = []
    unmergeable = 0
    steps = 0
    while steps < max_steps:
        steps += 1
        # Content first, paragraph MARKS last, and that ordering is load-bearing.
        # A paragraph mark is the first thing in a paragraph in document order
        # (`w:pPr` leads), so a plain document-order scan reaches it while the
        # paragraph still holds the very content that is about to be removed — the
        # "is this paragraph now empty" question then gets the wrong answer, and
        # rejecting an inserted paragraph leaves an empty one behind. Measured on
        # exactly that case before this ordering existed.
        target, mark_target = None, None
        for el in root.iter():
            name = local(el.tag)
            if name not in RUN_LEVEL and name not in FORMAT_CHANGES:
                continue
            if not _matches(el, authors, ids):
                continue
            if name in RUN_LEVEL and is_paragraph_mark(el):
                # `or` is wrong here: lxml elements are falsy when they have no
                # children, so `a or b` silently picks b for a childless element —
                # and it warns about it on stderr, which under Team delegation is
                # output somebody pays for.
                if mark_target is None:
                    mark_target = el
                continue
            target = el
            break
        if target is None:
            target = mark_target
        if target is None:
            break
        name = local(target.tag)
        record = {"kind": name, "id": target.get(q("id")),
                  "author": target.get(q("author")), "action": mode}

        if name in FORMAT_CHANGES:
            if mode == "accept":
                target.getparent().remove(target)
                record["effect"] = "kept the new formatting"
            else:
                # The old properties are stored INSIDE the change element; rejecting
                # means putting them back. Dropping the element instead would keep
                # the new formatting while reporting that it was rejected.
                #
                # ⚠️ They are stored one level deeper than they look: `<w:pPrChange>`
                # holds a `<w:pPr>` whose CHILDREN are the old properties. Moving the
                # change element's children up directly nests a `<w:pPr>` inside a
                # `<w:pPr>`, which is neither valid nor what anyone meant.
                holder = target.getparent()          # e.g. the current w:pPr
                inner = target[0] if (len(target)
                                      and local(target[0].tag) == local(holder.tag)) \
                    else None
                old = list(inner) if inner is not None else list(target)
                for child in list(holder):
                    if child is not target:
                        holder.remove(child)
                for child in old:
                    child.getparent().remove(child)
                    target.addprevious(child)
                holder.remove(target)
                record["effect"] = f"restored {len(old)} previous propert(ies)"
            applied.append(record)
            continue

        if is_paragraph_mark(target):
            paragraph = target.getparent().getparent().getparent()
            keep_break = (name == "del") if mode == "accept" else (name == "ins")
            target.getparent().remove(target)
            if keep_break:
                record["effect"] = "merged this paragraph with the next"
                if not _merge_with_next(paragraph):
                    # No following paragraph — the mark that is going away is the
                    # last one in the body. Two different situations share this
                    # shape and they must NOT share an outcome:
                    #   * the paragraph is now empty (its content was itself a
                    #     rejected insertion) — the empty shell should go with it
                    #   * the paragraph still holds text — dropping it would delete
                    #     content nobody asked to delete, so it stays and is named
                    if any(local(c.tag) != "pPr" for c in paragraph):
                        unmergeable += 1
                        record["effect"] = ("the paragraph break should have gone but "
                                            "there is nothing after it to merge into "
                                            "and the paragraph still holds text; the "
                                            "break was left in place")
                    else:
                        paragraph.getparent().remove(paragraph)
                        record["effect"] = ("removed the now-empty paragraph it "
                                            "ended (nothing followed it to merge into)")
            else:
                record["effect"] = "kept the paragraph break"
            record["scope"] = "paragraph-mark"
            applied.append(record)
            continue

        keep = KEEP_ON_ACCEPT[name] if mode == "accept" else not KEEP_ON_ACCEPT[name]
        record["text"] = revision_text(target)
        if keep:
            _to_plain_text(target)
            _unwrap(target)
            record["effect"] = "kept the text"
        else:
            target.getparent().remove(target)
            record["effect"] = "removed the text"
        applied.append(record)

    # The range markers carry no text, so they are cleaned up only once the move they
    # delimit is gone — otherwise a partial pass would strip the pairing.
    stripped = 0
    if authors is None and ids is None:
        for el in list(root.iter()):
            if local(el.tag) in RANGE_MARKERS:
                el.getparent().remove(el)
                stripped += 1

    left = remaining(root)
    return {"mode": mode, "applied": applied, "count": len(applied),
            "range_markers_removed": stripped,
            "paragraph_marks_with_nothing_to_merge": unmergeable,
            # Never omitted when empty: this is the field that says whether the
            # operation actually finished, and a report that mentions leftovers only
            # when there are some cannot be told from one nobody wrote.
            "remaining": left,
            "exhausted": steps >= max_steps}
