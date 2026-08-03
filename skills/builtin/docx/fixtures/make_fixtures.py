#!/usr/bin/env python3
"""Build the docx skill's sample documents.

⚠️ These files are committed, and everything under `skills/builtin/` feeds the
`.builtin-version` hash — regenerating one reinstalls the built-in skills on every
desktop. **Do not run this unless the sample content itself needs to change.**

They are therefore built to be byte-reproducible, which takes three deliberate
choices: a fixed zip timestamp, a pinned compression level, and dates written into
`docProps/core.xml` as literals rather than "now". (The xlsx skill learned the third
one the hard way — openpyxl overwrites `dcterms:modified` with the save time even
when you set the property yourself. Here nothing but this file writes the package,
so the fix is simply not to call a clock.)

The document is hand-built rather than produced by python-docx, for three reasons
that are all measured or written down:

  * python-docx's bundled `default.docx` ships `<w:zoom w:val="bestFit"/>`, and
    ECMA-376 Transitional makes `w:percent` REQUIRED on `CT_Zoom` — so every
    document it produces fails XSD validation (059 §5·补.8d, found the first time
    that gate ever ran). A fixture that carries a known defect cannot be the
    positive control for a gate that hunts defects.
  * its template is ~800 KB of styles, effects and a thumbnail, which would
    dominate the built-in skills payload for content nobody reads.
  * the sample has to hold things python-docx has no model for at all — tracked
    revisions, comments, a field, a custom XML part — because those are exactly the
    things an editor is most likely to destroy.
"""
from __future__ import annotations

import argparse
import struct
import sys
import zipfile
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent

# 1980-01-01 00:00:00 is the earliest timestamp the zip format can store, and the
# conventional choice for a reproducible archive.
EPOCH = (1980, 1, 1, 0, 0, 0)
COMPRESS_LEVEL = 6

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"

DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

# The document's namespace declarations, written once so every part agrees.
W_NS = (f'xmlns:w="{W}" xmlns:r="{R}" xmlns:wp="{WP}" xmlns:a="{A}" xmlns:pic="{PIC}"')

# ── the text the assertions are built on ──────────────────────────────────────
TITLE = "二零二六年第三季度经营分析报告"
# Split across three runs on purpose. "第三季度" spans the first two. The same
# phrase also sits in TITLE inside a SINGLE run — both on purpose: a per-run search
# finds the title's copy and silently misses this one, which is why nobody notices
# that implementation is wrong (measured: 1 of 2).
SPLIT_RUNS = ("2026 年第", "三季度", "营业收入同比增长 12%，毛利率保持稳定。")
CROSS_RUN_PHRASE = "第三季度"
# A placeholder cut in half the same way, so template filling meets the same problem.
PLACEHOLDER_RUNS = ("客户：{{客户", "名称}}", "，签署日期：{{日期}}。")
LIST_ITEMS = ("费用结构持续优化，管理费用同比下降。", "经营性现金流保持健康水平，Q3 无异常。")
REVISION_KEPT = ("本季度", "同比增长。")
REVISION_INSERTED = "净利润"
# Deliberately a phrase that occurs NOWHERE else in the document. An
# earlier draft used "毛利", which is a substring of "毛利率保持稳定。"
# two paragraphs up — so "deleted text is never reported as document
# text" fired on a correct implementation and could not have failed on
# a wrong one.
REVISION_DELETED = "扣非净利"
COMMENT_ANCHOR = "待核对的应收账款余额"
COMMENT_TEXT = "请与银行流水核对后再定稿。"
HYPERLINK_TEXT = "季度报告存档"
HYPERLINK_URL = "https://example.invalid/reports/2026q3"
TABLE = (("项目", "本季", "同比"),
         ("营业收入", "1,240", "+12%"),
         ("毛利率", "38%", "+1.2pt"))
# Carries a placeholder too: a real template puts them in the letterhead as
# often as in the body, and a filler that only walks word/document.xml ships
# a contract whose header still says {{密级}}.
HEADER_TEXT = "内部资料 · 请勿外传 · 密级：{{密级}}"
IMAGE_ALT = "季度趋势图"

ASCII_FONT = "Calibri"
EA_FONT = "宋体"

