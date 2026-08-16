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


def ensure_distinct(src: Path, out: Path, label: str = "--out") -> bool:
    """Refuse to write an output over one of its own inputs; say if it replaces
    somebody else's.

    A surgical edit reads the whole package into memory first, so writing in place
    would in fact work — which is exactly why this is explicit. It works until the
    day a script streams, and then it silently truncates the input it is reading.

    The return value answers the OTHER question, and it has to be asked here because
    after the write the answer is always True: **was there already a file at `--out`
    that this run is about to replace?** `--out == --in` is the only case refused;
    a different path, a different extension, somebody else's bytes — none of that is
    caught, and until 2026-08-16 nothing in this skill said a word about it either
    (059 §三十四; the docx skill grew the same field in §二十四). Not a refusal on
    purpose: re-running a conversion over its own last output is normal, and a tool
    that demands --force gets --force added to it permanently.
    """
    try:
        same = out.exists() and src.resolve() == out.resolve()
    except OSError:
        same = False
    if same:
        fail(f"{label} is the same file as --in ({out}); write somewhere else and "
             f"replace it afterwards if that is what you meant")
    return out.exists()


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")


# Anything on stdout is read by an agent and costs context; under Team delegation it
# crosses the boundary a second time. A spreadsheet is the worst offender of the
# three office formats — 100k rows is an ordinary file, and dumping it is not a
# report, it is a denial of service against the caller's context window.
STDOUT_ITEM_LIMIT = 20


def pointer(out: Path | None, fallback: str) -> str:
    """Where the untrimmed data went — **with its size**.

    Trimming stdout only MOVES the bytes; it does not stop them. The note is read by
    an agent, and the shipped wording ("the full list is in <path>") reads as an
    instruction to go fetch it: measured 2026-08-16 in a live session, a model
    answered `--out /tmp/cells.json && cat /tmp/cells.json` and pulled 5,752 bytes
    where the trim had held stdout to 259. On a 2000x30 sheet the same move is
    6,439,603 bytes. The one number that decides whether following the pointer is
    safe is the size of what it points at, and that is exactly what the message left
    out — so state it, before the caller has to find out by paying for it.
    """
    if out is None:
        return fallback
    try:
        size = out.stat().st_size
    except OSError:
        return f"; the full list is in {out}"
    return (f"; the full list is in {out} ({size} bytes) — read the entries you need "
            f"out of it, or re-run with a narrower --range/--cells. Printing a file "
            f"that size back is the context blowout this trim exists to prevent")


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
        + pointer(out, "; pass --out to write the full list to a file"))
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


# Number formats this module will render. Anything outside these characters —
# conditions and colours (`[Red]`), scientific notation, literal text in quotes,
# fractions, dates — is reported as UNMEASURED rather than guessed at: a width
# computed from a wrong rendering is a wrong width, and it fails the same silent
# way the bug this exists to catch does.
NUMFMT_SAFE = set("0#,.% ")


def displayed_text(value, number_format: str) -> str | None:
    """What the cell SHOWS, as text — or None when the format is not one we render.

    A number is displayed through its format, and that is what decides whether the
    column is wide enough: `1.08771929824562` under `0.0%` is `108.8%`, six
    characters, and in a column six units wide Excel prints `###`. Measuring the raw
    value, or skipping numbers entirely, misses exactly that.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, str):
        return value
    if not isinstance(value, (int, float)):
        return None
    fmt = (number_format or "General").split(";")[0].strip()
    if fmt in ("General", ""):
        return f"{value:.10g}"
    if any(c not in NUMFMT_SAFE for c in fmt):
        return None
    scaled = value * (100 ** fmt.count("%"))
    body = fmt.replace("%", "")
    head, _, tail = body.partition(".")
    decimals = len(tail.replace(",", ""))
    text = f"{scaled:,.{decimals}f}" if "," in head else f"{scaled:.{decimals}f}"
    return text + "%" * fmt.count("%")
