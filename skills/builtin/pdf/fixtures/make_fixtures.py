#!/usr/bin/env python3
"""Regenerate the fixture PDFs next to this file.

    python3 make_fixtures.py
    python3 make_fixtures.py --out-dir /tmp/fixtures     # inspect without committing

The fixtures are committed so the capability samples and scripts/test-pdf-skill.py
have something to run against without a corpus download; this script is here so
they can be rebuilt and inspected rather than being opaque blobs. They are
synthesized from nothing — no third-party document is copied in.

They are deliberately NOT a stand-in for real-world PDFs. Producer quirks, broken
tables, scanned pages and hand-rolled encodings are what L3 (059 §5) is for; these
only have to be legal, small, and to carry the specific properties the assertions
are about (CJK text, mixed page sizes, a rotated page, an encrypted file).

⚠️ REBUILT IS NOT BYTE-IDENTICAL TO WHAT IS COMMITTED. The fixtures in git were
written by PyMuPDF; this script now uses reportlab and pypdf, because PyMuPDF is
AGPL-3.0-or-commercial and this tree ships inside a product (059 §5·补.8c). The
same properties come out — page count, sizes, the rotated page, the field model,
AES-256 — but not the same bytes, and `--out-dir` exists so that can be checked
without dirtying the committed set. Regenerating in place changes
skills/builtin/.builtin-version and makes every desktop client reinstall its
builtin skills, so only do it when a fixture must actually change.

The form family is built here WITHOUT importing the skill's own pdfform.py, and
the filled form is laid out by a different rule than the filler uses (bottom
anchored rather than centred). If the fixture came out of the code under test,
"the checker accepts the filled form" would only mean the two agree with each
other.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
                           DictionaryObject, FloatObject, NameObject, NumberObject,
                           RectangleObject, TextStringObject)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent

TITLE = "季度经营分析报告"
SUBTITLE = "Quarterly Business Review — ultrawork sample fixture"
BODY = ("本季度营业收入同比增长 12.4%，毛利率保持在 38% 以上；"
        "费用结构持续优化，销售费用率下降 1.8 个百分点。")
TABLE = [("科目", "本季度", "上年同期"),
         ("营业收入", "1,240", "1,103"),
         ("营业成本", "769", "702"),
         ("毛利", "471", "401")]
CLOSING = "第三页为横向版面，用于验证页面尺寸与旋转角度的读取。"

FIXED_DATE = "D:20260801000000Z"
META = {"/Title": TITLE, "/Author": "ultrawork", "/Subject": "pdf skill fixture",
        "/Keywords": "fixture,cjk", "/Creator": "make_fixtures.py",
        "/Producer": "reportlab + pypdf", "/CreationDate": FIXED_DATE,
        "/ModDate": FIXED_DATE}
# Fixed so two runs of this script produce the same bytes. pypdf otherwise derives
# /ID from the current time, and every regeneration would dirty git for no reason.
FIXED_ID = b"ultrawork-pdf-fx"

CJK_CANDIDATES = [
    ("/System/Library/Fonts/Supplemental/Songti.ttc", 0),
    ("/Library/Fonts/Arial Unicode.ttf", None),
    ("/System/Library/Fonts/Supplemental/Songti.ttc", 1),
    (r"C:\Windows\Fonts\msyh.ttc", 0),
    (r"C:\Windows\Fonts\simsun.ttc", 0),
    ("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf", None),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
]
CJK = "fixture-cjk"


def register_cjk() -> str:
    """Find a CJK face and register it, or say which paths were tried and failed.

    Candidates are TRIED, not merely located: the first CJK font on a Mac has
    PostScript outlines and reportlab refuses to embed it, so a search that stopped
    at the first existing path would fail on the commonest machine there is.
    """
    for path, index in CJK_CANDIDATES:
        if not Path(path).is_file():
            continue
        try:
            pdfmetrics.registerFont(TTFont(CJK, path) if index is None else
                                    TTFont(CJK, path, subfontIndex=index))
        except Exception:  # noqa: BLE001 - CFF outlines, unreadable file, …
            continue
        return path
    raise SystemExit(
        "no embeddable CJK font found; the fixtures are Chinese and cannot be built "
        "without one. Tried:\n  " + "\n  ".join(p for p, _ in CJK_CANDIDATES))


def new_canvas(buf, width: float, height: float) -> canvas.Canvas:
    # invariant=1 fixes reportlab's own dates and document id, which is the other
    # half of reproducible bytes.
    return canvas.Canvas(buf, pagesize=(width, height), initialFontName=CJK,
                         initialFontSize=11, invariant=1)


def text(c: canvas.Canvas, height: float, x: float, y: float, s: str,
         size: float = 14, font: str = CJK) -> None:
    """Draw `s` with its BASELINE at (x, y) in top-left coordinates."""
    c.setFont(font, size)
    c.setFillColorRGB(0, 0, 0)
    c.drawString(x, height - y, s)


def line(c: canvas.Canvas, height: float, x0: float, y0: float, x1: float,
         y1: float, color, width: float) -> None:
    c.setStrokeColorRGB(*color)
    c.setLineWidth(width)
    c.line(x0, height - y0, x1, height - y1)


def wrap(s: str, font: str, size: float, width: float) -> list[str]:
    """Break between CJK characters and at Latin spaces, to fit `width`."""
    out, line_text = [], ""
    tokens, buf = [], ""
    for ch in s:
        if ord(ch) > 0x2E7F:                      # CJK and its punctuation
            if buf:
                tokens.append(buf)
                buf = ""
            tokens.append(ch)
        elif ch == " ":
            tokens.append(buf + ch)
            buf = ""
        else:
            buf += ch
    if buf:
        tokens.append(buf)
    for token in tokens:
        candidate = line_text + token
        if line_text and pdfmetrics.stringWidth(candidate.rstrip(), font, size) > width:
            out.append(line_text.rstrip())
            line_text = token.lstrip(" ")
        else:
            line_text = candidate
    if line_text:
        out.append(line_text.rstrip())
    return out


def finish(buf: io.BytesIO, path: Path, title: str | None = None,
           encrypt: dict | None = None, page_boxes: dict | None = None) -> None:
    """Add metadata (and optionally encryption) with pypdf, then write the file.

    `page_boxes` overrides a page's /MediaBox, because reportlab's setPageSize only
    takes on the FIRST page — every later page inherits the document's box no matter
    what it is told (measured: a canvas asked for 842x595 on page 3 writes 595x842).
    Content stream coordinates are absolute, so correcting the box afterwards puts
    the drawing exactly where it was drawn.
    """
    buf.seek(0)
    writer = PdfWriter(clone_from=PdfReader(buf))
    for index, box in (page_boxes or {}).items():
        writer.pages[index].mediabox = RectangleObject(list(box))
    writer.add_metadata(META | ({"/Title": title} if title else {}))
    if encrypt:
        writer.encrypt(**encrypt)
    writer._ID = ArrayObject([TextStringObject(FIXED_ID.decode()),
                              TextStringObject(FIXED_ID.decode())])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        writer.write(fh)


def build_report(path: Path) -> None:
    buf = io.BytesIO()
    w, h = 595, 842
    c = new_canvas(buf, w, h)                               # A4 portrait

    text(c, h, 60, 90, TITLE, size=22)
    text(c, h, 60, 120, SUBTITLE, size=11, font="Helvetica")
    for i, ln in enumerate(wrap(BODY, CJK, 12, 535 - 60)):
        text(c, h, 60, 150 + 12 + i * 12 * 1.6, ln, size=12)
    c.showPage()

    text(c, h, 60, 90, "主要财务指标（单位：万元）", size=16)   # A4 portrait, a table
    top, row_h, cols = 120, 28, (60, 250, 400, 535)
    for r, row in enumerate(TABLE):
        y = top + r * row_h
        line(c, h, cols[0], y, cols[-1], y, (0.6, 0.6, 0.6), 0.6)
        for col, cell in enumerate(row):
            text(c, h, cols[col] + 6, y + 19, cell, size=12)
    bottom = top + len(TABLE) * row_h
    line(c, h, cols[0], bottom, cols[-1], bottom, (0.6, 0.6, 0.6), 0.6)
    c.showPage()

    w, h = 842, 595                                          # A4 landscape, rotated
    c.setPageSize((w, h))
    text(c, h, 60, 90, CLOSING, size=15)
    c.setStrokeColorRGB(0.2, 0.4, 0.8)
    c.setLineWidth(1)
    c.rect(60, h - 480, 782 - 60, 480 - 120, stroke=1, fill=0)
    # The point of the page: /Rotate makes the displayed frame differ from the
    # mediabox, which is the only place a page-space/display-space mix-up shows.
    c.setPageRotation(90)
    c.showPage()
    c.save()
    finish(buf, path, page_boxes={2: (0, 0, w, h)})


LOCKED_USER_PW = "ultrawork"
LOCKED_OWNER_PW = "ultrawork-owner"


def build_locked(path: Path, user_pw: str, owner_pw: str) -> None:
    from pypdf.constants import UserAccessPermissions as Perm

    buf = io.BytesIO()
    w, h = 595, 842
    c = new_canvas(buf, w, h)
    text(c, h, 60, 100, "受保护的示例文档", size=18)
    text(c, h, 60, 130, "This fixture is encrypted with a user password.", size=11,
         font="Helvetica")
    c.showPage()
    c.save()
    # AES-256 with print and accessibility allowed and everything else denied: the
    # permission bits have to be a mixture, or "the bits were read" and "the bits
    # were all defaulted" look the same.
    #
    # ⚠️ The ONE fixture that is not byte-reproducible, measured: two runs of this
    # script produce identical bytes for the other five and different bytes for this
    # one, because AES-256 salts are drawn fresh and nothing here can pin them.
    # Regenerating it therefore always changes skills/builtin/.builtin-version.
    finish(buf, path, title="受保护的示例文档", encrypt={
        "user_password": user_pw, "owner_password": owner_pw,
        "permissions_flag": Perm.PRINT | Perm.EXTRACT_TEXT_AND_GRAPHICS,
        "algorithm": "AES-256"})


# The same paper form twice: once with real AcroForm widgets, once as flat ink.
# The pair is the point — "fill this form" has to work both ways, and the flat one
# is what a scanned or exported form actually looks like.
FORM_ROWS = [("姓名", "applicant", 150), ("证件号", "id_no", 170),
             ("部门", "dept", 150), ("备注", "remark", 300)]
DEPTS = ["财务部", "技术部", "市场部"]
FORM_W, FORM_H = 480, 400


def _form_chrome(c: canvas.Canvas) -> float:
    """The printed part of the form: title, labels, rules. Identical in both files."""
    h = FORM_H
    text(c, h, 50, 70, "员工信息登记表", size=18)
    text(c, h, 50, 92, "Employee Registration Form", size=9, font="Helvetica")
    for i, (label, _, _) in enumerate(FORM_ROWS):
        y = 130 + i * 42
        text(c, h, 50, y + 13, f"{label}：", size=11)
        line(c, h, 120, y + 18, 430, y + 18, (0.55, 0.55, 0.55), 0.5)
    y = 130 + len(FORM_ROWS) * 42
    text(c, h, 50, y + 13, "本人确认以上信息属实", size=11)
    return y


# Widget geometry, in PDF coordinates (bottom-left origin) because that is what a
# /Rect is. Kept as one table so the flat form, the widgets and the filled
# appearances cannot drift apart.
def widget_rects() -> dict:
    rects = {}
    for i, (_, name, width) in enumerate(FORM_ROWS):
        y = 130 + i * 42
        height = 34 if name == "remark" else 17
        w = 300 if name == "remark" else width
        rects[name] = (122, FORM_H - (y + height), 122 + w, FORM_H - y)
    consent_y = 130 + len(FORM_ROWS) * 42
    rects["agree"] = (190, FORM_H - (consent_y + 14), 204, FORM_H - consent_y)
    return rects


FLAGS = {"applicant": 1 << 1, "remark": 1 << 12}       # required, multiline
DA = "0 0 0 rg /Helv 10 Tf"
CHECK_DA = "0 0 0 rg /Helv 0 Tf"


def _stream(writer, data: bytes, box, resources=None):
    xo = DecodedStreamObject()
    xo.set_data(data)
    xo[NameObject("/Type")] = NameObject("/XObject")
    xo[NameObject("/Subtype")] = NameObject("/Form")
    xo[NameObject("/BBox")] = ArrayObject([FloatObject(v) for v in box])
    xo[NameObject("/Resources")] = resources if resources is not None else DictionaryObject()
    return writer._add_object(xo)


def _appearance(writer, rect, value: str, size: float):
    """A filled text appearance, anchored 4pt above the box bottom.

    Deliberately NOT the rule pdf_form_fill.py uses (which centres a single line and
    top-aligns a multiline one). This fixture is the checker's independent subject;
    if it were laid out by the code under test, "the values fit" would be a
    statement about one implementation agreeing with itself.
    """
    if not value:
        return None
    w, h = rect[2] - rect[0], rect[3] - rect[1]
    buf = io.BytesIO()
    c = new_canvas(buf, w, h)
    font = CJK if any(ord(ch) > 0x2E7F for ch in value) else "Helvetica"
    c.setFont(font, size)
    c.setFillColorRGB(0, 0, 0)
    c.drawString(4, 4, value)
    c.showPage()
    c.save()
    buf.seek(0)
    page = PdfReader(buf).pages[0]
    return _stream(writer, page.get_contents().get_object().get_data(), (0, 0, w, h),
                   page["/Resources"].clone(writer))


def _empty_appearance(writer, rect):
    return _stream(writer, b"", (0, 0, rect[2] - rect[0], rect[3] - rect[1]))


def _checkbox_appearances(writer, rect):
    """/Off and /Yes, so a filler only has to point /AS at the right one."""
    w, h = rect[2] - rect[0], rect[3] - rect[1]
    states = DictionaryObject()
    states[NameObject("/Off")] = _stream(writer, b"", (0, 0, w, h))
    tick = (f"q 0 0 0 RG 1.2 w {0.2 * w} {0.55 * h} m {0.45 * w} {0.22 * h} l "
            f"{0.85 * w} {0.8 * h} l S Q").encode()
    states[NameObject("/Yes")] = _stream(writer, tick, (0, 0, w, h))
    return states


def build_form(path: Path, with_widgets: bool, values: dict | None = None,
               title: str = "员工信息登记表") -> None:
    buf = io.BytesIO()
    c = new_canvas(buf, FORM_W, FORM_H)
    _form_chrome(c)
    c.showPage()
    c.save()
    if not with_widgets:
        finish(buf, path, title=title)
        return

    buf.seek(0)
    writer = PdfWriter(clone_from=PdfReader(buf))
    page = writer.pages[0]
    rects = widget_rects()
    values = values or {}
    fields = ArrayObject()
    for name in [n for _, n, _ in FORM_ROWS] + ["agree"]:
        rect = rects[name]
        annot = DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/T"): TextStringObject(name),
            NameObject("/F"): NumberObject(4),          # print
            NameObject("/Rect"): ArrayObject([FloatObject(v) for v in rect]),
        })
        if name == "agree":
            on = "/Yes" if values.get(name) else "/Off"
            annot[NameObject("/FT")] = NameObject("/Btn")
            annot[NameObject("/DA")] = TextStringObject(CHECK_DA)
            annot[NameObject("/AS")] = NameObject(on)
            annot[NameObject("/V")] = NameObject(on)
            ap = DictionaryObject()
            ap[NameObject("/N")] = _checkbox_appearances(writer, rect)
            annot[NameObject("/AP")] = ap
        else:
            value = str(values.get(name, "")) if name != "dept" else \
                str(values.get(name, DEPTS[1]))
            annot[NameObject("/DA")] = TextStringObject(DA)
            if name == "dept":
                annot[NameObject("/FT")] = NameObject("/Ch")
                annot[NameObject("/Ff")] = NumberObject(1 << 17)   # combo
                annot[NameObject("/Opt")] = ArrayObject(
                    [TextStringObject(d) for d in DEPTS])
            else:
                annot[NameObject("/FT")] = NameObject("/Tx")
                if FLAGS.get(name):
                    annot[NameObject("/Ff")] = NumberObject(FLAGS[name])
                if name == "id_no":
                    # A max length the filler is expected to respect.
                    annot[NameObject("/MaxLen")] = NumberObject(18)
            if value:
                annot[NameObject("/V")] = TextStringObject(value)
            ap = DictionaryObject()
            ap[NameObject("/N")] = (_appearance(writer, rect, value, 10) if value
                                    else _empty_appearance(writer, rect))
            annot[NameObject("/AP")] = ap
        ref = writer._add_object(annot)
        fields.append(ref)
        page.setdefault(NameObject("/Annots"), ArrayObject()).append(ref)

    # No radio group on purpose: a radio field needs several widgets sharing one
    # parent, and a fixture whose only radio is hand-built here would be testing
    # this file's construction rather than the skill. Reading radio fields out of a
    # third-party form still works and the model maps the type.
    writer._root_object[NameObject("/AcroForm")] = writer._add_object(DictionaryObject({
        NameObject("/Fields"): fields,
        NameObject("/DA"): TextStringObject(DA),
        # NeedAppearances stays false: the appearances above are real, and a viewer
        # that regenerated them would redraw the Chinese with Helvetica.
        NameObject("/NeedAppearances"): BooleanObject(False),
    }))
    writer.add_metadata(META | {"/Title": title})
    writer._ID = ArrayObject([TextStringObject(FIXED_ID.decode()),
                              TextStringObject(FIXED_ID.decode())])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        writer.write(fh)


FILLED_VALUES = {"applicant": "张国强", "id_no": "110101199001011234",
                 "dept": "技术部", "remark": "入职材料齐全", "agree": True}


def build_table_grid(path: Path) -> None:
    """Two pages of the SAME table: one fully ruled, one with no rules at all.

    The pair is the point. A line-based table reader takes a drawn grid as fact and
    finds nothing without one; the text strategy infers columns from where words
    line up and is a guess. A fixture with only one of the two cases would let that
    difference stay invisible.
    ⚠️ The horizontal-rules-only case is table-rules.pdf, not this file: report-cjk.pdf
    has such a table but no prose beside it, and the prose is what makes the case
    hard (2026-08-15).
    """
    w, h = 560, 320
    cols_x = [60, 220, 360, 500]
    top, row_h = 120, 30
    buf = io.BytesIO()
    c = new_canvas(buf, w, h)

    def cells(ruled: bool) -> None:
        text(c, h, 60, 90, "主要财务指标（单位：万元）", size=15)
        for r, row in enumerate(TABLE):
            y = top + r * row_h
            for col, cell in enumerate(row):
                text(c, h, cols_x[col] + 8, y + 20, cell, size=11)
        if not ruled:
            return
        bottom = top + len(TABLE) * row_h
        for r in range(len(TABLE) + 1):
            y = top + r * row_h
            line(c, h, cols_x[0], y, cols_x[-1], y, (0.35, 0.35, 0.35), 0.8)
        for x in cols_x:
            line(c, h, x, top, x, bottom, (0.35, 0.35, 0.35), 0.8)

    cells(ruled=True)
    c.showPage()
    cells(ruled=False)
    c.showPage()
    c.save()
    finish(buf, path, title="表格检测样例")


RULES_TABLE = [("业务分部", "本季度收入", "上年同期", "同比", "收入占比"),
               ("软件授权", "593.5", "548.2", "+8.3%", "46.2%"),
               ("订阅服务", "283.9", "204.7", "+38.7%", "22.1%"),
               ("技术服务", "246.8", "219.4", "+12.5%", "19.2%"),
               ("合计", "1,124.2", "972.3", "+15.6%", "100.0%")]
RULES_PROSE = [
    "软件授权收入仍是第一大来源，订阅制收入同比增长明显，是本季度增长的主要来源，",
    "硬件配套收入受供应链影响同比下降，公司已在四季度启动供应商多元化的替代方案。",
]


def build_table_rules(path: Path) -> None:
    """A table ruled HORIZONTALLY ONLY, wrapped in prose that is wider than it is.

    The commonest Chinese business table, and the case that broke: a line reader
    needs verticals and finds nothing, so a text reader runs over the whole page —
    where the prose has no vertical gutters — and sweeps the lot into one column.
    Measured on the real report this came from: a 65x1 "table" whose first cell was
    the document title, exported as a CSV.

    Two properties of this fixture are load-bearing and neither is decoration:
      * the rules must be WIDER than the table's own text (x 52~400 against text
        ending at 390) — a real rule spans the table, and pdfplumber cannot bound a
        region whose text pokes out past the line ends;
      * the prose must be wider still (x to 436), because that is what stops the
        columns from being findable page-wide, and also what lets the header be
        told apart from the paragraph above it;
      * the header sits ABOVE the topmost rule, because that is where a banded table
        puts it — a region derived from the rules alone starts at the first DATA row.
    """
    w, h = 560, 460
    cols_x = [56, 150, 240, 300, 350]
    top, row_h = 150, 26
    buf = io.BytesIO()
    c = new_canvas(buf, w, h)
    text(c, h, 56, 60, "示例科技 2026 年第三季度收入结构", size=15)
    for i, para in enumerate(RULES_PROSE):
        text(c, h, 56, 92 + i * 18, para, size=10)
    for r, row in enumerate(RULES_TABLE):
        y = top + r * row_h
        for col, cell in enumerate(row):
            text(c, h, cols_x[col], y, cell, size=10)
        # The rule goes UNDER the row, so the header has none above it.
        line(c, h, 52, y + 7, 400, y + 7, (0.4, 0.4, 0.4), 0.7)
    text(c, h, 56, top + len(RULES_TABLE) * row_h + 34,
         "上表数据经财务部复核，口径与去年同期一致，未包含尚未确认的递延收入部分。", size=10)
    c.showPage()
    # Page two: prose and no table at all. It is not padding — it is the other half
    # of the defect. A text pass over a page like this returns ONE column holding the
    # whole page, and that came out of the door as a CSV whose first cell was the
    # document title. Without this page nothing here would exercise the rule that a
    # one-column result is not a table.
    text(c, h, 56, 60, "四季度展望", size=15)
    for i, para in enumerate(RULES_PROSE + RULES_PROSE):
        text(c, h, 56, 92 + i * 18, para, size=10)
    c.showPage()
    c.save()
    finish(buf, path, title="横线表检测样例")


# The generation spec. Deliberately exercises every block type plus an explicit
# page break, and carries enough text that the wrapper has to break both CJK runs
# and Latin words on the same line.
DOCUMENT_SPEC = {
    "page": {"size": "A4", "orientation": "portrait", "margin": 56},
    "font_size": 11,
    "blocks": [
        {"type": "heading", "text": TITLE, "level": 1},
        {"type": "paragraph", "text": BODY + " This sentence is Latin, so the line "
                                             "breaker has to apply both rules at once."},
        {"type": "heading", "text": "主要指标", "level": 2},
        {"type": "bullets", "items": ["营业收入 1,240 万元", "毛利率 38.0%",
                                      "经营性现金流净额 210 万元"]},
        {"type": "table", "header": list(TABLE[0]),
         "rows": [list(r) for r in TABLE[1:]]},
        {"type": "spacer", "height": 10},
        {"type": "pagebreak"},
        {"type": "heading", "text": "附注", "level": 2},
        {"type": "paragraph", "text": "第二页用于验证自动分页、页边距与字体子集化。"},
    ],
}


def write_inputs(out: Path) -> None:
    """The values files the capability samples feed to pdf_form_fill.py.

    Committed next to the fixtures they belong to, so a sample is one command with
    no here-doc, and so the anchor/offset numbers live where the form they point
    into lives.
    """
    (out / "values-acroform.json").write_text(
        json.dumps(FILLED_VALUES, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    placements = {"placements": [
        {"name": "applicant", "text": "张国强", "anchor": "姓名：",
         "offset": [8, 2], "width": 150},
        {"name": "id_no", "text": "110101199001011234", "anchor": "证件号：",
         "offset": [8, 2], "width": 170, "size": 9},
        {"name": "remark", "text": "入职材料齐全", "page": 1,
         "rect": [122, 256, 422, 274]}]}
    (out / "document.json").write_text(
        json.dumps(DOCUMENT_SPEC, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "placements-flat.json").write_text(
        json.dumps(placements, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", type=Path, default=HERE,
                    help="where to write (default: next to this script)")
    args = ap.parse_args()
    out = args.out_dir
    out.mkdir(parents=True, exist_ok=True)

    source = register_cjk()
    build_report(out / "report-cjk.pdf")
    build_locked(out / "locked.pdf", LOCKED_USER_PW, LOCKED_OWNER_PW)
    build_form(out / "form-acroform.pdf", with_widgets=True,
               title="员工信息登记表（AcroForm）")
    build_form(out / "form-filled.pdf", with_widgets=True, values=FILLED_VALUES,
               title="员工信息登记表（已填写）")
    build_form(out / "form-flat.pdf", with_widgets=False,
               title="员工信息登记表（无表单域）")
    build_table_grid(out / "table-grid.pdf")
    build_table_rules(out / "table-rules.pdf")
    write_inputs(out)
    print(f"CJK face: {source}")
    for name in ("report-cjk.pdf", "locked.pdf", "form-acroform.pdf",
                 "form-filled.pdf", "form-flat.pdf", "table-grid.pdf",
                 "table-rules.pdf"):
        print(f"{name}: {(out / name).stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