# ── outline.docx ──────────────────────────────────────────────────────────────
# A second sample, for the layout capabilities. report.docx cannot serve them: it
# already HAS a header, a footer, an image and a png Default, so "create one" would
# be tested as "replace one" and the four-piece package work would never run. What
# this file deliberately does NOT have is the whole point of it:
#
#   * no word/header*.xml, no word/footer*.xml and no reference in `w:sectPr`
#   * no `<Default Extension="png">` and no word/media — inserting a picture has to
#     declare the content type, not find it already declared
#   * a real heading hierarchy (H1 > H2 > H3), because a table of contents built
#     from one heading level proves nothing about levels
OUTLINE_BLOCKS = (
    ("Heading1", "经营概况"),
    (None, "本季度整体经营情况良好，各项指标符合预期。"),
    ("Heading2", "收入分析"),
    (None, "营业收入同比增长，主要来自华东区域。"),
    ("Heading3", "分产品收入"),
    (None, "主营产品收入占比继续提升。"),
    ("Heading2", "成本与费用"),
    (None, "费用结构持续优化，管理费用同比下降。"),
    ("Heading1", "风险提示"),
    (None, "应收账款账龄需要持续关注。"),
)
OUTLINE_PARAGRAPHS = len(OUTLINE_BLOCKS)
OUTLINE_HEADINGS = tuple(t for s, t in OUTLINE_BLOCKS if s)

# ── fontless.docx ─────────────────────────────────────────────────────────────
# outline.docx with the East Asian font bindings taken away, in the three shapes a
# real document loses them in — and nothing else changed, so a repair can be
# attributed. It is an INPUT and never an artifact: it fails D6 on purpose.
#
# The three shapes do not have the same right answer, which is the whole reason the
# fixture has three of them rather than one repeated:
#
#   1. a run with no `w:rPr` at all, under a style that says nothing either, in a
#      document whose `w:docDefaults` say nothing → NOTHING in the file states the
#      face. Only here is falling back to a default honest.
#   2. a run with no `w:rPr`, under Heading2 — whose style DOES carry
#      `w:eastAsia="黑体"`. The document already says what this text should look
#      like. A repair that writes the fallback here has silently restyled it.
#   3. a run whose `w:rFonts` carries `@w:ascii` and no `@w:eastAsia`. The latin
#      face is a deliberate choice and must survive; only the missing half is filled.
FONTLESS_STYLE_EA = "黑体"
FONTLESS_STYLE_ASCII = "Cambria"
FONTLESS_KEPT_ASCII = "Times New Roman"      # shape 3: must survive the repair
FONTLESS_UNBOUND = OUTLINE_BLOCKS[0][1]      # shape 1, under Heading1
FONTLESS_INHERITS = OUTLINE_BLOCKS[2][1]     # shape 2, under Heading2
FONTLESS_HALF = OUTLINE_BLOCKS[1][1]         # shape 3, ordinary body text


def rpr(bold: bool = False, size_half: int | None = None,
        style: str | None = None) -> str:
    """Run properties in ECMA-376 order, always binding both font faces.

    Both `@w:ascii` and `@w:eastAsia` on every run, including Latin-only ones: a run
    that gains Chinese later should not silently become a document that renders in
    whatever face the reader's theme happens to pick.
    """
    parts = []
    if style:
        parts.append(f'<w:rStyle w:val="{style}"/>')
    parts.append(f'<w:rFonts w:ascii="{ASCII_FONT}" w:hAnsi="{ASCII_FONT}" '
                 f'w:eastAsia="{EA_FONT}" w:cs="{ASCII_FONT}"/>')
    if bold:
        parts.append("<w:b/><w:bCs/>")
    if size_half:
        parts.append(f'<w:sz w:val="{size_half}"/><w:szCs w:val="{size_half}"/>')
    return "<w:rPr>" + "".join(parts) + "</w:rPr>"


def run(text: str, *, bold: bool = False, size_half: int | None = None,
        style: str | None = None, tag: str = "t") -> str:
    space = ' xml:space="preserve"' if text != text.strip() else ""
    return (f"<w:r>{rpr(bold, size_half, style)}"
            f"<w:{tag}{space}>{text}</w:{tag}></w:r>")


def para(runs: str, *, style: str | None = None, num_id: int | None = None,
         align: str | None = None) -> str:
    ppr = ""
    if style or num_id is not None or align:
        inner = ""
        if style:
            inner += f'<w:pStyle w:val="{style}"/>'
        if num_id is not None:
            inner += f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{num_id}"/></w:numPr>'
        if align:
            inner += f'<w:jc w:val="{align}"/>'
        ppr = f"<w:pPr>{inner}</w:pPr>"
    return f"<w:p>{ppr}{runs}</w:p>"


