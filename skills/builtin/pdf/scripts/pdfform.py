#!/usr/bin/env python3
"""The form field model shared by inspect / fill / check (ultrawork, self-written).

P5-P10 are one capability family on purpose: detection, extraction, AcroForm fill,
overlay fill, overflow checking and the proof sheet all need the same record. The
important part is that a field filled by the overlay path produces the SAME record
as an AcroForm widget — otherwise "does the value fit its box" would need two
implementations and only one of them would get tested.

    {"name": "applicant", "type": "text", "page": 1,
     "rect": [x0, y0, x1, y1],          # page space, top-left origin, y down
     "rect_display": [...],             # display space (what the render shows)
     "value": "张国强", "choices": [...], "max_length": 18,
     "flags": {"required": true, ...}, "font": "Helv", "font_size": 11,
     "source": "acroform" | "overlay"}

Read with pypdf, which exposes the annotation dictionaries directly. Field type and
name are INHERITED through /Parent — a widget that carries neither is not anonymous
and untyped, it is a child, and treating it as the former silently drops fields.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import pdf_rect_to_top_left, to_display_space  # noqa: E402
from pdffont import has_cjk, text_width  # noqa: E402,F401  (re-exported)

# Ff bit meanings from the PDF spec. Only the ones that change how a field behaves
# for a filler are decoded; the raw value is kept alongside so nothing is lost.
COMMON_FLAGS = {"read_only": 1 << 0, "required": 1 << 1, "no_export": 1 << 2}
TEXT_FLAGS = {"multiline": 1 << 12, "password": 1 << 13, "comb": 1 << 24}
CHOICE_FLAGS = {"combo": 1 << 17, "editable": 1 << 18, "multi_select": 1 << 21}
BUTTON_FLAGS = {"no_toggle_off": 1 << 14, "radio": 1 << 15, "pushbutton": 1 << 16}


def inherited(obj, key: str, depth: int = 8):
    """A field attribute, following /Parent. Returns None when never set."""
    seen = 0
    while obj is not None and seen < depth:
        try:
            node = obj.get_object()
        except Exception:  # noqa: BLE001 - a broken parent chain is not fatal
            return None
        if key in node:
            return node[key]
        obj = node.get("/Parent")
        seen += 1
    return None


def type_name(annot) -> str:
    """text / checkbox / radiobutton / pushbutton / combobox / listbox."""
    ft = inherited(annot, "/FT")
    ff = int(inherited(annot, "/Ff") or 0)
    ft = str(ft) if ft is not None else ""
    if ft == "/Tx":
        return "text"
    if ft == "/Ch":
        return "combobox" if ff & CHOICE_FLAGS["combo"] else "listbox"
    if ft == "/Btn":
        if ff & BUTTON_FLAGS["pushbutton"]:
            return "pushbutton"
        return "radiobutton" if ff & BUTTON_FLAGS["radio"] else "checkbox"
    if ft == "/Sig":
        return "signature"
    return "unknown"


def decode_flags(raw: int, kind: str) -> dict:
    table = dict(COMMON_FLAGS)
    if kind == "text":
        table.update(TEXT_FLAGS)
    elif kind in ("combobox", "listbox"):
        table.update(CHOICE_FLAGS)
    elif kind in ("checkbox", "radiobutton", "pushbutton"):
        table.update(BUTTON_FLAGS)
    out = {name: bool(raw & bit) for name, bit in table.items()}
    out["raw"] = int(raw)
    return out


def round_box(box) -> list[float]:
    return [round(float(v), 2) for v in box]


def parse_da(da) -> tuple[str | None, float | None]:
    """`/Helv 11 Tf 0 g` -> ("Helv", 11.0). Size 0 means auto-size, reported as None."""
    if not da:
        return None, None
    tokens = str(da).split()
    for i, tok in enumerate(tokens):
        if tok == "Tf" and i >= 2:
            name = tokens[i - 2].lstrip("/")
            try:
                size = float(tokens[i - 1])
            except ValueError:
                size = None
            return name, (size or None)
    return None, None


def choices_of(annot) -> list[str] | None:
    opt = inherited(annot, "/Opt")
    if opt is None:
        return None
    out = []
    for entry in opt.get_object():
        item = entry.get_object()
        # An /Opt entry is either a string or [export_value, display_value].
        out.append(str(item[1] if isinstance(item, list) and len(item) > 1 else item))
    return out or None


def describe_widget(annot, number: int, rotation: int, page_w: float,
                    page_h: float) -> dict:
    kind = type_name(annot)
    node = annot.get_object()
    rect = pdf_rect_to_top_left([float(v) for v in node["/Rect"]], page_h)
    name = inherited(annot, "/T")
    value = inherited(annot, "/V")
    font, size = parse_da(inherited(annot, "/DA"))
    maxlen = inherited(annot, "/MaxLen")
    return {
        "name": str(name) if name is not None else None,
        "type": kind,
        "page": number,
        "rect": round_box(rect),
        # Same two-frame rule as pdf_extract.py: a /Rotate page makes these differ,
        # and a proof sheet drawn in the wrong one lands on empty paper.
        "rect_display": round_box(to_display_space(rect, rotation, page_w, page_h)),
        "value": None if value is None else str(value).lstrip("/"),
        "choices": choices_of(annot),
        "max_length": int(maxlen) if maxlen is not None else None,
        "flags": decode_flags(int(inherited(annot, "/Ff") or 0), kind),
        "font": font,
        "font_size": size,
        "source": "acroform",
    }


def page_geometry(page) -> tuple[int, float, float]:
    box = page.mediabox
    return int(page.rotation or 0) % 360, float(box.width), float(box.height)


def widgets_on(page):
    """The /Widget annotations of one page, in document order."""
    annots = page.get("/Annots")
    if annots is None:
        return []
    out = []
    for ref in annots:
        try:
            node = ref.get_object()
        except Exception:  # noqa: BLE001
            continue
        if str(node.get("/Subtype")) == "/Widget":
            out.append(ref)
    return out


def collect_fields(reader, pages: list[int] | None = None) -> list[dict]:
    """Every AcroForm widget in the document, in page order."""
    out = []
    for i, page in enumerate(reader.pages):
        if pages is not None and i not in pages:
            continue
        rot, w, h = page_geometry(page)
        for annot in widgets_on(page):
            out.append(describe_widget(annot, i + 1, rot, w, h))
    return out


def has_acroform(reader) -> bool:
    """True when the document carries a real AcroForm with at least one field.

    An /AcroForm dictionary with an empty /Fields array exists in the wild — a form
    that was stripped. Reporting that as "fillable" sends a filler down the AcroForm
    path, which then finds nothing to fill.
    """
    try:
        root = reader.trailer["/Root"]
        acro = root.get("/AcroForm")
        if acro is None:
            return False
        fields = acro.get_object().get("/Fields")
        return bool(fields and len(fields) > 0)
    except Exception:  # noqa: BLE001 - a malformed catalogue is not a form
        return False


# ── appearance streams ────────────────────────────────────────────────────────
# A widget carries its value twice: /V is the data, /AP /N is the picture of the
# data. Setting only /V produces a file that reports the right answer to a form
# reader and shows an empty box to a human — and setting /NeedAppearances instead
# just moves the drawing to a viewer that may or may not do it.
#
# So the pictures are drawn here. reportlab is the only permissively-licensed
# writer in this set that can EMBED a CJK face and subset it, so one throwaway
# reportlab document is generated with one page per field, and each of its pages
# becomes a Form XObject. Going through one document rather than one per field is
# not tidiness: it is what makes the four fields share a single embedded subset.

PAD = 2.0                   # points of inset from the widget's own edge
LINE_RATIO = 1.2            # leading as a multiple of the font size
DEFAULT_SIZE = 10.0


def layout_lines(text: str, font: str, size: float, width: float,
                 multiline: bool) -> list[str]:
    from pdffont import wrap
    if not multiline:
        return [text.replace("\n", " ")]
    return wrap(text, font, size, max(width - 2 * PAD, size))


def vmetrics(font: str, size: float) -> tuple[float, float]:
    """(ascent, descent) of `font` at `size`, both positive, in points.

    Not `size` and `0`: the em box is not the ink box. Laying text out as if a line
    were exactly `size` tall puts the descenders of the last line below wherever the
    box was thought to end — by 1.4pt for the CJK face measured here, which is
    enough to make a correctly-filled field read as an overflow.
    """
    from reportlab.pdfbase import pdfmetrics
    face = pdfmetrics.getFont(font).face
    return (getattr(face, "ascent", 800) / 1000.0 * size,
            abs(getattr(face, "descent", -200)) / 1000.0 * size)


def block_height(font: str, size: float, lines: int) -> float:
    """Glyph top of the first line to glyph bottom of the last."""
    ascent, descent = vmetrics(font, size)
    return ascent + descent + max(lines - 1, 0) * size * LINE_RATIO


def first_baseline(font: str, size: float, height: float, lines: int,
                   multiline: bool) -> float:
    """Distance from the widget's top edge down to the first line's baseline.

    Single-line values are centred the way a viewer centres them; a multiline value
    starts at the top and is allowed to run out the bottom if it does not fit. That
    overflow is deliberate: clipping it would hide from the eye exactly what
    pdf_form_check.py is asked to find, and the value would go missing in silence.
    """
    ascent, _ = vmetrics(font, size)
    if multiline:
        return PAD + ascent
    return max(0.0, (height - block_height(font, size, lines)) / 2) + ascent


def drawn_extent(font: str, size: float, height: float, lines: int,
                 multiline: bool) -> tuple[float, float]:
    """(top, bottom) of the ink, measured from the widget's top edge."""
    ascent, _ = vmetrics(font, size)
    top = first_baseline(font, size, height, lines, multiline) - ascent
    return top, top + block_height(font, size, lines)


