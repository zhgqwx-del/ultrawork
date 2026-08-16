#!/usr/bin/env python3
"""Picture files: how big they are, and how big that is in a Word document.

Word does not measure pictures in pixels. It measures them in **EMU** — English
Metric Units, 914400 to the inch, 360000 to the centimetre — a unit chosen so that
both inches and centimetres divide it exactly. A drawing's `<wp:extent>` is in EMU,
and the number is not derivable from a pixel count alone: 240 pixels is 2.5 inches
at 96 dpi and 1.6 inches at 150. Filling the extent with the pixel count itself
(240) produces a picture 0.00026 inches wide, which Word renders as nothing at all;
filling it with a centimetre count produces one many pages tall. Neither raises an
error anywhere — the document is valid, the picture is simply the wrong size, and
that is why this conversion lives in a module with its own tests rather than inline.

The dimensions are read here rather than with an imaging library because this skill
has three dependencies (python3, lxml, LibreOffice) and adding Pillow to read four
integers out of a file header would be a poor trade. The parsing is deliberately
narrow: the formats Word actually embeds, and a refusal by name for anything else.
"""
from __future__ import annotations

import struct
from pathlib import Path

EMU_PER_INCH = 914400
EMU_PER_CM = 360000
# What a file says when it says nothing. 96 dpi is the web's assumption and Word's
# own default for an image with no density; it is a fallback, and callers are told
# when it was used rather than left to assume the file was measured.
DEFAULT_DPI = 96.0

CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "emf": "image/x-emf",
    "wmf": "image/x-wmf",
}


class MediaError(Exception):
    """A picture this module will not guess about."""


def content_type_for(extension: str) -> str:
    ext = extension.lstrip(".").lower()
    if ext not in CONTENT_TYPES:
        raise MediaError(
            f"'.{ext}' is not a picture format Word embeds. Word understands "
            f"{', '.join(sorted(set(CONTENT_TYPES)))}; SVG in particular needs a "
            f"raster fallback alongside it, which this skill does not generate — "
            f"convert it first")
    return CONTENT_TYPES[ext]


def _png(data: bytes) -> tuple[int, int, float, float, bool]:
    if len(data) < 24 or data[12:16] != b"IHDR":
        raise MediaError("not a PNG: no IHDR where the format requires one")
    width, height = struct.unpack(">II", data[16:24])
    dpi_x = dpi_y = DEFAULT_DPI
    measured = False
    pos = 8
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I", data[pos:pos + 4])[0], data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if kind == b"pHYs" and length >= 9:
            ppu_x, ppu_y, unit = struct.unpack(">IIB", body[:9])
            if unit == 1 and ppu_x and ppu_y:      # unit 1 = pixels per metre
                dpi_x, dpi_y = ppu_x * 0.0254, ppu_y * 0.0254
                measured = True
            break
        if kind == b"IDAT":
            break                                   # pHYs must precede IDAT
        pos += 12 + length
    return width, height, dpi_x, dpi_y, measured


_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
        0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _jpeg(data: bytes) -> tuple[int, int, float, float, bool]:
    dpi_x = dpi_y = DEFAULT_DPI
    measured = False
    pos, size = 2, len(data)
    while pos + 4 <= size:
        if data[pos] != 0xFF:
            pos += 1
            continue
        marker = data[pos + 1]
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        length = struct.unpack(">H", data[pos + 2:pos + 4])[0]
        body = data[pos + 4:pos + 2 + length]
        if marker == 0xE0 and body[:5] == b"JFIF\x00" and len(body) >= 12:
            units, x_density, y_density = struct.unpack(">BHH", body[7:12])
            if x_density and y_density:
                if units == 1:                      # dots per inch
                    dpi_x, dpi_y, measured = float(x_density), float(y_density), True
                elif units == 2:                    # dots per centimetre
                    dpi_x, dpi_y = x_density * 2.54, y_density * 2.54
                    measured = True
        elif marker in _SOF and len(body) >= 5:
            height, width = struct.unpack(">HH", body[1:5])
            return width, height, dpi_x, dpi_y, measured
        pos += 2 + length
    raise MediaError("not a readable JPEG: no frame header (SOFn) found")


def _gif(data: bytes) -> tuple[int, int, float, float, bool]:
    if len(data) < 10:
        raise MediaError("not a readable GIF: the header is truncated")
    width, height = struct.unpack("<HH", data[6:10])
    return width, height, DEFAULT_DPI, DEFAULT_DPI, False


class Picture:
    """A picture file's intrinsic geometry, and what that is in a Word document."""

    def __init__(self, path: Path):
        self.path = path
        if not path.is_file():
            raise MediaError(f"no such picture: {path}")
        data = path.read_bytes()
        self.extension = path.suffix.lstrip(".").lower()
        self.content_type = content_type_for(self.extension)
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            reader = _png
        elif data[:2] == b"\xff\xd8":
            reader = _jpeg
        elif data[:3] == b"GIF":
            reader = _gif
        else:
            # A vector or a TIFF: Word embeds them, but nothing here can measure
            # them, and inventing a size is the failure this module exists to stop.
            raise MediaError(
                f"{path.name} is a format this skill cannot measure "
                f"(it reads PNG, JPEG and GIF headers). Pass --width-cm so the size "
                f"comes from you rather than from a guess, or convert it first")
        self.width_px, self.height_px, self.dpi_x, self.dpi_y, self.density_measured = \
            reader(data)
        if not self.width_px or not self.height_px:
            raise MediaError(f"{path.name} reports a zero dimension "
                             f"({self.width_px}x{self.height_px})")

    # ── sizing ────────────────────────────────────────────────────────────────
    def intrinsic_emu(self) -> tuple[int, int]:
        """The size the file itself claims, in EMU."""
        return (round(self.width_px / self.dpi_x * EMU_PER_INCH),
                round(self.height_px / self.dpi_y * EMU_PER_INCH))

    def extent(self, width_cm: float | None = None,
               height_cm: float | None = None) -> tuple[int, int]:
        """`(cx, cy)` in EMU, keeping the aspect ratio when only one side is given.

        Scaling one side and leaving the other at its intrinsic value is the mistake
        that makes a picture look stretched; it is also invisible in any check that
        only asks whether a drawing exists.
        """
        cx, cy = self.intrinsic_emu()
        if width_cm is None and height_cm is None:
            return cx, cy
        aspect = self.height_px / self.width_px
        if width_cm is not None and height_cm is not None:
            return round(width_cm * EMU_PER_CM), round(height_cm * EMU_PER_CM)
        if width_cm is not None:
            cx = round(width_cm * EMU_PER_CM)
            return cx, round(cx * aspect)
        cy = round(height_cm * EMU_PER_CM)
        return round(cy / aspect), cy

    def describe(self, cx: int, cy: int) -> dict:
        return {
            "source": self.path.name,
            "extension": self.extension,
            "content_type": self.content_type,
            "pixels": [self.width_px, self.height_px],
            "dpi": [round(self.dpi_x, 2), round(self.dpi_y, 2)],
            # Said out loud because it changes the answer: an image with no density
            # is sized from an assumption, and the caller may want to override it.
            "density": "read from the file" if self.density_measured else
                       f"not stated by the file — assumed {DEFAULT_DPI:g} dpi",
            "emu": {"cx": cx, "cy": cy},
            "cm": [round(cx / EMU_PER_CM, 2), round(cy / EMU_PER_CM, 2)],
        }