def document_xml() -> str:
    blocks = [
        para(run(TITLE, bold=True, size_half=32), style="Heading1", align="center"),
        para("".join(run(t) for t in SPLIT_RUNS)),
        para("".join(run(t) for t in PLACEHOLDER_RUNS)),
    ]
    blocks += [para(run(t), num_id=1) for t in LIST_ITEMS]

    # A tracked insertion and a tracked deletion in one paragraph. `w:delText`, not
    # `w:t`: deleted text is a different element, and putting `w:t` inside `w:del` is
    # a defect the L2 gate has an assertion for.
    rev = (run(REVISION_KEPT[0])
           + f'<w:ins w:id="101" w:author="张审阅" w:date="2026-07-01T09:00:00Z">'
             f'{run(REVISION_INSERTED)}</w:ins>'
           + f'<w:del w:id="102" w:author="张审阅" w:date="2026-07-01T09:00:00Z">'
             f'{run(REVISION_DELETED, tag="delText")}</w:del>'
           + run(REVISION_KEPT[1]))
    blocks.append(para(rev))

    blocks.append("<w:p>"
                  '<w:commentRangeStart w:id="1"/>'
                  + run(COMMENT_ANCHOR)
                  + '<w:commentRangeEnd w:id="1"/>'
                  '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>'
                  '<w:commentReference w:id="1"/></w:r>'
                  "</w:p>")

    blocks.append(f'<w:p><w:hyperlink r:id="rId9">'
                  f'{run(HYPERLINK_TEXT, style="Hyperlink")}</w:hyperlink></w:p>')

    rows = []
    for i, cells in enumerate(TABLE):
        tcs = "".join(
            '<w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr>'
            + para(run(c, bold=(i == 0))) + "</w:tc>" for c in cells)
        rows.append(f"<w:tr>{tcs}</w:tr>")
    blocks.append(
        '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>'
        '<w:tblW w:w="7500" w:type="dxa"/>'
        '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" '
        'w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
        '<w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/>'
        '<w:gridCol w:w="2500"/></w:tblGrid>' + "".join(rows) + "</w:tbl>")

    blocks.append(
        "<w:p><w:r>" + rpr() + '<w:drawing><wp:inline distT="0" distB="0" distL="0" '
        'distR="0"><wp:extent cx="914400" cy="914400"/>'
        '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
        f'<wp:docPr id="1" name="Picture 1" descr="{IMAGE_ALT}"/>'
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/>'
        "</wp:cNvGraphicFramePr>"
        f'<a:graphic><a:graphicData uri="{PIC}">'
        '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/>'
        "<pic:cNvPicPr/></pic:nvPicPr>"
        '<pic:blipFill><a:blip r:embed="rId8"/><a:stretch><a:fillRect/></a:stretch>'
        "</pic:blipFill>"
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/>'
        '</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>")

    sect = ('<w:sectPr><w:headerReference w:type="default" r:id="rId5"/>'
            '<w:footerReference w:type="default" r:id="rId6"/>'
            '<w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
            'w:header="851" w:footer="992" w:gutter="0"/>'
            '<w:cols w:space="425"/>'
            '<w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr>')
    return (DECL + f"<w:document {W_NS}><w:body>" + "".join(blocks) + sect
            + "</w:body></w:document>")


def document_xml_unordered() -> str:
    """The same document with three ECMA-376 order violations, for `--fix-order`.

    This is an INPUT, never an artifact: it is the state a writer that appends
    elements in the order it thought of them leaves a document in. All three are
    real mistakes with real consequences, not decoration:

      * `<w:pPr>` after the run — the paragraph loses its style and alignment
      * `<w:rPr>` after the text — the run loses its font binding and size
      * `<w:sectPr>` before the last paragraph — Word discards the section, taking
        page size, margins and the header/footer bindings with it

    Built by moving substrings of the good document rather than by writing a second
    document, so the ONLY difference between the two files is the order. A separately
    authored "broken" file would differ in ways that make a fix impossible to
    attribute.
    """
    xml = document_xml()

    title_ppr = ('<w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr>')
    if title_ppr not in xml:
        raise SystemExit("the title's pPr is not what this mutation expects")
    title_run = run(TITLE, bold=True, size_half=32)
    xml = xml.replace(title_ppr + title_run, title_run + title_ppr, 1)

    first_split = run(SPLIT_RUNS[0])
    if first_split not in xml:
        raise SystemExit("the first split run is not what this mutation expects")
    xml = xml.replace(first_split,
                      f"<w:r><w:t>{SPLIT_RUNS[0]}</w:t>{rpr()}</w:r>", 1)

    start = xml.index("<w:sectPr>")
    sect = xml[start:xml.index("</w:sectPr>") + len("</w:sectPr>")]
    xml = xml.replace(sect, "", 1)
    last_p = xml.rindex("<w:p>")
    xml = xml[:last_p] + sect + xml[last_p:]
    return xml


def styles_xml() -> str:
    return (DECL + f"<w:styles {W_NS}>"
            "<w:docDefaults><w:rPrDefault><w:rPr>"
            f'<w:rFonts w:ascii="{ASCII_FONT}" w:hAnsi="{ASCII_FONT}" '
            f'w:eastAsia="{EA_FONT}" w:cs="{ASCII_FONT}"/>'
            '<w:sz w:val="21"/><w:szCs w:val="22"/>'
            "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>"
            '<w:spacing w:after="0" w:line="312" w:lineRule="auto"/>'
            "</w:pPr></w:pPrDefault></w:docDefaults>"
            '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
            '<w:name w:val="Normal"/><w:qFormat/></w:style>'
            '<w:style w:type="paragraph" w:styleId="Heading1">'
            '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
            '<w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>'
            '<w:pPr><w:spacing w:before="340" w:after="330"/>'
            '<w:outlineLvl w:val="0"/></w:pPr>'
            '<w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>'
            "</w:style>"
            '<w:style w:type="character" w:styleId="Hyperlink">'
            '<w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/>'
            '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
            '<w:style w:type="character" w:styleId="CommentReference">'
            '<w:name w:val="annotation reference"/><w:uiPriority w:val="99"/>'
            '<w:semiHidden/><w:unhideWhenUsed/>'
            '<w:rPr><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>'
            '<w:style w:type="paragraph" w:styleId="CommentText">'
            '<w:name w:val="annotation text"/><w:basedOn w:val="Normal"/>'
            '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>'
            '<w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>'
            '<w:style w:type="table" w:styleId="TableGrid">'
            '<w:name w:val="Table Grid"/><w:uiPriority w:val="39"/>'
            '<w:tblPr><w:tblBorders>'
            '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
            '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
            '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
            '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
            '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
            '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
            "</w:tblBorders></w:tblPr></w:style>"
            "</w:styles>")


def numbering_xml() -> str:
    return (DECL + f"<w:numbering {W_NS}>"
            '<w:abstractNum w:abstractNumId="0">'
            '<w:nsid w:val="12345678"/><w:multiLevelType w:val="hybridMultilevel"/>'
            '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>'
            '<w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>'
            '<w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:lvl>'
            "</w:abstractNum>"
            '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
            "</w:numbering>")


def settings_xml() -> str:
    # `w:percent` is REQUIRED on CT_Zoom in Transitional. python-docx's own template
    # omits it; this one does not, which is why it can serve as a positive control.
    return (DECL + f"<w:settings {W_NS}>"
            '<w:zoom w:percent="100"/>'
            '<w:defaultTabStop w:val="420"/>'
            "<w:compat/>"
            "</w:settings>")


def font_table_xml() -> str:
    return (DECL + f"<w:fonts {W_NS}>"
            f'<w:font w:name="{ASCII_FONT}"><w:family w:val="swiss"/>'
            '<w:pitch w:val="variable"/></w:font>'
            f'<w:font w:name="{EA_FONT}"><w:family w:val="auto"/>'
            '<w:pitch w:val="variable"/></w:font>'
            "</w:fonts>")


def header_xml() -> str:
    return DECL + f"<w:hdr {W_NS}>" + para(run(HEADER_TEXT), align="center") + "</w:hdr>"


def footer_xml() -> str:
    # A PAGE field: five runs that mean one number. Anything that rewrites runs
    # without understanding fields turns this into the literal text "1".
    field = ('<w:r>' + rpr() + '<w:fldChar w:fldCharType="begin"/></w:r>'
             '<w:r>' + rpr() + '<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
             '<w:r>' + rpr() + '<w:fldChar w:fldCharType="separate"/></w:r>'
             + run("1") +
             '<w:r>' + rpr() + '<w:fldChar w:fldCharType="end"/></w:r>')
    return DECL + f"<w:ftr {W_NS}>" + para(field, align="center") + "</w:ftr>"


def comments_xml() -> str:
    return (DECL + f"<w:comments {W_NS}>"
            '<w:comment w:id="1" w:author="李复核" w:date="2026-07-02T10:15:00Z" '
            'w:initials="L">'
            + para(run(COMMENT_TEXT), style="CommentText") +
            "</w:comment></w:comments>")


def content_types_xml() -> str:
    o = ('application/vnd.openxmlformats-officedocument.wordprocessingml.')
    return (DECL + f'<Types xmlns="{CT}">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-'
            'package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="png" ContentType="image/png"/>'
            f'<Override PartName="/word/document.xml" ContentType="{o}document.main+xml"/>'
            f'<Override PartName="/word/styles.xml" ContentType="{o}styles+xml"/>'
            f'<Override PartName="/word/numbering.xml" ContentType="{o}numbering+xml"/>'
            f'<Override PartName="/word/settings.xml" ContentType="{o}settings+xml"/>'
            f'<Override PartName="/word/fontTable.xml" ContentType="{o}fontTable+xml"/>'
            f'<Override PartName="/word/header1.xml" ContentType="{o}header+xml"/>'
            f'<Override PartName="/word/footer1.xml" ContentType="{o}footer+xml"/>'
            f'<Override PartName="/word/comments.xml" ContentType="{o}comments+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.'
            'openxmlformats-package.core-properties+xml"/>'
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.'
            'openxmlformats-officedocument.extended-properties+xml"/>'
            '<Override PartName="/customXml/itemProps1.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.customXmlProperties+xml"/>'
            "</Types>")


def package_rels_xml() -> str:
    t = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    return (DECL + f'<Relationships xmlns="{PR}">'
            f'<Relationship Id="rId1" Type="{t}/officeDocument" '
            'Target="word/document.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/'
            '2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            f'<Relationship Id="rId3" Type="{t}/extended-properties" '
            'Target="docProps/app.xml"/>'
            "</Relationships>")


def document_rels_xml() -> str:
    t = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    return (DECL + f'<Relationships xmlns="{PR}">'
            f'<Relationship Id="rId1" Type="{t}/styles" Target="styles.xml"/>'
            f'<Relationship Id="rId2" Type="{t}/numbering" Target="numbering.xml"/>'
            f'<Relationship Id="rId3" Type="{t}/settings" Target="settings.xml"/>'
            f'<Relationship Id="rId4" Type="{t}/fontTable" Target="fontTable.xml"/>'
            f'<Relationship Id="rId5" Type="{t}/header" Target="header1.xml"/>'
            f'<Relationship Id="rId6" Type="{t}/footer" Target="footer1.xml"/>'
            f'<Relationship Id="rId7" Type="{t}/comments" Target="comments.xml"/>'
            f'<Relationship Id="rId8" Type="{t}/image" Target="media/image1.png"/>'
            f'<Relationship Id="rId9" Type="{t}/hyperlink" Target="{HYPERLINK_URL}" '
            'TargetMode="External"/>'
            f'<Relationship Id="rId10" Type="{t}/customXml" '
            'Target="../customXml/item1.xml"/>'
            "</Relationships>")


def core_xml() -> str:
    cp = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
    return (DECL + f'<cp:coreProperties xmlns:cp="{cp}" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f"<dc:title>{TITLE}</dc:title>"
            "<dc:creator>ultrawork</dc:creator>"
            "<cp:lastModifiedBy>ultrawork</cp:lastModifiedBy>"
            '<dcterms:created xsi:type="dcterms:W3CDTF">2026-07-01T08:00:00Z'
            "</dcterms:created>"
            '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-07-02T10:20:00Z'
            "</dcterms:modified>"
            "</cp:coreProperties>")


def app_xml() -> str:
    ep = ("http://schemas.openxmlformats.org/officeDocument/2006/"
          "extended-properties")
    return (DECL + f'<Properties xmlns="{ep}" xmlns:vt="http://schemas.'
            'openxmlformats.org/officeDocument/2006/docPropsVTypes">'
            "<Application>ultrawork docx skill</Application>"
            "<DocSecurity>0</DocSecurity>"
            "<Pages>1</Pages>"
            "</Properties>")


def custom_item_xml() -> str:
    return (DECL + '<data xmlns="urn:ultrawork:fixture">'
            "<period>2026Q3</period><owner>财务部</owner></data>")


def custom_props_xml() -> str:
    ds = "http://schemas.openxmlformats.org/officeDocument/2006/customXml"
    return (DECL + f'<ds:datastoreItem xmlns:ds="{ds}" '
            'ds:itemID="{5B3A1F0C-2C4E-4F6B-9E11-3D77A0C51D42}">'
            '<ds:schemaRefs><ds:schemaRef ds:uri="urn:ultrawork:fixture"/>'
            "</ds:schemaRefs></ds:datastoreItem>")


def custom_rels_xml() -> str:
    t = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    return (DECL + f'<Relationships xmlns="{PR}">'
            f'<Relationship Id="rId1" Type="{t}/customXmlProps" '
            'Target="itemProps1.xml"/></Relationships>')


def png_bytes(size: int = 24, rgb: tuple[int, int, int] = (31, 92, 168)) -> bytes:
    """A solid-colour PNG, built here so the bytes never depend on a library version.

    Pillow is not a dependency of this skill and adding one to produce 24×24 pixels
    of blue would be a strange trade; more to the point, a committed fixture must be
    reproducible, and hand-rolling the two chunks makes that a property of this file.
    """
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)   # 8-bit truecolour
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, COMPRESS_LEVEL))
            + chunk(b"IEND", b""))


