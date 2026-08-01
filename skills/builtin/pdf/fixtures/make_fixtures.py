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


def main() -> int:
    build_report(HERE / "report-cjk.pdf")
    build_locked(HERE / "locked.pdf", LOCKED_USER_PW, LOCKED_OWNER_PW)
    for name in ("report-cjk.pdf", "locked.pdf"):
        p = HERE / name
        print(f"{name}: {p.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
