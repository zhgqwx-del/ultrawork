#!/usr/bin/env python3
"""Regenerate the fixture PDFs next to this file.

    python3 make_fixtures.py

The fixtures are committed so the capability samples and scripts/test-pdf-skill.py
have something to run against without a corpus download; this script is here so
they can be rebuilt and inspected rather than being opaque blobs. They are
synthesized from nothing — no third-party document is copied in.

They are deliberately NOT a stand-in for real-world PDFs. Producer quirks, broken
tables, scanned pages and hand-rolled encodings are what L3 (059 §5) is for; these
only have to be legal, small, and to carry the specific properties the assertions
are about (CJK text, mixed page sizes, a rotated page, an encrypted file).
"""
from __future__ import annotations

import sys
import json
from pathlib import Path

import fitz

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
META = {"title": TITLE, "author": "ultrawork", "subject": "pdf skill fixture",
        "keywords": "fixture,cjk", "creator": "make_fixtures.py",
        "producer": "PyMuPDF", "creationDate": FIXED_DATE, "modDate": FIXED_DATE}


def cjk(page, point, text, size=14):
    page.insert_text(point, text, fontname="china-s", fontsize=size)


def build_report(path: Path) -> None:
    doc = fitz.open()

    page = doc.new_page(width=595, height=842)              # A4 portrait
    cjk(page, (60, 90), TITLE, size=22)
    page.insert_text((60, 120), SUBTITLE, fontname="helv", fontsize=11)
    page.insert_textbox(fitz.Rect(60, 150, 535, 260), BODY,
                        fontname="china-s", fontsize=12, lineheight=1.6)

    page = doc.new_page(width=595, height=842)              # A4 portrait, a table
    cjk(page, (60, 90), "主要财务指标（单位：万元）", size=16)
    top, row_h, cols = 120, 28, (60, 250, 400, 535)
    for r, row in enumerate(TABLE):
        y = top + r * row_h
        page.draw_line(fitz.Point(cols[0], y), fitz.Point(cols[-1], y),
                       color=(0.6, 0.6, 0.6), width=0.6)
        for c, cell in enumerate(row):
            cjk(page, (cols[c] + 6, y + 19), cell, size=12)
    page.draw_line(fitz.Point(cols[0], top + len(TABLE) * row_h),
                   fitz.Point(cols[-1], top + len(TABLE) * row_h),
                   color=(0.6, 0.6, 0.6), width=0.6)

    page = doc.new_page(width=842, height=595)              # A4 landscape
    cjk(page, (60, 90), CLOSING, size=15)
    page.draw_rect(fitz.Rect(60, 120, 782, 480), color=(0.2, 0.4, 0.8), width=1)
    page.set_rotation(90)

    doc.set_metadata(META)
    # no_new_id keeps the /ID from being regenerated, which is what makes the bytes
    # reproducible. Without it every run produces a different file: the fixtures are
    # committed AND feed skills/builtin/.builtin-version, so a regeneration would
    # dirty git and make every desktop client reinstall its builtin skills for no
    # reason. Fixed dates in META are the other half.
    doc.save(str(path), garbage=4, deflate=True, no_new_id=True)
    doc.close()


def build_locked(path: Path, user_pw: str, owner_pw: str) -> None:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    cjk(page, (60, 100), "受保护的示例文档", size=18)
    page.insert_text((60, 130), "This fixture is encrypted with a user password.",
                     fontname="helv", fontsize=11)
    doc.set_metadata(META | {"title": "受保护的示例文档"})
    # Not reliably reproducible, unlike report-cjk.pdf: measured over repeated runs
    # the bytes sometimes repeat and sometimes do not (AES-256 key/salt generation is
    # not derived from anything we pass in). Treat it as varying — regenerating this
    # file changes skills/builtin/.builtin-version, so only do it when the fixture
    # itself must change.
    doc.save(str(path), encryption=fitz.PDF_ENCRYPT_AES_256, no_new_id=True,
             user_pw=user_pw, owner_pw=owner_pw, permissions=int(
                 fitz.PDF_PERM_ACCESSIBILITY | fitz.PDF_PERM_PRINT))
    doc.close()


LOCKED_USER_PW = "ultrawork"
LOCKED_OWNER_PW = "ultrawork-owner"

# The same paper form twice: once with real AcroForm widgets, once as flat ink.
# The pair is the point — "fill this form" has to work both ways, and the flat one
# is what a scanned or exported form actually looks like.
FORM_ROWS = [("姓名", "applicant", 150), ("证件号", "id_no", 170),
             ("部门", "dept", 150), ("备注", "remark", 300)]
DEPTS = ["财务部", "技术部", "市场部"]


def _form_chrome(page):
    """The printed part of the form: title, labels, rules. Identical in both files."""
    cjk(page, (50, 70), "员工信息登记表", size=18)
    page.insert_text((50, 92), "Employee Registration Form", fontname="helv", fontsize=9)
    for i, (label, _, _) in enumerate(FORM_ROWS):
        y = 130 + i * 42
        cjk(page, (50, y + 13), f"{label}：", size=11)
        page.draw_line(fitz.Point(120, y + 18), fitz.Point(430, y + 18),
                       color=(0.55, 0.55, 0.55), width=0.5)
    y = 130 + len(FORM_ROWS) * 42
    cjk(page, (50, y + 13), "本人确认以上信息属实", size=11)
    return y