# ── outline.docx / fontless.docx ──────────────────────────────────────────────
def outline_document_xml(runs=None) -> str:
    """The heading-hierarchy sample. `runs` overrides how a paragraph's run is built.

    The `w:sectPr` carries page geometry and NO header or footer reference: creating
    one is four things (part, content-type Override, relationship, sectPr reference)
    and a document that already has one lets three of them be skipped unnoticed.
    """
    make = runs or (lambda style, text: run(text, bold=bool(style),
                                            size_half=HEADING_SIZE.get(style)))
    blocks = [para(make(style, text), style=style)
              for style, text in OUTLINE_BLOCKS]
    sect = ('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
            'w:header="851" w:footer="992" w:gutter="0"/>'
            '<w:cols w:space="425"/>'
            '<w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr>')
    return (DECL + f"<w:document {W_NS}><w:body>" + "".join(blocks) + sect
            + "</w:body></w:document>")


HEADING_SIZE = {"Heading1": 32, "Heading2": 28, "Heading3": 24}


def fontless_document_xml() -> str:
    """outline.docx with three runs' East Asian bindings removed, and nothing else.

    Built by rewriting runs of the good document rather than by authoring a second
    one, for the same reason `unordered.docx` is: a separately written "broken" file
    differs in ways that make a repair impossible to attribute.
    """
    def make(style, text):
        if text == FONTLESS_UNBOUND:                      # shape 1: no w:rPr at all
            return f"<w:r><w:t>{text}</w:t></w:r>"
        if text == FONTLESS_INHERITS:                     # shape 2: the style knows
            return f"<w:r><w:t>{text}</w:t></w:r>"
        if text == FONTLESS_HALF:                         # shape 3: only @w:ascii
            return (f'<w:r><w:rPr><w:rFonts w:ascii="{FONTLESS_KEPT_ASCII}" '
                    f'w:hAnsi="{FONTLESS_KEPT_ASCII}"/></w:rPr>'
                    f"<w:t>{text}</w:t></w:r>")
        return run(text, bold=bool(style), size_half=HEADING_SIZE.get(style))
    return outline_document_xml(make)


