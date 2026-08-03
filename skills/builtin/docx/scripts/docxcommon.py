#!/usr/bin/env python3
"""Shared plumbing for the docx skill's entry points (ultrawork, self-written).

Everything here exists because getting it wrong once, in one script, is invisible:
a failure that prints a traceback instead of a sentence, a report that dumps a
300-page document onto stdout, an output written over its own input.
"""
from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# ── stdout must be UTF-8 on every platform, and on Windows it is not ──────────
# Every report this skill prints carries Chinese. Windows encodes a captured stdout
# in the machine's ANSI code page (cp1252 on a western install, cp936 on a Chinese
# one), and Python only defaults to UTF-8 from 3.15 (PEP 686) — CI pins 3.11.
# Measured by forcing the code page locally: WITHOUT the two lines below, EVERY entry
# point of this skill exits 2 with UnicodeEncodeError the moment its output is
# captured — which is exactly how an agent calls it. It cannot be seen on macOS or
# Linux, and it was found by a CI run on Windows, not by any local gate.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (ValueError, OSError):        # already detached / not reconfigurable
            pass

from office.package import Package, PackageError  # noqa: E402
from office.validate import check_package, is_wordprocessing  # noqa: E402

DOCUMENT = "word/document.xml"


class DocxError(Exception):
    """A condition the caller can act on: no such style, bad range, no LibreOffice."""


def fail(message: str):
    raise DocxError(message)


def run(entry) -> int:
    """One sentence on stderr and exit 2; exit 1 stays reserved for real crashes.

    The catch-all is not there to hide bugs — the traceback still prints — but so
    that the FIRST line an agent reads is always actionable. A library raising
    somewhere unexpected otherwise arrives as a wall of Python.
    """
    try:
        entry()
    except (DocxError, PackageError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 - deliberate boundary
        import traceback
        print(f"error: unexpected {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc()
        return 1
    return 0


def open_document(path: Path) -> Package:
    """Open a .docx and refuse anything that is not one, by name.

    "Not a Word document" arrives in three different shapes — not a zip, a zip with
    no content types, a valid OOXML package that happens to be a spreadsheet — and
    each of them otherwise surfaces as a different library's exception several
    frames away from the file the user actually named.
    """
    pkg = Package.open(path)
    if not is_wordprocessing(pkg):
        fail(f"{path.name} is an OOXML package but not a Word document "
             f"(no word/document.xml with a <w:document> root) — for .xlsx use the "
             f"`xlsx` skill, for .pptx use `deckcraft`")
    return pkg


def ensure_distinct(src: Path, out: Path, label: str = "--out") -> None:
    """Refuse to write an output over one of its own inputs.

    A surgical edit reads the whole package into memory first, so writing in place
    would in fact work — which is exactly why this is explicit. It works until the
    day a script streams, and then it silently truncates the input it is reading.
    """
    try:
        same = out.exists() and src.resolve() == out.resolve()
    except OSError:
        same = False
    if same:
        fail(f"{label} is the same file as --in ({out}); write somewhere else and "
             f"replace it afterwards if that is what you meant")


def save_checked(pkg: Package, out: Path, pre_existing: list[str]) -> list[str]:
    """Write the package, but only if this edit did not break it.

    Damage the input already carried is REPORTED and not treated as fatal: the
    documents most in need of an edit are the ones that are already a bit broken,
    and a tool that refuses them is a tool that helps only where help is not needed.
    Damage this edit introduced is a different thing entirely and stops the write.
    """
    findings = check_package(pkg)
    new = [f for f in findings if f not in pre_existing]
    if new:
        fail("this edit would have produced a package with problems that were not in "
             "the input, so nothing was written:\n  - " + "\n  - ".join(new))
    pkg.save(out)
    return [f for f in findings if f in pre_existing]


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")


# Anything on stdout is read by an agent and costs context; under Team delegation it
# crosses the boundary a second time. A long document is an ordinary document —
# dumping every paragraph of a contract is not a report, it is a denial of service
# against the caller's context window.
STDOUT_ITEM_LIMIT = 20


def compact(payload: dict, key: str, out: Path | None,
            limit: int = STDOUT_ITEM_LIMIT) -> dict:
    """A stdout-sized copy of `payload`: a long list becomes a count and a pointer."""
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


# The item-count trimmer above is not enough on its own, and finding out why took a
# question the gates could not ask: it counts ENTRIES, so a report holding ONE table
# with 800 rows has a list of length 1 and sails straight through. Measured: a single
# 803-row table printed **130,602 bytes** to stdout — 21x the budget the paragraph
# path is held to. So the last word is a byte budget.
STDOUT_BYTE_BUDGET = 6000


def _summarise(payload: dict, key: str, out: Path | None, why: str) -> dict:
    items = payload.get(key)
    if not isinstance(items, list):
        return payload
    trimmed = {k: v for k, v in payload.items() if k != key}
    trimmed[f"{key}_count"] = len(items)
    trimmed[f"{key}_note"] = (
        f"{why}; omitted from stdout"
        + (f". The full list is in {out}" if out else
           ". Pass --out to write the full report to a file"))
    return trimmed


def emit(payload: dict, out: Path | None, *compact_keys: str) -> None:
    """Write the full report to --out (if given) and a summary to stdout.

    Two passes, because they catch different shapes: MANY small entries (trimmed by
    count) and FEW enormous ones (trimmed by size). Everything printed here is read
    by an agent and paid for in context — twice, when the call crosses a Team
    delegation boundary.
    """
    if out is not None:
        write_json(out, payload)
    summary = payload
    for key in compact_keys:
        summary = compact(summary, key, out)

    def rendered(d: dict) -> str:
        return json.dumps(d, ensure_ascii=False, indent=2)

    if len(rendered(summary).encode("utf-8")) > STDOUT_BYTE_BUDGET:
        # Biggest first, so the smallest number of sections is sacrificed. Only keys
        # the caller nominated are touched: silently dropping a field nobody marked
        # as bulky would hide the answer instead of the noise.
        sizes = sorted(
            ((len(rendered({k: summary[k]}).encode("utf-8")), k)
             for k in compact_keys if isinstance(summary.get(k), list)),
            reverse=True)
        for size, key in sizes:
            summary = _summarise(summary, key, out, f"{size} bytes")
            if len(rendered(summary).encode("utf-8")) <= STDOUT_BYTE_BUDGET:
                break
    print(rendered(summary))


# ── CJK width, for anything that has to fit text into a measured box ──────────
def display_width(s: str) -> int:
    """Width in monospace cells: a wide or fullwidth character counts as two."""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def clip(s: str, width: int = 40) -> str:
    """A sample of a paragraph short enough to read in a report."""
    out, used = [], 0
    for c in s:
        w = 2 if unicodedata.east_asian_width(c) in "WF" else 1
        if used + w > width:
            return "".join(out) + "…"
        out.append(c)
        used += w
    return "".join(out)
