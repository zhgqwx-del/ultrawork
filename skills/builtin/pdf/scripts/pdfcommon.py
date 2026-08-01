#!/usr/bin/env python3
"""Shared plumbing for the pdf skill's scripts (ultrawork, self-written).

Three things every entry point needs and must not each get subtly wrong:
opening a file that may be locked, turning a human page range into indices, and
failing with a sentence instead of a traceback.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


class PdfError(Exception):
    """A condition the user can act on: wrong password, bad range, missing file."""


def fail(message: str) -> "NoReturn":  # noqa: F821 - typing.NoReturn without the import
    raise PdfError(message)


def open_pdf(path: Path, password: str | None = None, allow_locked: bool = False):
    """Open a PDF, authenticating when needed.

    allow_locked is for the metadata reader only: "is this file encrypted" is a
    question that has to be answerable WITHOUT the password, so that one caller
    accepts a document it cannot read the pages of. Everyone else must fail loudly
    — silently returning an empty page list would look exactly like an empty PDF.
    """
    import fitz

    if not path.is_file():
        fail(f"no such file: {path}")
    try:
        doc = fitz.open(str(path))
    except Exception as e:  # noqa: BLE001 - fitz raises several unrelated types
        fail(f"cannot open {path.name} as a PDF: {type(e).__name__}: {e}")
    # PyMuPDF: `needs_pass` is a property of the FILE and stays 1 even after a
    # successful authenticate(); `is_encrypted` is the one that flips to False once
    # the document is open. Testing needs_pass for "still locked" reports every
    # password-protected file as unreadable, including the ones just unlocked.
    if doc.needs_pass:
        if password is not None:
            doc.authenticate(password)
            # A rejected password is an error even for allow_locked callers: the
            # caller believes it holds the key, and handing back a "this file is
            # locked" report would read as a property of the file rather than as
            # "you typed the wrong password".
            if doc.is_encrypted:
                doc.close()
                fail(f"the supplied --password was rejected by {path.name}")
            return doc
        if allow_locked:
            return doc
        doc.close()
        fail(f"{path.name} is password-protected: pass --password")
    return doc


def parse_pages(spec: str | None, page_count: int) -> list[int]:
    """'1-3,5' / 'all' / None -> sorted unique ZERO-based indices.

    Out-of-range numbers are an error, not a silent clamp: a caller asking for page
    12 of a 3-page document has a wrong assumption, and quietly handing back page 3
    lets that assumption survive into whatever it does next.
    """
    if page_count <= 0:
        fail("document reports 0 pages")
    if spec is None or spec.strip().lower() in ("", "all"):
        return list(range(page_count))
    wanted: set[int] = set()
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk[1:]:                       # chunk[1:] keeps "-2" an error
            head, _, tail = chunk.partition("-")
            first, last = _page_number(head, page_count), _page_number(tail, page_count)
            if last < first:
                fail(f"page range {chunk!r} runs backwards")
            wanted.update(range(first, last + 1))
        else:
            wanted.add(_page_number(chunk, page_count))
    if not wanted:
        fail(f"page selection {spec!r} selects nothing")
    return sorted(wanted)


def _page_number(token: str, page_count: int) -> int:
    token = token.strip()
    if not token.isdigit():
        fail(f"{token!r} is not a page number (use 1-based numbers, e.g. 1-3,5)")
    n = int(token)
    if n < 1 or n > page_count:
        fail(f"page {n} is out of range: the document has {page_count} page(s)")
    return n - 1


def ensure_distinct(src: Path, out: Path, label: str = "--out") -> None:
    """Refuse to write an output over one of its own inputs.

    PyMuPDF answers this with `ValueError: save to original must be incremental`,
    i.e. a raw traceback — every other failure in these scripts is one sentence and
    exit 2, and an agent reading a traceback has to guess what to do. The input
    survives either way; this is about the message, and about not depending on the
    library to notice.
    """
    try:
        same = out.exists() and src.resolve() == out.resolve()
    except OSError:
        same = False
    if same:
        fail(f"{label} is the same file as --in ({out}); write somewhere else and "
             f"replace it afterwards if that is what you meant")


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")


# Anything printed on stdout is read by an agent and costs context — and in Team
# mode it crosses the delegation boundary as well. Measured before this existed:
# pdf_info.py on a 300-page document printed 82KB of per-page geometry, split
# printed 18KB of part names. The full data belongs in --out; stdout stays a
# summary once a list gets long.
STDOUT_ITEM_LIMIT = 20


def compact(payload: dict, key: str, out: Path | None,
            limit: int = STDOUT_ITEM_LIMIT) -> dict:
    """A stdout-sized copy of `payload`: long lists replaced by a count + pointer."""
    items = payload.get(key)
    if not isinstance(items, list) or len(items) <= limit:
        return payload
    trimmed = {k: v for k, v in payload.items() if k != key}
    trimmed[f"{key}_count"] = len(items)
    trimmed[f"{key}_note"] = (
        f"{len(items)} entries omitted from stdout"
        + (f"; the full list is in {out}" if out else
           "; pass --out to write the full list to a file"))
    return trimmed


def run(entry) -> int:
    """Turn PdfError into one line on stderr and exit 2; keep 1 for crashes.

    The catch-all is not there to hide bugs — the traceback still goes to stderr —
    but to guarantee the FIRST line is always a sentence an agent can act on. A
    library that raises where we did not expect it (a malformed producer, a version
    change) otherwise reaches the caller as a wall of Python.
    """
    try:
        entry()
    except PdfError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 - deliberate boundary
        import traceback
        print(f"error: unexpected {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc()
        return 1
    return 0