def outline_styles_xml(*, fontless: bool = False) -> str:
    """Normal + three heading levels.

    In the fontless variant `w:docDefaults` states no font at all and `Heading2`
    states one. That asymmetry is deliberate: it is what separates "nothing in this
    document says what face this text wants" from "the document already said, and a
    repair that overwrites it has restyled the user's heading".
    """
    defaults = (f'<w:rFonts w:ascii="{ASCII_FONT}" w:hAnsi="{ASCII_FONT}" '
                f'w:eastAsia="{EA_FONT}" w:cs="{ASCII_FONT}"/>') if not fontless else ""
    h2_fonts = (f'<w:rFonts w:ascii="{FONTLESS_STYLE_ASCII}" '
                f'w:hAnsi="{FONTLESS_STYLE_ASCII}" '
                f'w:eastAsia="{FONTLESS_STYLE_EA}"/>') if fontless else ""
    out = [DECL, f"<w:styles {W_NS}>",
           "<w:docDefaults><w:rPrDefault><w:rPr>", defaults,
           '<w:sz w:val="21"/><w:szCs w:val="22"/>',
           "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>",
           '<w:spacing w:after="0" w:line="312" w:lineRule="auto"/>',
           "</w:pPr></w:pPrDefault></w:docDefaults>",
           '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
           '<w:name w:val="Normal"/><w:qFormat/></w:style>']
    for level in (1, 2, 3):
        sid = f"Heading{level}"
        half = HEADING_SIZE[sid]
        out.append(
            f'<w:style w:type="paragraph" w:styleId="{sid}">'
            f'<w:name w:val="heading {level}"/><w:basedOn w:val="Normal"/>'
            f'<w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>'
            f'<w:pPr><w:spacing w:before="340" w:after="330"/>'
            f'<w:outlineLvl w:val="{level - 1}"/></w:pPr>'
            f"<w:rPr>{h2_fonts if sid == 'Heading2' else ''}<w:b/><w:bCs/>"
            f'<w:sz w:val="{half}"/><w:szCs w:val="{half}"/></w:rPr></w:style>')
    out.append("</w:styles>")
    return "".join(out)


