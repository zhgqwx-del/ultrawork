#!/usr/bin/env python3
"""Shared plumbing for the xlsx skill's entry points (ultrawork, self-written).

Everything here exists because getting it wrong once, in one script, is invisible:
a failure that prints a traceback instead of a sentence, a report that dumps a
100k-row sheet onto stdout, an output written over its own input.
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

from office.package import PackageError  # noqa: E402


class XlsxError(Exception):
    """A condition the caller can act on: no such sheet, bad reference, no soffice."""


def fail(message: str):
    raise XlsxError(message)


def run(entry) -> int:
    """One sentence on stderr and exit 2; exit 1 stays reserved for real crashes.

    The catch-all is not there to hide bugs — the traceback still prints — but so
    that the FIRST line an agent reads is always actionable. A library raising
    somewhere unexpected otherwise arrives as a wall of Python.
    """
    try:
        entry()
    except (XlsxError, PackageError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 - deliberate boundary
        import traceback
        print(f"error: unexpected {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc()
        return 1
    return 0


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


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")


# Anything on stdout is read by an agent and costs context; under Team delegation it
# crosses the boundary a second time. A spreadsheet is the worst offender of the
# three office formats — 100k rows is an ordinary file, and dumping it is not a
# report, it is a denial of service against the caller's context window.
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


def emit(payload: dict, out: Path | None, *compact_keys: str) -> None:
    """Write the full report to --out (if given) and a summary to stdout."""
    if out is not None:
        write_json(out, payload)
    summary = payload
    for key in compact_keys:
        summary = compact(summary, key, out)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


# ── CJK width (X15) ───────────────────────────────────────────────────────────
CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x2A6DF))


def has_cjk(s: str) -> bool:
    return any(any(a <= ord(c) <= b for a, b in CJK_RANGES) for c in s)


def display_width(s: str) -> int:
    """Width in Excel column units: a wide or fullwidth character counts as two.

    `len()` is the wrong answer and the failure is silent — the column is simply
    too narrow and the text is cut off or shown as ####. Excel's width unit is
    "characters of the default font at the default size", and a Han character
    occupies two of them.
    """
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


# Padding covers the cell's left+right inset; the cap keeps one long sentence in a
# cell from producing a column nobody can see past. Both are the values the width
# assertion in the repo's L2 gate measures against, so they are not free parameters.
WIDTH_PADDING = 2
WIDTH_CAP = 60


def needed_width(text: str) -> float:
    return min(display_width(text) + WIDTH_PADDING, WIDTH_CAP)
