#!/usr/bin/env python3
"""Shared plumbing for the pdf skill's scripts (ultrawork, self-written).

Three things every entry point needs and must not each get subtly wrong:
opening a file that may be locked, turning a human page range into indices, and
failing with a sentence instead of a traceback.

TWO READERS, ON PURPOSE
-----------------------
    pypdf       (BSD-3)          structure: pages, rotation, forms, encryption
    pypdfium2   (Apache-2.0/BSD) pixels and geometry: rendering, text boxes

They are not redundant. pypdf understands the object model — form fields,
permission bits, page trees — and cannot rasterize. pypdfium2 wraps PDFium, the
renderer inside Chrome, and is the only one of the two that can tell you where a
glyph actually landed. Every script here takes whichever one answers its question.

Both are permissively licensed. This skill was originally built on PyMuPDF, which
is AGPL-3.0-or-commercial; that is a licence a commercial product cannot carry
without buying it, so the whole skill was moved off it (059 §5·补.8c).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

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


class PdfError(Exception):
    """A condition the user can act on: wrong password, bad range, missing file."""


def fail(message: str) -> "NoReturn":  # noqa: F821 - typing.NoReturn without the import
    raise PdfError(message)


def _check_exists(path: Path) -> None:
    if not path.is_file():
        fail(f"no such file: {path}")


def open_reader(path: Path, password: str | None = None,
                allow_locked: bool = False):
    """Structure reader (pypdf), authenticating when needed.

    allow_locked is for the metadata reader only: "is this file encrypted" has to
    be answerable WITHOUT the password, so that one caller accepts a document whose
    pages it cannot read. Everyone else fails loudly — silently returning an empty
    page list looks exactly like an empty PDF.
    """
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    _check_exists(path)
    try:
        reader = PdfReader(str(path))
    except (PdfReadError, OSError, ValueError) as e:
        fail(f"cannot open {path.name} as a PDF: {type(e).__name__}: {e}")
    if not reader.is_encrypted:
        return reader
    if password is not None:
        # decrypt() returns a PasswordType; 0 (NOT_DECRYPTED) is the failure.
        if not reader.decrypt(password):
            fail(f"the supplied --password was rejected by {path.name}")
        return reader
    if allow_locked:
        return reader
    fail(f"{path.name} is password-protected: pass --password")


#: Value of `uw_forms_note` when the document carries no AcroForm at all.
FORMS_NONE = "none"


def open_raster(path: Path, password: str | None = None):
    """Pixel/geometry reader (pypdfium2). Caller must close it.

    PDFium takes the password up front and raises if it is wrong, so the two
    failure messages below are the same ones open_reader produces — a caller should
    not be able to tell which library refused it.

    ⚠️ `init_forms()` happens HERE, not in the caller. A filled AcroForm keeps its
    value in the widget's `/AP` appearance stream, and PDFium only paints those once
    a form env exists — without it a filled form and an empty one rasterize to
    *byte-identical* images (measured on `form-filled.pdf`: 13540 dark pixels either
    way, 22291 once the form env is up). Putting it in the shared open means a future
    rasterizing caller cannot forget it; putting it in `pdf_render` alone would be
    the same shape as the guards this tree has twice found installed on a path
    nobody walks. PDFium requires the call right after construction, before the page
    count or any page handle is taken — which is exactly where it sits.

    The outcome is recorded on the document as `uw_forms_note` and reported by the
    caller, so "the form layer is off" can never look like "this document has no
    form values".
    """
    import pypdfium2 as pdfium

    _check_exists(path)
    try:
        doc = pdfium.PdfDocument(str(path), password=password)
    except pdfium.PdfiumError as e:
        text = str(e).lower()
        if "password" in text:
            if password is None:
                fail(f"{path.name} is password-protected: pass --password")
            fail(f"the supplied --password was rejected by {path.name}")
        fail(f"cannot open {path.name} as a PDF: {type(e).__name__}: {e}")
    except (OSError, ValueError) as e:
        fail(f"cannot open {path.name} as a PDF: {type(e).__name__}: {e}")
    try:
        doc.uw_forms_note = "initialised" if doc.init_forms() else FORMS_NONE
    except Exception as e:  # noqa: BLE001 - a broken form env must not block pixels
        # Refusing to rasterize a readable page because its form env failed would be
        # worse than rendering it without the widget layer. Say which one happened.
        doc.uw_forms_note = f"unavailable: {type(e).__name__}: {e}"
    return doc


def is_encrypted(path: Path) -> bool:
    """Whether the FILE is encrypted, read from its structure.

    Not from metadata and not from "did opening it fail": a file can carry an empty
    user password, open without one, and still be encrypted.
    """
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError
    _check_exists(path)
    try:
        return bool(PdfReader(str(path)).is_encrypted)
    except (PdfReadError, OSError, ValueError):
        return False


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

    Every other failure in these scripts is one sentence and exit 2; a library that
    truncates the file it is reading, or raises its own error type, would break that
    contract. An agent reading a traceback has to guess what to do.
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


def pointer(out: Path | None, fallback: str) -> str:
    """Where the untrimmed data went — **with its size**.

    Trimming stdout only MOVES the bytes; it does not stop them. The note is read by
    an agent, and the shipped wording ("the full list is in <path>") reads as an
    instruction to go fetch it — measured 2026-08-16 in a live session, a model
    answered `--out ... && cat ...` and pulled 22x what the trim had allowed through.
    The one number that decides whether following the pointer is safe is the size of
    what it points at, and that is exactly what the message left out.
    """
    if out is None:
        return fallback
    try:
        size = out.stat().st_size
    except OSError:
        return f"; the full list is in {out}"
    return (f"; the full list is in {out} ({size} bytes) — read the entries you need "
            f"out of it, or re-run with a narrower --pages. Printing a file that size "
            f"back is the context blowout this trim exists to prevent")


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
        + pointer(out, "; pass --out to write the full list to a file"))
    return trimmed


def to_page_space(box, rotation: int, disp_w: float, disp_h: float) -> tuple:
    """Display box -> page (unrotated) box. Both top-left origin, y downwards.

    pdfplumber reports DISPLAY coordinates — rotation already applied — while
    anything written back into the file (a drawn box, an annotation) lives in page
    space. The conversion is silent when it is wrong: on an unrotated page the two
    frames are identical, so a mistake here only shows up on rotated pages, drawn
    onto empty paper.
    """
    x0, y0, x1, y1 = box
    if rotation == 90:
        corners = [(y0, disp_w - x1), (y1, disp_w - x0)]
    elif rotation == 180:
        corners = [(disp_w - x1, disp_h - y1), (disp_w - x0, disp_h - y0)]
    elif rotation == 270:
        corners = [(disp_h - y1, x0), (disp_h - y0, x1)]
    else:
        return tuple(box)
    (ax, ay), (bx, by) = corners
    return (min(ax, bx), min(ay, by), max(ax, bx), max(ay, by))


def to_display_space(box, rotation: int, page_w: float, page_h: float) -> tuple:
    """Page (unrotated) box -> display box. The inverse of `to_page_space`.

    Widget rectangles and anything else stored in the file live in page space, so
    this is the direction the form family needs; text extracted by pdfplumber
    arrives already in display space and needs the other one.
    """
    x0, y0, x1, y1 = box
    if rotation == 90:
        corners = [(page_h - y1, x0), (page_h - y0, x1)]
    elif rotation == 180:
        corners = [(page_w - x1, page_h - y1), (page_w - x0, page_h - y0)]
    elif rotation == 270:
        corners = [(y0, page_w - x1), (y1, page_w - x0)]
    else:
        return tuple(box)
    (ax, ay), (bx, by) = corners
    return (min(ax, bx), min(ay, by), max(ax, bx), max(ay, by))


def pdf_rect_to_top_left(rect, page_h: float) -> tuple:
    """A PDF /Rect (bottom-left origin, y up) as a top-left, y-down box.

    Every box this skill reports uses the top-left convention, because that is what
    a reader of the JSON expects and what the rendered image uses. Mixing the two is
    invisible on a square box and wrong everywhere else.
    """
    x0, y0, x1, y1 = (float(v) for v in rect)
    lo, hi = min(y0, y1), max(y0, y1)
    return (min(x0, x1), page_h - hi, max(x0, x1), page_h - lo)


def detach_contents(writer, page) -> None:
    """Give `page` a private copy of its content stream before anything merges onto it.

    ⚠️ Pages CAN share content objects. A producer that deduplicates identical
    objects (MuPDF's `garbage=4` does, and fixtures/table-grid.pdf is two nearly
    identical pages) leaves page 2's /Contents array pointing at the same streams as
    page 1's. pypdf's merge path then calls replace_contents, which NULLS every
    object in the array it replaced — so merging a box onto page 1 silently empties
    page 2.

    Measured: the overlay of table-grid.pdf came out with page 2 blank, 66 characters
    of text down to 0, while the same code was fine on a three-page document whose
    pages share nothing. Concatenating the parts into one new stream first is what
    makes the nulling harmless, because then nothing else points at it.
    """
    from pypdf.generic import ArrayObject, DecodedStreamObject, NameObject

    raw = page.raw_get("/Contents") if "/Contents" in page else None
    if raw is None:
        return
    parts = list(raw.get_object()) if isinstance(raw.get_object(), ArrayObject) else [raw]
    chunks = []
    for part in parts:
        try:
            chunks.append(part.get_object().get_data())
        except Exception:  # noqa: BLE001 - a part we cannot read is left out loudly
            continue
    # PDF 32000 §7.8.2: an array of content streams is the concatenation of its
    # parts, with whitespace between them.
    stream = DecodedStreamObject()
    stream.set_data(b"\n".join(chunks))
    page[NameObject("/Contents")] = writer._add_object(stream)


def draw_boxes_overlay(src: Path, dest: Path, boxes_by_page: dict,
                       password: str | None = None, width: float = 0.4,
                       labels_by_page: dict | None = None,
                       label_font: str = "Helvetica",
                       label_size: float = 6.0) -> None:
    """Copy the document with boxes stroked on. `boxes_by_page` is {index: [(box, rgb)]}.

    `labels_by_page` is the same shape with `(x, y, text, rgb)` entries, for the
    callers that need to say WHICH box is which; y is the text's baseline, top-left
    frame like every other coordinate here.

    The rectangles go in PAGE space, the same frame `bbox` reports, because a merged
    overlay composes into the page's own coordinate system before any /Rotate is
    applied for display. Using display coordinates here is exactly the mistake that
    two-frame reporting exists to prevent.
    """
    import io
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas

    reader = PdfReader(str(src))
    if reader.is_encrypted and password is not None:
        reader.decrypt(password)
    writer = PdfWriter(clone_from=reader)
    labels_by_page = labels_by_page or {}
    for index, page in enumerate(writer.pages):
        marks = boxes_by_page.get(index) or []
        notes = labels_by_page.get(index) or []
        if marks or notes:
            detach_contents(writer, page)
            mb = page.mediabox
            pw, ph = float(mb.width), float(mb.height)
            buf = io.BytesIO()
            c = canvas.Canvas(buf, pagesize=(pw, ph))
            c.setLineWidth(width)
            for box, rgb in marks:
                x0, y0, x1, y1 = box
                c.setStrokeColorRGB(*rgb)
                # PDF's own origin is bottom-left; reported boxes are top-left.
                c.rect(x0, ph - y1, x1 - x0, y1 - y0, stroke=1, fill=0)
            if notes:
                c.setFont(label_font, label_size)
            for x, y, text, rgb in notes:
                c.setFillColorRGB(*rgb)
                c.drawString(x, ph - y, text)
            c.showPage()
            c.save()
            buf.seek(0)
            page.merge_page(PdfReader(buf).pages[0])
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as fh:
        writer.write(fh)


def _is_pypdf_error(exc: BaseException) -> bool:
    """True for pypdf's own error family.

    Imported inside the function on purpose: `pdfcommon` is imported by every entry
    point including the ones that never touch pypdf, and a missing dependency must
    surface as this skill's own dependency message, not as an ImportError from a
    error-classification helper.
    """
    try:
        from pypdf.errors import DependencyError, DeprecationError, PyPdfError
    except ImportError:
        return False
    return isinstance(exc, (PyPdfError, DependencyError, DeprecationError))


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
        # pypdf's own error family means "this file is broken", which is exactly the
        # actionable half — but it does NOT arrive where open_reader() guards it.
        # pypdf parses LAZILY: PdfReader(...) succeeds on a file whose page tree is
        # rubble, and the PdfReadError only fires later, when pages or objects are
        # walked. The guard sat at construction time and so covered a fraction of it.
        #
        # Not a hypothesis. The L3 real-corpus run (059 §六·补九) put 73 readable
        # PDFs through read→edit and 9 of them came back as a wall of Python:
        # "Invalid object in /Pages", "Invalid hexadecimal character b'n' in hex
        # string", "Invalid Elementary Object starting with b'W'". Every one is a
        # sentence an agent can act on ("this PDF is damaged"), and every one was
        # being delivered as a crash. This file's own docstring predicted it —
        # "a library that raises where we did not expect it" — and the corpus is
        # what turned the prediction into a count.
        if _is_pypdf_error(e):
            print(f"error: this file cannot be parsed as a PDF — "
                  f"{type(e).__name__}: {e}", file=sys.stderr)
            return 2
        import traceback
        print(f"error: unexpected {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc()
        return 1
    return 0