def outline_content_types_xml() -> str:
    """No `<Default Extension="png">`: inserting a picture must declare it."""
    o = "application/vnd.openxmlformats-officedocument.wordprocessingml."
    return (DECL + f'<Types xmlns="{CT}">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-'
            'package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            f'<Override PartName="/word/document.xml" ContentType="{o}document.main+xml"/>'
            f'<Override PartName="/word/styles.xml" ContentType="{o}styles+xml"/>'
            f'<Override PartName="/word/numbering.xml" ContentType="{o}numbering+xml"/>'
            f'<Override PartName="/word/settings.xml" ContentType="{o}settings+xml"/>'
            f'<Override PartName="/word/fontTable.xml" ContentType="{o}fontTable+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.'
            'openxmlformats-package.core-properties+xml"/>'
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.'
            'openxmlformats-officedocument.extended-properties+xml"/>'
            "</Types>")


def outline_document_rels_xml() -> str:
    t = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    return (DECL + f'<Relationships xmlns="{PR}">'
            f'<Relationship Id="rId1" Type="{t}/styles" Target="styles.xml"/>'
            f'<Relationship Id="rId2" Type="{t}/numbering" Target="numbering.xml"/>'
            f'<Relationship Id="rId3" Type="{t}/settings" Target="settings.xml"/>'
            f'<Relationship Id="rId4" Type="{t}/fontTable" Target="fontTable.xml"/>'
            "</Relationships>")