def build_appearances(writer, requests: list[dict]) -> list:
    """One Form XObject per request. Returns indirect references, in order.

    request = {"width", "height", "lines", "size", "font", "multiline"}
    """
    import io

    from pypdf import PdfReader
    from pypdf.generic import (ArrayObject, DecodedStreamObject, FloatObject,
                               NameObject)
    from reportlab.pdfgen import canvas

    if not requests:
        return []
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(1, 1))
    for req in requests:
        w, h, size = req["width"], req["height"], req["size"]
        c.setPageSize((w, h))
        c.setFont(req["font"], size)
        c.setFillColorRGB(0, 0, 0)
        base = first_baseline(req["font"], size, h, len(req["lines"]),
                              req["multiline"])
        for i, line in enumerate(req["lines"]):
            # drawString takes the BASELINE, and the canvas counts up from the
            # bottom while every box in this skill counts down from the top.
            c.drawString(PAD, h - base - i * size * LINE_RATIO, line)
        c.showPage()
    c.save()
    buf.seek(0)

    out = []
    for req, page in zip(requests, PdfReader(buf).pages):
        xo = DecodedStreamObject()
        xo.set_data(page.get_contents().get_object().get_data())
        xo[NameObject("/Type")] = NameObject("/XObject")
        xo[NameObject("/Subtype")] = NameObject("/Form")
        xo[NameObject("/BBox")] = ArrayObject(
            [FloatObject(0), FloatObject(0),
             FloatObject(req["width"]), FloatObject(req["height"])])
        xo[NameObject("/Resources")] = page["/Resources"]
        out.append(writer._add_object(xo.clone(writer)))
    return out