def build_form_acroform(path: Path) -> None:
    doc = fitz.open()
    page = doc.new_page(width=480, height=400)
    consent_y = _form_chrome(page)

    def widget(**kw):
        w = fitz.Widget()
        for k, v in kw.items():
            setattr(w, k, v)
        return page.add_widget(w)

    for i, (_, name, width) in enumerate(FORM_ROWS):
        y = 130 + i * 42
        rect = fitz.Rect(122, y, 122 + width, y + 17)
        if name == "dept":
            widget(field_name=name, field_type=fitz.PDF_WIDGET_TYPE_COMBOBOX,
                   rect=rect, choice_values=DEPTS, field_value=DEPTS[1],
                   text_fontsize=10)
        elif name == "remark":
            widget(field_name=name, field_type=fitz.PDF_WIDGET_TYPE_TEXT,
                   rect=fitz.Rect(122, y, 422, y + 34), field_flags=1 << 12,
                   text_fontsize=10)
        elif name == "id_no":
            # A max length the filler is expected to respect.
            widget(field_name=name, field_type=fitz.PDF_WIDGET_TYPE_TEXT, rect=rect,
                   text_maxlen=18, text_fontsize=10)
        else:
            # Required, so the inspect output has a non-trivial flag to report.
            widget(field_name=name, field_type=fitz.PDF_WIDGET_TYPE_TEXT, rect=rect,
                   field_flags=1 << 1, text_fontsize=10)
    widget(field_name="agree", field_type=fitz.PDF_WIDGET_TYPE_CHECKBOX,
           rect=fitz.Rect(190, consent_y, 204, consent_y + 14))

    # No radio group on purpose: PyMuPDF 1.27 raises "bad xref" when a second
    # widget joins an existing radio field, so a radio fixture here would be
    # testing a broken construction rather than the skill. Reading radio fields
    # out of a third-party form still works and the model maps the type.
    doc.set_metadata(META | {"title": "员工信息登记表（AcroForm）"})
    doc.save(str(path), garbage=4, deflate=True, no_new_id=True)
    doc.close()


FILLED_VALUES = {"applicant": "张国强", "id_no": "110101199001011234",
                 "dept": "技术部", "remark": "入职材料齐全", "agree": True}


def build_form_filled(src: Path, path: Path) -> None:
    """An already-filled form for the check/proof samples to run against.

    Filled here with plain PyMuPDF rather than by calling pdf_form_fill.py: if the
    filler produced its own test input, "the checker accepts it" would only mean the
    two scripts agree with each other.

    Every value fits on purpose. Detecting an overflow is asserted in
    scripts/test-pdf-skill.py, which builds the overflowing case itself — a fixture
    that is deliberately broken could not also be handed to the L2 artifact gate.
    """
    doc = fitz.open(src)
    for page in doc:
        for widget in page.widgets() or []:
            if widget.field_name not in FILLED_VALUES:
                continue
            widget.field_value = FILLED_VALUES[widget.field_name]
            widget.update()
    doc.set_metadata(META | {"title": "员工信息登记表（已填写）"})
    doc.save(str(path), garbage=4, deflate=True, no_new_id=True)
    doc.close()


def build_form_flat(path: Path) -> None:
    """The same form with zero widgets — the overlay path's subject."""
    doc = fitz.open()
    page = doc.new_page(width=480, height=400)
    _form_chrome(page)
    doc.set_metadata(META | {"title": "员工信息登记表（无表单域）"})
    doc.save(str(path), garbage=4, deflate=True, no_new_id=True)
    doc.close()


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


def write_inputs() -> None:
    """The values files the capability samples feed to pdf_form_fill.py.

    Committed next to the fixtures they belong to, so a sample is one command with
    no here-doc, and so the anchor/offset numbers live where the form they point
    into lives.
    """
    (HERE / "values-acroform.json").write_text(
        json.dumps(FILLED_VALUES, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    placements = {"placements": [
        {"name": "applicant", "text": "张国强", "anchor": "姓名：",
         "offset": [8, 2], "width": 150},
        {"name": "id_no", "text": "110101199001011234", "anchor": "证件号：",
         "offset": [8, 2], "width": 170, "size": 9},
        {"name": "remark", "text": "入职材料齐全", "page": 1,
         "rect": [122, 256, 422, 274]}]}
    (HERE / "document.json").write_text(
        json.dumps(DOCUMENT_SPEC, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (HERE / "placements-flat.json").write_text(
        json.dumps(placements, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    build_report(HERE / "report-cjk.pdf")
    build_locked(HERE / "locked.pdf", LOCKED_USER_PW, LOCKED_OWNER_PW)
    build_form_acroform(HERE / "form-acroform.pdf")
    build_form_filled(HERE / "form-acroform.pdf", HERE / "form-filled.pdf")
    build_form_flat(HERE / "form-flat.pdf")
    write_inputs()
    for name in ("report-cjk.pdf", "locked.pdf", "form-acroform.pdf",
                 "form-filled.pdf", "form-flat.pdf"):
        p = HERE / name
        print(f"{name}: {p.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