def outline_core_xml(title: str) -> str:
    cp = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
    return (DECL + f'<cp:coreProperties xmlns:cp="{cp}" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f"<dc:title>{title}</dc:title>"
            "<dc:creator>ultrawork</dc:creator>"
            "<cp:lastModifiedBy>ultrawork</cp:lastModifiedBy>"
            '<dcterms:created xsi:type="dcterms:W3CDTF">2026-07-01T08:00:00Z'
            "</dcterms:created>"
            '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-07-02T10:20:00Z'
            "</dcterms:modified>"
            "</cp:coreProperties>")


def outline_parts(*, fontless: bool = False) -> list[tuple[str, bytes]]:
    document = fontless_document_xml() if fontless else outline_document_xml()
    title = "字体巡检样例" if fontless else "多级标题样例"
    text = [
        ("[Content_Types].xml", outline_content_types_xml()),
        ("_rels/.rels", package_rels_xml()),
        ("word/document.xml", document),
        ("word/_rels/document.xml.rels", outline_document_rels_xml()),
        ("word/styles.xml", outline_styles_xml(fontless=fontless)),
        ("word/numbering.xml", numbering_xml()),
        ("word/settings.xml", settings_xml()),
        ("word/fontTable.xml", font_table_xml()),
        ("docProps/core.xml", outline_core_xml(title)),
        ("docProps/app.xml", app_xml()),
    ]
    return [(n, s.encode("utf-8")) for n, s in text]