def normal_appearance(annot):
    """The /AP /N stream a viewer would draw for this widget, or None.

    /N is a stream for a text field and a dictionary of states for a button, and
    picking the dictionary itself would flatten a checkbox as a blob of nothing.
    """
    ap = annot.get("/AP")
    if ap is None:
        return None
    normal = ap.get("/N")
    if normal is None:
        return None
    normal = normal.get_object()
    if "/Subtype" in normal:
        return normal
    state = annot.get("/AS")
    pick = normal.get(state) if state is not None else None
    return None if pick is None else pick.get_object()


def _bbox_after(bbox, matrix) -> tuple:
    a, b, c, d, e, f = matrix
    xs, ys = [], []
    for x, y in ((bbox[0], bbox[1]), (bbox[2], bbox[1]),
                 (bbox[2], bbox[3]), (bbox[0], bbox[3])):
        xs.append(a * x + c * y + e)
        ys.append(b * x + d * y + f)
    return min(xs), min(ys), max(xs), max(ys)


def flatten_appearances(src: Path, dest: Path, password: str | None = None) -> None:
    """Copy the document with every annotation's appearance painted into the page.

    This is how the widgets become measurable. pdfplumber, PDFium and pdfminer all
    read the page content stream and nothing else — a value that lives only in a
    widget's /AP is invisible to all three, so "where did the glyphs actually land"
    could not be answered at all without first putting them on the page.

    The placement follows PDF 32000 §12.5.5: the appearance's /BBox is mapped
    through its /Matrix, and the result is fitted to the annotation's /Rect. Almost
    every real widget has an identity matrix and a zero-origin box, in which case
    this reduces to a translation — but a rotated appearance placed by translation
    alone lands somewhere else entirely, and nothing would say so.
    """
    from pypdf import PageObject, PdfReader, PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    from pdfcommon import detach_contents

    reader = PdfReader(str(src))
    if reader.is_encrypted and password is not None:
        reader.decrypt(password)
    writer = PdfWriter(clone_from=reader)
    for page in writer.pages:
        mb = page.mediabox
        xobjects, commands = DictionaryObject(), []
        for i, ref in enumerate(page.get("/Annots") or []):
            annot = ref.get_object()
            normal = normal_appearance(annot)
            if normal is None:
                continue
            rect = [float(v) for v in annot["/Rect"]]
            rx0, rx1 = min(rect[0], rect[2]), max(rect[0], rect[2])
            ry0, ry1 = min(rect[1], rect[3]), max(rect[1], rect[3])
            bbox = [float(v) for v in normal.get("/BBox", [0, 0, rx1 - rx0, ry1 - ry0])]
            bx0, by0, bx1, by1 = _bbox_after(
                bbox, [float(v) for v in normal.get("/Matrix", [1, 0, 0, 1, 0, 0])])
            sx = (rx1 - rx0) / (bx1 - bx0) if bx1 > bx0 else 1.0
            sy = (ry1 - ry0) / (by1 - by0) if by1 > by0 else 1.0
            name = NameObject(f"/UWFlat{i}")
            xobjects[name] = writer._add_object(normal.clone(writer))
            commands.append(f"q {sx} 0 0 {sy} {rx0 - bx0 * sx} {ry0 - by0 * sy} cm "
                            f"{name} Do Q")
        if not commands:
            continue
        overlay = PageObject.create_blank_page(width=float(mb.width),
                                               height=float(mb.height))
        overlay[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/XObject"): xobjects})
        stream = DecodedStreamObject()
        stream.set_data("\n".join(commands).encode())
        overlay[NameObject("/Contents")] = writer._add_object(stream)
        # merge_page, not a hand-written append: it wraps the page's own content in
        # q/Q, so an unbalanced producer cannot leave a transform in force and shift
        # every flattened widget by an amount nothing reports. detach_contents first,
        # because merge_page nulls the content objects it replaces and pages can
        # share them — see the note there.
        detach_contents(writer, page)
        page.merge_page(overlay)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as fh:
        writer.write(fh)


def load_placements(path: Path) -> list[dict]:
    """Overlay instructions: either an explicit rect or an anchor to search for."""
    import json

    from pdfcommon import fail

    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("placements") if isinstance(data, dict) else data
    if not isinstance(items, list) or not items:
        fail(f"{path.name}: expected a non-empty list under \"placements\"")
    for i, item in enumerate(items):
        if not isinstance(item, dict) or "text" not in item:
            fail(f"{path.name}: placement #{i} has no \"text\"")
        if "rect" not in item and "anchor" not in item:
            fail(f"{path.name}: placement #{i} ({item.get('name') or item['text']!r}) "
                 f"needs either \"rect\" or \"anchor\"")
    return items