# ── chart.png ─────────────────────────────────────────────────────────────────
# A standalone picture to insert, which report.docx's embedded one cannot be: the
# insert path takes a file from the filesystem. Two properties of it are load-bearing
# and neither is decoration:
#
#   * it is NOT square (240x120), so an implementation that writes one number for
#     both extents, or swaps them, produces a visibly wrong picture rather than an
#     identical one.
#   * it carries a `pHYs` chunk declaring 150 dpi. The intrinsic size is therefore
#     1.6 x 0.8 inch = 1463040 x 731520 EMU, while an implementation that assumes the
#     web's 96 dpi computes 2286000 — same file, same code path, different answer, so
#     the assertion can tell the two apart.
CHART_PX = (240, 120)
CHART_DPI = 150
CHART_PPM = round(CHART_DPI / 0.0254)      # pHYs stores pixels per METRE


def chart_png() -> bytes:
    """A two-tone 240x120 PNG with an explicit physical density."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    width, height = CHART_PX
    ink, paper = (31, 92, 168), (238, 242, 248)
    rows = []
    for y in range(height):
        px = []
        for x in range(width):
            # Five ascending bars: enough structure that a renderer showing the
            # picture at all is distinguishable from a renderer showing a blank box.
            bar = x // (width // 5)
            px.append(ink if y >= height - (bar + 1) * (height // 6) else paper)
        rows.append(b"\x00" + b"".join(bytes(p) for p in px))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    phys = struct.pack(">IIB", CHART_PPM, CHART_PPM, 1)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"pHYs", phys)
            + chunk(b"IDAT", zlib.compress(b"".join(rows), COMPRESS_LEVEL))
            + chunk(b"IEND", b""))


def parts(document: str | None = None) -> list[tuple[str, bytes]]:
    """Every part, in the order the zip stores them (content types first)."""
    text = [
        ("[Content_Types].xml", content_types_xml()),
        ("_rels/.rels", package_rels_xml()),
        ("word/document.xml", document if document is not None else document_xml()),
        ("word/_rels/document.xml.rels", document_rels_xml()),
        ("word/styles.xml", styles_xml()),
        ("word/numbering.xml", numbering_xml()),
        ("word/settings.xml", settings_xml()),
        ("word/fontTable.xml", font_table_xml()),
        ("word/header1.xml", header_xml()),
        ("word/footer1.xml", footer_xml()),
        ("word/comments.xml", comments_xml()),
        ("docProps/core.xml", core_xml()),
        ("docProps/app.xml", app_xml()),
        ("customXml/item1.xml", custom_item_xml()),
        ("customXml/_rels/item1.xml.rels", custom_rels_xml()),
        ("customXml/itemProps1.xml", custom_props_xml()),
    ]
    out: list[tuple[str, bytes]] = [(n, s.encode("utf-8")) for n, s in text]
    out.insert(3, ("word/media/image1.png", png_bytes()))
    return out


def write_package(path: Path, items: list[tuple[str, bytes]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED,
                         compresslevel=COMPRESS_LEVEL) as z:
        for name, data in items:
            info = zipfile.ZipInfo(name, date_time=EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            # ⚠️ The fourth thing reproducibility needs, and the only one that is
            # invisible on the machine you develop on. `ZipInfo.__init__` sets
            # `create_system = 0` on Windows and `3` (Unix) everywhere else, and that
            # byte goes into the zip's central directory — so the SAME generator
            # produces different bytes on Windows. Measured on CI: F0 fired there
            # while every other platform was green, and 141 of 145 docx assertions
            # went with it. Pinned to 3, which is what macOS and Linux already write,
            # so the committed fixtures do not change.
            info.create_system = 3
            z.writestr(info, data)


def write_docx(path: Path, document: str | None = None) -> None:
    write_package(path, parts(document))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", default=str(HERE),
                    help="write somewhere else (used to verify reproducibility "
                         "without touching the committed files)")
    args = ap.parse_args()
    out = Path(args.out_dir)
    for name, items in (("report.docx", parts()),
                        ("unordered.docx", parts(document_xml_unordered())),
                        ("outline.docx", outline_parts()),
                        ("fontless.docx", outline_parts(fontless=True))):
        target = out / name
        write_package(target, items)
        print(f"wrote {target} ({target.stat().st_size} bytes)")
    chart = out / "chart.png"
    chart.write_bytes(chart_png())
    print(f"wrote {chart} ({chart.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
