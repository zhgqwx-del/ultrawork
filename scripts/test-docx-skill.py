#!/usr/bin/env python3
"""Behaviour tests for the docx skill's scripts (discussions/059 S4).

L1 proves each declared capability runs and produces an artifact; L2 proves the
artifact is a legal, non-lossy Word document. Neither can say whether the RESULT is
right — that a phrase Word split across three runs was actually found, that the
appended paragraph landed before `<w:sectPr>` and not after it, that an unpack and
repack gave back the same 17 parts in the same order. Those claims are this file's
job.

    python3 scripts/test-docx-skill.py
    python3 scripts/test-docx-skill.py --json

Every assertion runs twice: once against the real output of the real scripts (must
stay silent) and once against output carrying exactly the defect it hunts (must
fire). The flaws are not invented damage — each is the implementation somebody
reaches for first. `replace-run-by-run` above all: iterating `paragraph.runs` and
calling `str.replace` on each is what every example on the internet does, and on
this skill's own sample it finds **1 of the 2** occurrences — the one that happens
to sit inside a single run — and silently misses the one that spans two. Partial
success is why nobody notices.

The run prints a flaw -> fired-checks matrix. "All the negative controls went red"
is not the claim; "the RIGHT check went red" is, and only the matrix shows the
difference.

Exit 0 = every assertion behaved, 1 = something did not.
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / "skills" / "builtin" / "docx"
FIXTURES = SKILL / "fixtures"
REPORT = FIXTURES / "report.docx"
UNORDERED = FIXTURES / "unordered.docx"
PY = sys.executable

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# What report.docx is known to hold. Spelled out rather than read back from the
# file: an expectation derived from the artifact it checks agrees with itself no
# matter what the artifact says.
TITLE = "二零二六年第三季度经营分析报告"
SPLIT_PARAGRAPH = "2026 年第三季度营业收入同比增长 12%，毛利率保持稳定。"
# Stored as "2026 年第" | "三季度" | "营业收入…" — this phrase spans the first two.
CROSS_RUN = "第三季度"
CROSS_RUN_NEW = "第四季度"
# The same phrase also occurs inside the TITLE, in a single run. Both in one call is
# deliberate: a replacement that only handles one of the two cases is a partial
# implementation that looks complete from the outside.
CROSS_RUN_TOTAL = 2
CROSS_RUN_SPANNING = 1
# What the per-run implementation finds, measured by running it: exactly the
# occurrences that do NOT span a run. It is not zero, and that matters — a tool that
# found nothing would be reported as broken within a minute.
NAIVE_HITS = CROSS_RUN_TOTAL - CROSS_RUN_SPANNING
PLACEHOLDER = "{{客户名称}}"
PLACEHOLDER_NEW = "示例科技有限公司"
INSERTED = "净利润"          # inside <w:ins>
# Inside <w:del>, therefore NOT document text. A phrase that occurs nowhere else:
# an earlier draft used "毛利", a substring of the ordinary body text
# "毛利率保持稳定。", so R2 fired on a correct implementation.
DELETED = "扣非净利"
COMMENT_TEXT = "请与银行流水核对后再定稿。"
HEADER_TEXT = "内部资料 · 请勿外传 · 密级：{{密级}}"
LIST_TEXT = "费用结构持续优化，管理费用同比下降。"
TABLE_CELL = "营业收入"
PARTS_TOTAL = 17
APPEND_TEXT = "结论：维持全年增长预期。"

# The three order defects unordered.docx carries, and nothing else.
ORDER_DEFECTS = 3

# W5's placeholders. 客户名称 is split across runs in the fixture, 密级 lives in the
# header — a filler that only walks word/document.xml leaves the letterhead unfilled.
FILL_SPLIT = "客户名称"
FILL_HEADER = "密级"
FILL_LEFT = "日期"          # deliberately NOT supplied, so `unfilled` has a subject
FILL_TYPO = "客户名"        # a key that matches no placeholder

# Assertions that need LibreOffice. On a host without it they are SKIPPED and named,
# never folded into the pass count — and so are the negative controls that could not
# fire, because a control nobody ran is not a control (059 §7, the recalc-drift雷).
SOFFICE_CHECKS = {"Y1", "Y2", "Y3"}

STDOUT_BUDGET = 6000        # bytes one call may print for a long document
SCALE_PARAGRAPHS = 2000     # comfortably past docxcommon.STDOUT_ITEM_LIMIT
# The other shape of oversized report, and the one the item-count trimmer cannot
# see: FEW entries, each enormous. One table this tall printed 130,602 bytes before
# the byte budget existed. Found by asking "is this compatible with Team mode?",
# not by any assertion — C1 only ever exercised a long list.
SCALE_TABLE_ROWS = 800

# W6/W7. The fixture already carries ONE revision by 张审阅 (净利润 inserted, 扣非净利
# deleted) — that second author is what makes per-author filtering testable at all.
REVISER = "张三"
FIXTURE_AUTHOR = "张审阅"
TRACKED_PARAGRAPH = 1           # the one holding the cross-run phrase
REVISION_PARAGRAPH = 5          # the one the fixture already had a revision in
ACCEPTED_REVISION = "本季度净利润同比增长。"
REJECTED_REVISION = "本季度扣非净利同比增长。"
INSERTED_PARAGRAPH = "新增结论段落。"

# W8.
COMMENT_ANCHOR_SPLIT = "三季度营业收入"    # its first occurrence spans two runs
NEW_COMMENT = "季度口径需与年报一致。"

# Claims this host could not exercise. Reported separately and never folded into the
# pass count — a skip and a pass look identical at a glance, which is exactly how a
# wrong expectation once sat unnoticed for a month.
SKIPS: list[str] = []


def run_script(name: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([PY, str(SKILL / "scripts" / name), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=300)


def parts_of(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist() if not n.endswith("/")}


def part_order(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as z:
        return [i.filename for i in z.infolist() if not i.filename.endswith("/")]


def rewrite_zip(src: Path, dst: Path, mutate) -> None:
    """Copy a zip, passing each (name, bytes) through mutate; None drops the entry."""
    with zipfile.ZipFile(src) as zin, \
            zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = mutate(item.filename, zin.read(item.filename))
            if data is not None:
                zout.writestr(item, data)


def tree_of(path: Path, part: str = "word/document.xml"):
    from lxml import etree
    return etree.fromstring(parts_of(path)[part])


def paragraph_texts(path: Path) -> list[str]:
    """Paragraph text the way a reader that understands revisions sees it.

    Written here rather than imported from the skill: an assertion that measures the
    implementation with the implementation's own ruler agrees with it by
    construction. `<w:delText>` is excluded because deleted text is not in the
    document; text inside `<w:ins>` is included because inserted text is.
    """
    out = []
    for para in tree_of(path).iter(W + "p"):
        chunks = []
        for node in para.iter():
            tag = str(node.tag)
            if tag == W + "t" and not any(
                    str(a.tag) == W + "del" for a in node.iterancestors()):
                chunks.append(node.text or "")
            elif tag == W + "tab":
                chunks.append("\t")
            elif tag == W + "br":
                chunks.append("\n")
        out.append("".join(chunks))
    return out


def body_child_names(path: Path) -> list[str]:
    body = tree_of(path).find(W + "body")
    return [str(c.tag).rsplit("}", 1)[-1] for c in body]


def naive_run_replace(path: Path, needle: str) -> int:
    """The implementation everybody writes first, run for real on the same file.

    Not a description of a defect — the defect itself, executed, so the number it
    produces is measured rather than asserted. python-docx is used because that is
    what the reference implementations use; the result (0) is a property of the
    document, not of the library.
    """
    import docx
    hits = 0
    doc = docx.Document(str(path))
    for para in doc.paragraphs:
        for r in para.runs:
            hits += r.text.count(needle)
    return hits


def with_line_break(src: Path, dst: Path) -> None:
    """Put a `<w:br/>` in the middle of a phrase, so a search for it cannot match.

    This is not damage: a line break inside a sentence is ordinary. It is here
    because "the phrase is not found and the tool does not say why" is the single
    most common way a replace call wastes someone's afternoon.
    """
    def mutate(name: str, data: bytes) -> bytes:
        if name != "word/document.xml":
            return data
        anchor = "<w:t>三季度</w:t></w:r>".encode()
        assert anchor in data, "the split run is not what this mutation expects"
        return data.replace(anchor, anchor + '<w:r><w:br/></w:r>'.encode(), 1)
    rewrite_zip(src, dst, mutate)


def without_numbering(src: Path, dst: Path) -> None:
    """Drop word/numbering.xml the way a package must be trimmed: all three things."""
    def mutate(name: str, data: bytes) -> bytes | None:
        if name == "word/numbering.xml":
            return None
        if name == "[Content_Types].xml":
            return data.replace(
                b'<Override PartName="/word/numbering.xml" ContentType="application/'
                b'vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>',
                b"")
        if name == "word/_rels/document.xml.rels":
            return data.replace(
                b'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/'
                b'officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
                b"")
        if name == "word/document.xml":
            return data.replace(b'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/>'
                                b"</w:numPr>", b"")
        return data
    rewrite_zip(src, dst, mutate)


def tall_table(src: Path, dst: Path, rows: int) -> None:
    """One table with `rows` rows: a report list of length ONE, holding megabytes."""
    cell = ('<w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr>'
            '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" '
            'w:cs="Calibri"/></w:rPr><w:t>某个中文单元格内容占位</w:t></w:r></w:p></w:tc>')
    row = "<w:tr>" + cell * 3 + "</w:tr>"

    def mutate(name: str, data: bytes) -> bytes:
        if name != "word/document.xml":
            return data
        return data.replace(b"</w:tbl>", (row * rows).encode() + b"</w:tbl>", 1)
    rewrite_zip(src, dst, mutate)


def long_document(src: Path, dst: Path, paragraphs: int) -> None:
    """A document with `paragraphs` paragraphs, for the stdout budget."""
    def mutate(name: str, data: bytes) -> bytes:
        if name != "word/document.xml":
            return data
        one = ("<w:p><w:r><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" "
               "w:eastAsia=\"宋体\" w:cs=\"Calibri\"/></w:rPr>"
               "<w:t>批量段落用于测量输出预算</w:t></w:r></w:p>")
        return data.replace(b"<w:sectPr>", (one * paragraphs).encode() + b"<w:sectPr>", 1)
    rewrite_zip(src, dst, mutate)


def fixture_facts() -> dict:
    """Facts about the fixtures, read from the FILES and from nothing else.

    ⚠️ The vacuity check must not consult any of the skill's own reports. A V0 that
    reads what a script said cannot tell "the fixture stopped exercising this" from
    "the implementation stopped doing it", and then it fires on defects that belong
    to other assertions — a mistake this repo has now made three times in one task
    (059 §六·补二). Everything below is computed by walking the XML here.
    """
    root = tree_of(REPORT)
    split = [p for p in root.iter(W + "p")
             if "".join(t.text or "" for t in p.iter(W + "t")) == SPLIT_PARAGRAPH]
    spans = 0
    if split:
        offset, hit = 0, set()
        for node in split[0].iter(W + "t"):
            text = node.text or ""
            start, end = offset, offset + len(text)
            at = SPLIT_PARAGRAPH.find(CROSS_RUN)
            if start < at + len(CROSS_RUN) and end > at:
                hit.add(id(node))
            offset = end
        spans = len(hit)

    unordered = tree_of(UNORDERED)
    body = unordered.find(W + "body")
    defects = 0
    kids = list(body)
    if kids and str(kids[-1].tag) != W + "sectPr":
        defects += 1
    for para in unordered.iter(W + "p"):
        children = [str(c.tag) for c in para]
        if W + "pPr" in children and children.index(W + "pPr") != 0:
            defects += 1
    for r in unordered.iter(W + "r"):
        children = [str(c.tag) for c in r]
        if W + "rPr" in children and children.index(W + "rPr") != 0:
            defects += 1

    return {
        "phrase_runs": spans,
        "naive_hits": naive_run_replace(REPORT, CROSS_RUN),
        "tables": len(list(root.iter(W + "tbl"))),
        "insertions": len(list(root.iter(W + "ins"))),
        "deletions": len(list(root.iter(W + "del"))),
        "comments": len(list(tree_of(REPORT, "word/comments.xml").iter(W + "comment"))),
        "custom_xml": any(n.startswith("customXml/") for n in parts_of(REPORT)),
        "header_footer_parts": sum(1 for n in parts_of(REPORT)
                                   if n.startswith(("word/header", "word/footer"))),
        "footer_fields": sum(1 for f in tree_of(REPORT, "word/footer1.xml")
                             .iter(W + "fldChar")
                             if f.get(W + "fldCharType") == "begin"),
        "list_paragraphs": len(list(root.iter(W + "numPr"))),
        "parts": len(parts_of(REPORT)),
        "order_defects": defects,
    }


# ── collect: run the real scripts once ────────────────────────────────────────
def collect(work: Path) -> dict:
    ctx: dict = {"fixture": fixture_facts()}

    # --- W1 read --------------------------------------------------------------
    r = run_script("docx_read.py", "--in", REPORT, "--outline", "--tables", "--text",
                   "--out", work / "document.json")
    read_report = json.loads((work / "document.json").read_text(encoding="utf-8"))
    ctx["read"] = {"exit": r.returncode, "report": read_report}

    # python-docx's own answer for the revision paragraph, measured rather than
    # described: it walks direct <w:r> children only, so a tracked insertion is
    # missing from what it returns. The skill must not agree with it.
    import docx as pydocx
    pd = pydocx.Document(str(REPORT))
    ctx["read"]["python_docx_paragraph_texts"] = [p.text for p in pd.paragraphs]

    # --- W2 replace, and the control everyone writes instead -------------------
    replaced = work / "replaced.docx"
    e = run_script("docx_edit.py", "--in", REPORT, "--out", replaced,
                   "--replace", f"{CROSS_RUN}={CROSS_RUN_NEW}",
                   "--replace", f"{PLACEHOLDER}={PLACEHOLDER_NEW}",
                   "--report", work / "replace.json")
    replace_report = json.loads((work / "replace.json").read_text(encoding="utf-8"))
    before, after = parts_of(REPORT), parts_of(replaced)
    ctx["replace"] = {
        "exit": e.returncode,
        "report": replace_report,
        "texts": paragraph_texts(replaced),
        "header_text": header_text(replaced),
        "parts_before": sorted(before),
        "parts_after": sorted(after),
        "identical": sorted(n for n in before if after.get(n) == before[n]),
        # The rPr of the run that received the replacement, before and after: an
        # edit that rebuilds the run loses its font binding and size.
        "rpr_before": rpr_of_first_run(REPORT, 1),
        "rpr_after": rpr_of_first_run(replaced, 1),
    }

    # --- a phrase broken by a line break --------------------------------------
    broken = work / "with-break.docx"
    with_line_break(REPORT, broken)
    nm = run_script("docx_edit.py", "--in", broken, "--out", work / "nm.docx",
                    "--replace", "三季度营业收入=第四季度营业收入",
                    "--report", work / "nearmiss.json")
    ctx["near_miss"] = {"exit": nm.returncode,
                        "report": json.loads((work / "nearmiss.json")
                                             .read_text(encoding="utf-8"))}

    # --- replacing inside tracked content -------------------------------------
    rv = run_script("docx_edit.py", "--in", REPORT, "--out", work / "rev.docx",
                    "--replace", f"{INSERTED}=归母净利润",
                    "--report", work / "rev.json")
    ctx["revision_edit"] = {"exit": rv.returncode,
                            "report": json.loads((work / "rev.json")
                                                 .read_text(encoding="utf-8"))}

    # --- headers ---------------------------------------------------------------
    hd = run_script("docx_edit.py", "--in", REPORT, "--out", work / "hdr.docx",
                    "--replace", "内部资料=公开资料", "--in-headers",
                    "--report", work / "hdr.json")
    ctx["headers"] = {"exit": hd.returncode,
                      "report": json.loads((work / "hdr.json")
                                           .read_text(encoding="utf-8")),
                      "header_text": header_text(work / "hdr.docx")}

    # --- W3 append -------------------------------------------------------------
    appended = work / "appended.docx"
    a = run_script("docx_edit.py", "--in", REPORT, "--out", appended,
                   "--append-paragraph", APPEND_TEXT, "--report", work / "append.json")
    ctx["append"] = {
        "exit": a.returncode,
        "report": json.loads((work / "append.json").read_text(encoding="utf-8")),
        "body_children": body_child_names(appended),
        "texts": paragraph_texts(appended),
        "fonts": appended_run_fonts(appended),
        "section_survives": bool(tree_of(appended).find(f"{W}body/{W}sectPr") is not None),
    }

    plain = work / "no-numbering.docx"
    without_numbering(REPORT, plain)
    nl = run_script("docx_edit.py", "--in", plain, "--out", work / "listed.docx",
                    "--append-paragraph", "列表项", "--list", "1")
    ctx["append"]["list_without_numbering"] = {
        "exit": nl.returncode, "stderr": nl.stderr.strip(),
        "wrote": (work / "listed.docx").exists()}
    ok = run_script("docx_edit.py", "--in", REPORT, "--out", work / "listed-ok.docx",
                    "--append-paragraph", "列表项", "--list", "1")
    ctx["append"]["list_with_numbering"] = {
        "exit": ok.returncode,
        "num_ids": num_ids_of(work / "listed-ok.docx")}

    # --- W13 unpack / pack -----------------------------------------------------
    p = run_script("docx_package.py", "--in", REPORT, "--unpack", work / "unpacked",
                   "--out", work / "rebuilt.docx", "--report", work / "package.json")
    pack_report = json.loads((work / "package.json").read_text(encoding="utf-8"))
    rebuilt = parts_of(work / "rebuilt.docx")
    ctx["package"] = {
        "exit": p.returncode,
        "report": pack_report,
        "identical": sum(1 for n in before if rebuilt.get(n) == before[n]),
        "order_before": part_order(REPORT),
        "order_after": part_order(work / "rebuilt.docx"),
    }

    # A part added by hand between unpack and pack must survive the round trip —
    # editing a part is the whole reason to unpack one.
    (work / "unpacked" / "word" / "added.xml").write_text(
        '<?xml version="1.0"?><added/>', encoding="utf-8")
    ap = run_script("docx_package.py", "--pack", work / "unpacked",
                    "--out", work / "with-added.docx")
    ctx["package"]["added_part"] = {
        "exit": ap.returncode,
        "present": "word/added.xml" in parts_of(work / "with-added.docx")}

    # Without the manifest the order is whatever the filesystem hands back, which is
    # the control that proves the manifest is what preserves it.
    (work / "unpacked" / "_manifest.json").unlink()
    (work / "unpacked" / "word" / "added.xml").unlink()
    nomf = run_script("docx_package.py", "--pack", work / "unpacked",
                      "--out", work / "no-manifest.docx")
    ctx["package"]["without_manifest_order"] = part_order(work / "no-manifest.docx") \
        if nomf.returncode == 0 else []

    ctx["package"]["traversal"] = traversal_refused(work)

    # --- W15 element order -----------------------------------------------------
    chk = run_script("docx_package.py", "--in", UNORDERED, "--check",
                     "--report", work / "check.json")
    check_report = json.loads((work / "check.json").read_text(encoding="utf-8"))
    fixed = work / "ordered.docx"
    fx = run_script("docx_package.py", "--in", UNORDERED, "--fix-order", "--out", fixed,
                    "--report", work / "order.json")
    fix_report = json.loads((work / "order.json").read_text(encoding="utf-8"))
    after_chk = run_script("docx_package.py", "--in", fixed, "--check",
                           "--report", work / "check2.json")
    unordered_parts = parts_of(UNORDERED)
    fixed_parts = parts_of(fixed)
    ctx["order"] = {
        "check_exit": chk.returncode,
        "check_findings": check_report["findings"],
        "fix_exit": fx.returncode,
        "fix_report": fix_report,
        "after_exit": after_chk.returncode,
        "after_findings": json.loads((work / "check2.json")
                                     .read_text(encoding="utf-8"))["findings"],
        "text_before": paragraph_texts(UNORDERED),
        "text_after": paragraph_texts(fixed),
        "other_parts_identical": sum(1 for n in unordered_parts
                                     if n != "word/document.xml"
                                     and fixed_parts.get(n) == unordered_parts[n]),
        "other_parts_total": len(unordered_parts) - 1,
    }

    # --- W5 template fill ------------------------------------------------------
    filled = work / "filled.docx"
    tf = run_script("docx_template.py", "--in", REPORT, "--out", filled,
                    "--set", f"{FILL_SPLIT}=示例科技有限公司",
                    "--set", f"{FILL_HEADER}=内部",
                    "--set", f"{FILL_TYPO}=错的键",
                    "--report", work / "fill.json")
    strict = run_script("docx_template.py", "--in", REPORT,
                        "--out", work / "strict.docx",
                        "--set", f"{FILL_SPLIT}=示例科技有限公司", "--strict")
    ctx["template"] = {
        "exit": tf.returncode,
        "report": json.loads((work / "fill.json").read_text(encoding="utf-8")),
        "header_text": header_text(filled),
        "texts": paragraph_texts(filled),
        "strict": {"exit": strict.returncode, "stderr": strict.stderr.strip(),
                   "wrote": (work / "strict.docx").exists()},
    }

    # --- W17 render ------------------------------------------------------------
    ctx["pdf"] = collect_pdf(work)

    # --- W6 / W7 tracked changes ------------------------------------------------
    ctx["revise"] = collect_revisions(work)

    # --- W8 comments -------------------------------------------------------------
    ctx["comment"] = collect_comments(work)

    # --- contracts -------------------------------------------------------------
    big = work / "big.docx"
    long_document(REPORT, big, SCALE_PARAGRAPHS)
    out = run_script("docx_read.py", "--in", big, "--outline")
    tall = work / "tall.docx"
    tall_table(REPORT, tall, SCALE_TABLE_ROWS)
    wide = run_script("docx_read.py", "--in", tall, "--tables")
    in_place = run_script("docx_edit.py", "--in", REPORT, "--out", REPORT,
                          "--replace", "a=b")
    missing = run_script("docx_read.py", "--in", work / "nope.docx")
    not_word = work / "notword.xlsx"
    make_xlsx_like(not_word)
    wrong_kind = run_script("docx_read.py", "--in", not_word)
    ctx["contracts"] = {
        "stdout_bytes": len(out.stdout.encode()),
        "stdout_exit": out.returncode,
        "tall_stdout_bytes": len(wide.stdout.encode()),
        "tall_exit": wide.returncode,
        "tall_stdout": wide.stdout,
        "in_place": {"exit": in_place.returncode, "stderr": in_place.stderr.strip()},
        "missing": {"exit": missing.returncode, "stderr": missing.stderr.strip(),
                    "traceback": "Traceback" in missing.stderr},
        "wrong_kind": {"exit": wrong_kind.returncode,
                       "stderr": wrong_kind.stderr.strip(),
                       "traceback": "Traceback" in wrong_kind.stderr},
    }

    # --- the fixtures are byte-reproducible ------------------------------------
    regen = work / "regen"
    rg = subprocess.run([PY, str(FIXTURES / "make_fixtures.py"), "--out-dir", str(regen)],
                        capture_output=True, text=True, timeout=120)
    ctx["fixtures"] = {
        "exit": rg.returncode,
        "identical": {name: (regen / name).is_file()
                      and (regen / name).read_bytes() == (FIXTURES / name).read_bytes()
                      for name in ("report.docx", "unordered.docx")},
    }
    return ctx


def blank_document(src: Path, dst: Path) -> None:
    """A document whose body holds one empty paragraph and nothing else.

    The header and footer references go too, and that is not tidiness: the first
    version of this kept them, so LibreOffice rendered a page carrying the
    letterhead and the page number — a page with ink on it. The assertion fired on
    a correct implementation, which is the honest way to find out that the fixture
    was not the thing it was named after.
    """
    import re
    def mutate(name: str, data: bytes) -> bytes:
        if name != "word/document.xml":
            return data
        text = data.decode()
        head = text[:text.index("<w:body>") + len("<w:body>")]
        sect = text[text.index("<w:sectPr>"):]
        sect = re.sub(r"<w:(header|footer)Reference[^>]*/>", "", sect)
        return (head + "<w:p/>" + sect).encode()
    rewrite_zip(src, dst, mutate)


def collect_pdf(work: Path) -> dict:
    """Render, and the blank-render refusal. Skipped and NAMED without LibreOffice."""
    sys.path.insert(0, str(SKILL / "scripts"))
    from office.soffice import find_soffice
    if not find_soffice():
        SKIPS.append("W17 render (Y1-Y3): LibreOffice is not installed on this host, "
                     "so neither the conversion nor its negative controls could run. "
                     "CI runs them on Linux, where libreoffice-writer is installed")
        return {"skipped": "no LibreOffice"}
    out = work / "preview.pdf"
    r = run_script("docx_pdf.py", "--in", REPORT, "--out", out,
                   "--png", work / "pages", "--dpi", "120",
                   "--report", work / "pdf.json")
    report = json.loads((work / "pdf.json").read_text(encoding="utf-8")) \
        if (work / "pdf.json").exists() else {}
    blank = work / "blank.docx"
    blank_document(REPORT, blank)
    b = run_script("docx_pdf.py", "--in", blank, "--out", work / "blank.pdf")
    return {
        "exit": r.returncode, "report": report,
        "produced": out.is_file() and out.stat().st_size > 0,
        "images": len(list((work / "pages").glob("*.png"))) if (work / "pages").is_dir()
                  else 0,
        "blank": {"exit": b.returncode, "stderr": b.stderr.strip(),
                  "wrote": (work / "blank.pdf").exists()},
    }


def revision_elements(path: Path) -> list[dict]:
    """Every w:ins / w:del in document.xml, read straight from the XML."""
    out = []
    for el in tree_of(path).iter():
        name = str(el.tag).rsplit("}", 1)[-1]
        if name not in ("ins", "del"):
            continue
        parent = el.getparent()
        mark = (parent is not None and str(parent.tag).endswith("}rPr")
                and parent.getparent() is not None
                and str(parent.getparent().tag).endswith("}pPr"))
        out.append({
            "kind": name, "id": el.get(W + "id"), "author": el.get(W + "author"),
            "date": el.get(W + "date"), "paragraph_mark": mark,
            "runs": len(el.findall(W + "r")),
            "text": "".join(x.text or "" for x in el.iter(W + "t", W + "delText")),
            "holds_wt": bool(name == "del" and el.findall(f".//{W}t")),
        })
    return out


def body_paragraph_texts(path: Path) -> list[str]:
    root = tree_of(path)
    body = root.find(W + "body")
    return [t for c in body if str(c.tag) == W + "p"
            for t in ["".join(
                (n.text or "") for n in c.iter()
                if str(n.tag) == W + "t"
                and not any(str(a.tag) == W + "del" for a in n.iterancestors()))]]


def collect_revisions(work: Path) -> dict:
    tracked = work / "tracked.docx"
    r = run_script("docx_revise.py", "--in", REPORT, "--out", tracked,
                   "--author", REVISER, "--replace", f"{CROSS_RUN}={CROSS_RUN_NEW}",
                   "--report", work / "revise.json")
    report = json.loads((work / "revise.json").read_text(encoding="utf-8"))

    acc, rej = work / "acc.docx", work / "rej.docx"
    a = run_script("docx_revise.py", "--in", tracked, "--out", acc,
                   "--accept-all", "--strict", "--report", work / "acc.json")
    j = run_script("docx_revise.py", "--in", tracked, "--out", rej,
                   "--reject-all", "--strict", "--report", work / "rej.json")

    added = work / "added.docx"
    run_script("docx_revise.py", "--in", REPORT, "--out", added, "--author", REVISER,
               "--insert-paragraph", INSERTED_PARAGRAPH)
    added_acc, added_rej = work / "added-acc.docx", work / "added-rej.docx"
    run_script("docx_revise.py", "--in", added, "--out", added_acc, "--accept-all")
    run_script("docx_revise.py", "--in", added, "--out", added_rej, "--reject-all")

    # Per-author: accept only the reviser's, leaving the fixture author's alone.
    by_author = work / "by-author.docx"
    ba = run_script("docx_revise.py", "--in", tracked, "--out", by_author,
                    "--accept-author", REVISER, "--report", work / "author.json")
    strict_partial = run_script("docx_revise.py", "--in", tracked,
                                "--out", work / "sp.docx",
                                "--accept-author", REVISER, "--strict")

    # Inserted, then deleted: the nesting the L2 gate used to reject. Both accepting
    # and rejecting must make the text go away, for opposite reasons.
    nested = work / "nested.docx"
    run_script("docx_revise.py", "--in", tracked, "--out", nested,
               "--author", REVISER, "--delete", CROSS_RUN_NEW)
    n_acc, n_rej = work / "nested-acc.docx", work / "nested-rej.docx"
    run_script("docx_revise.py", "--in", nested, "--out", n_acc, "--accept-all")
    run_script("docx_revise.py", "--in", nested, "--out", n_rej, "--reject-all")

    return {
        "exit": r.returncode, "report": report,
        "elements": revision_elements(tracked),
        "accept": {"exit": a.returncode,
                   "report": json.loads((work / "acc.json").read_text(encoding="utf-8")),
                   "texts": body_paragraph_texts(acc),
                   "elements": revision_elements(acc)},
        "reject": {"exit": j.returncode,
                   "report": json.loads((work / "rej.json").read_text(encoding="utf-8")),
                   "texts": body_paragraph_texts(rej),
                   "elements": revision_elements(rej)},
        "original_texts": body_paragraph_texts(REPORT),
        "inserted": {
            "elements": revision_elements(added),
            "accepted": body_paragraph_texts(added_acc),
            "rejected": body_paragraph_texts(added_rej),
        },
        "by_author": {
            "exit": ba.returncode,
            "report": json.loads((work / "author.json").read_text(encoding="utf-8")),
            "elements": revision_elements(by_author),
            "strict_exit": strict_partial.returncode,
            "strict_stderr": strict_partial.stderr.strip(),
            "strict_wrote": (work / "sp.docx").exists(),
        },
        "nested": {
            "elements": revision_elements(nested),
            "accepted": body_paragraph_texts(n_acc),
            "rejected": body_paragraph_texts(n_rej),
        },
    }


def comment_pieces(path: Path) -> dict:
    parts = parts_of(path)
    body = parts.get("word/document.xml", b"")
    return {
        "part": "word/comments.xml" in parts,
        "override": b"comments+xml" in parts.get("[Content_Types].xml", b""),
        "relationship": b"/comments\"" in parts.get("word/_rels/document.xml.rels", b""),
        "range_starts": body.count(b"commentRangeStart"),
        "range_ends": body.count(b"commentRangeEnd"),
        "references": body.count(b"<w:commentReference"),
    }


def bare_document(src: Path, dst: Path) -> None:
    """report.docx with its comments part and all five of its pieces removed."""
    def mutate(name: str, data: bytes) -> bytes | None:
        if name == "word/comments.xml":
            return None
        if name == "[Content_Types].xml":
            return data.replace(
                b'<Override PartName="/word/comments.xml" ContentType="application/'
                b'vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>',
                b"")
        if name == "word/_rels/document.xml.rels":
            return data.replace(
                b'<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/'
                b'officeDocument/2006/relationships/comments" Target="comments.xml"/>',
                b"")
        if name == "word/document.xml":
            for junk in (b'<w:commentRangeStart w:id="1"/>',
                         b'<w:commentRangeEnd w:id="1"/>',
                         b'<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>'
                         b'<w:commentReference w:id="1"/></w:r>'):
                data = data.replace(junk, b"")
            return data
        return data
    rewrite_zip(src, dst, mutate)


def collect_comments(work: Path) -> dict:
    added = work / "commented.docx"
    a = run_script("docx_comment.py", "--in", REPORT, "--out", added,
                   "--add-on", COMMENT_ANCHOR_SPLIT, "--text", NEW_COMMENT,
                   "--author", "王审计", "--report", work / "comment.json")
    report = json.loads((work / "comment.json").read_text(encoding="utf-8"))

    bare = work / "bare.docx"
    bare_document(REPORT, bare)
    scratch = work / "scratch.docx"
    sc = run_script("docx_comment.py", "--in", bare, "--out", scratch,
                    "--add-on", "应收账款", "--text", "从零新建批注部件",
                    "--report", work / "scratch.json")

    gone = work / "gone.docx"
    dl = run_script("docx_comment.py", "--in", added, "--out", gone,
                    "--delete", "1", "--delete", "2", "--report", work / "gone.json")

    missing = run_script("docx_comment.py", "--in", REPORT, "--out", work / "nope.docx",
                         "--add-on", "文档里没有这句话", "--text", "x")
    listed = run_script("docx_comment.py", "--in", REPORT, "--list")
    return {
        "exit": a.returncode, "report": report,
        "pieces": comment_pieces(added),
        "before_pieces": comment_pieces(REPORT),
        "scratch": {"exit": sc.returncode,
                    "report": json.loads((work / "scratch.json")
                                         .read_text(encoding="utf-8")),
                    "pieces": comment_pieces(scratch)},
        "deleted": {"exit": dl.returncode,
                    "report": json.loads((work / "gone.json")
                                         .read_text(encoding="utf-8")),
                    "pieces": comment_pieces(gone)},
        "missing_anchor": {"exit": missing.returncode,
                           "stderr": missing.stderr.strip(),
                           "wrote": (work / "nope.docx").exists()},
        "list_exit": listed.returncode,
    }


def rpr_of_first_run(path: Path, paragraph_index: int) -> str | None:
    from lxml import etree
    paras = list(tree_of(path).iter(W + "p"))
    if paragraph_index >= len(paras):
        return None
    run = paras[paragraph_index].find(W + "r")
    rpr = run.find(W + "rPr") if run is not None else None
    return etree.tostring(rpr).decode() if rpr is not None else None


def header_text(path: Path) -> str:
    root = tree_of(path, "word/header1.xml")
    return "".join(t.text or "" for t in root.iter(W + "t"))


def appended_run_fonts(path: Path) -> dict:
    """The @ascii / @eastAsia of the run in the last body paragraph."""
    body = tree_of(path).find(W + "body")
    paras = [c for c in body if str(c.tag) == W + "p"]
    if not paras:
        return {}
    rfonts = paras[-1].find(f"{W}r/{W}rPr/{W}rFonts")
    if rfonts is None:
        return {}
    return {"ascii": rfonts.get(W + "ascii"), "eastAsia": rfonts.get(W + "eastAsia")}


def num_ids_of(path: Path) -> list[str]:
    return [n.get(W + "val") for n in tree_of(path).iter(W + "numId")]


def make_xlsx_like(path: Path) -> None:
    """A valid OOXML package that is not a Word document."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats'
                   '.org/package/2006/content-types"><Default Extension="xml" '
                   'ContentType="application/xml"/></Types>')
        z.writestr("xl/workbook.xml", '<?xml version="1.0"?><workbook/>')


def traversal_refused(work: Path) -> dict:
    """A part named to escape the unpack directory must be refused, not written."""
    evil = work / "evil.docx"
    def mutate(name: str, data: bytes) -> bytes:
        return data
    rewrite_zip(REPORT, evil, mutate)
    with zipfile.ZipFile(evil, "a", zipfile.ZIP_DEFLATED) as z:
        z.writestr("../escaped.xml", "<x/>")
    r = run_script("docx_package.py", "--in", evil, "--unpack", work / "evil-unpacked")
    return {"exit": r.returncode, "stderr": r.stderr.strip(),
            "escaped_written": (work / "escaped.xml").exists()}


# ── the assertions ────────────────────────────────────────────────────────────
CHECKS: dict[str, dict] = {}


def check(cid: str, title: str):
    def deco(fn):
        CHECKS[cid] = {"title": title, "fn": fn}
        return fn
    return deco


@check("V0", "the fixtures actually give every assertion something to look at")
def v0_not_vacuous(ctx: dict) -> list[str]:
    f = ctx["fixture"]
    out = []
    # If the phrase did NOT span runs, E1's whole point evaporates and the naive
    # control would agree with the real implementation.
    if f["phrase_runs"] < 2:
        out.append(f"V0 {CROSS_RUN!r} is stored in {f['phrase_runs']} run(s) in "
                   f"report.docx — the fixture no longer exercises the case this "
                   f"whole capability exists for")
    if f["naive_hits"] != NAIVE_HITS:
        out.append(f"V0 the per-run search found {f['naive_hits']} hit(s) for "
                   f"{CROSS_RUN!r}, expected {NAIVE_HITS} — the fixture no longer "
                   f"separates the two implementations by exactly the spanning "
                   f"occurrence, which is the whole comparison")
    for name in ("insertions", "deletions", "tables", "comments", "list_paragraphs",
                 "footer_fields"):
        if f[name] < 1:
            out.append(f"V0 report.docx carries no {name}; the assertions that read "
                       f"them have nothing to look at")
    if not f["custom_xml"]:
        out.append("V0 report.docx has no customXml part, so the fidelity claim has "
                   "nothing to lose")
    if f["header_footer_parts"] < 2:
        out.append("V0 report.docx has no header and footer pair")
    if f["parts"] != PARTS_TOTAL:
        out.append(f"V0 report.docx has {f['parts']} parts, the assertions are "
                   f"written for {PARTS_TOTAL}")
    if f["order_defects"] != ORDER_DEFECTS:
        out.append(f"V0 unordered.docx carries {f['order_defects']} order defect(s), "
                   f"expected {ORDER_DEFECTS} — the repair assertions are measuring a "
                   f"different fixture than they were written for")
    return out


# ── W1: reading ───────────────────────────────────────────────────────────────
@check("R1", "a phrase Word split across runs reads back as one string")
def r1_joined(ctx: dict) -> list[str]:
    paras = ctx["read"]["report"]["paragraphs"]
    match = [p for p in paras if p["text"] == SPLIT_PARAGRAPH]
    if not match:
        return [f"R1 no paragraph reads as {SPLIT_PARAGRAPH!r}; got "
                f"{[p['text'][:24] for p in paras[:4]]}"]
    # And it really was stored in several runs, or the join proved nothing.
    if match[0]["runs"] < 2:
        return [f"R1 that paragraph is stored in {match[0]['runs']} run(s), so joining "
                f"them was not the thing that made it readable"]
    return []


@check("R2", "tracked-deleted text is not reported as document text")
def r2_deleted(ctx: dict) -> list[str]:
    report = ctx["read"]["report"]
    out = []
    if any(DELETED in p["text"] for p in report["paragraphs"]):
        out.append(f"R2 {DELETED!r} was deleted with change tracking on and is being "
                   f"reported as document text — the document now says the opposite "
                   f"of what it says")
    deletions = report.get("revisions", {}).get("deletions", [])
    if not any(d["text"] == DELETED for d in deletions):
        out.append(f"R2 {DELETED!r} is not reported under revisions either, so it is "
                   f"simply invisible")
    if deletions and not deletions[0].get("author"):
        out.append("R2 a deletion is reported with no author — who made a change is "
                   "most of what a revision is")
    return out


@check("R3", "tracked-inserted text IS reported as document text")
def r3_inserted(ctx: dict) -> list[str]:
    report = ctx["read"]["report"]
    out = []
    if not any(INSERTED in p["text"] for p in report["paragraphs"]):
        out.append(f"R3 {INSERTED!r} is a tracked INSERTION — it is in the document, "
                   f"and it is missing from the reported text")
    # The measured contrast: python-docx itself gets this wrong, so agreeing with it
    # would mean the skill inherited the bug rather than avoided it.
    if any(INSERTED in t for t in ctx["read"]["python_docx_paragraph_texts"]):
        out.append("R3 python-docx now reports inserted text too, so this assertion "
                   "no longer distinguishes the two readers")
    return out


@check("R4", "tables come back as a grid, not as flattened text")
def r4_tables(ctx: dict) -> list[str]:
    tables = ctx["read"]["report"].get("table_contents") or []
    if not tables:
        return ["R4 no table contents were reported at all"]
    t = tables[0]
    out = []
    if t["rows"] < 3 or t["columns"] < 3:
        out.append(f"R4 the table is reported as {t['rows']}x{t['columns']}; the "
                   f"fixture's is 3x3")
    flat = [c for row in t["cells"] for c in row]
    if TABLE_CELL not in flat:
        out.append(f"R4 {TABLE_CELL!r} is not in any reported cell")
    if any(len(row) != t["columns"] for row in t["cells"]):
        out.append("R4 the reported rows are ragged — a grid whose rows have "
                   "different lengths cannot be indexed by column")
    return out


@check("R5", "list level, style and section structure are reported")
def r5_structure(ctx: dict) -> list[str]:
    report = ctx["read"]["report"]
    out = []
    listed = [p for p in report["paragraphs"] if p.get("list")]
    if not listed:
        out.append("R5 no paragraph is reported as belonging to a list, though the "
                   "fixture has two")
    elif not any(p["text"] == LIST_TEXT for p in listed):
        out.append(f"R5 the list paragraphs do not include {LIST_TEXT!r}")
    if "Heading1" not in report["styles_used"]:
        out.append("R5 the heading style is not reported as used")
    sections = report.get("sections") or []
    if not sections or not sections[0].get("headers"):
        out.append("R5 the section is reported without its header binding, so a "
                   "reader cannot tell the document has one")
    return out


@check("R6", "headers and footers are reported separately, fields named as fields")
def r6_headers(ctx: dict) -> list[str]:
    hf = ctx["read"]["report"].get("headers_and_footers") or []
    out = []
    if len(hf) != 2:
        out.append(f"R6 {len(hf)} header/footer part(s) reported, expected 2")
    header = next((h for h in hf if h.get("kind") == "header"), None)
    footer = next((h for h in hf if h.get("kind") == "footer"), None)
    if not header or HEADER_TEXT not in header.get("text", ""):
        out.append(f"R6 the header's text does not contain {HEADER_TEXT!r}")
    if not footer:
        out.append("R6 no footer was reported")
    elif footer.get("fields", 0) < 1:
        out.append("R6 the footer holds a PAGE field and no field is reported — the "
                   "cached '1' then reads as the footer's literal text, which is how "
                   "a reader concludes every page is page 1")
    return out


# ── W2: replacing ─────────────────────────────────────────────────────────────
@check("E1", "a phrase stored across runs is found, where the per-run search finds none")
def e1_cross_run(ctx: dict) -> list[str]:
    entry = ctx["replace"]["report"]["replacements"][0]
    out = []
    if entry["replaced"] != CROSS_RUN_TOTAL:
        out.append(f"E1 {entry['replaced']} occurrence(s) of {CROSS_RUN!r} replaced, "
                   f"expected {CROSS_RUN_TOTAL} (one inside a single run, one split "
                   f"across two)")
    if entry["cross_run"] != CROSS_RUN_SPANNING:
        out.append(f"E1 {entry['cross_run']} replacement(s) crossed a run boundary, "
                   f"expected {CROSS_RUN_SPANNING}")
    if ctx["fixture"]["naive_hits"] >= entry["replaced"]:
        out.append(f"E1 the per-run implementation found "
                   f"{ctx['fixture']['naive_hits']}, this one found "
                   f"{entry['replaced']} — they are not distinguishable, so this "
                   f"assertion is not measuring anything")
    return out


@check("E2", "the replacement is in the document text and the old phrase is gone")
def e2_text(ctx: dict) -> list[str]:
    texts = ctx["replace"]["texts"]
    out = []
    if not any(CROSS_RUN_NEW in t for t in texts):
        out.append(f"E2 {CROSS_RUN_NEW!r} is not in the document text")
    if any(CROSS_RUN in t for t in texts):
        out.append(f"E2 {CROSS_RUN!r} is still there — the report said it was "
                   f"replaced and the file disagrees")
    if not any(PLACEHOLDER_NEW in t for t in texts):
        out.append(f"E2 the second --replace never landed: no {PLACEHOLDER_NEW!r}")
    if any(PLACEHOLDER in t for t in texts):
        out.append(f"E2 {PLACEHOLDER!r} survived — a template that still shows its "
                   f"own placeholder is the failure this is for")
    return out


@check("E3", "only the parts that changed are rewritten")
def e3_surgical(ctx: dict) -> list[str]:
    r = ctx["replace"]
    out = []
    if r["report"]["parts_changed"] != ["word/document.xml"]:
        out.append(f"E3 the edit rewrote {r['report']['parts_changed']}; a text "
                   f"replacement has business in exactly one part")
    if len(r["parts_after"]) != PARTS_TOTAL:
        out.append(f"E3 the output has {len(r['parts_after'])} parts, the input had "
                   f"{PARTS_TOTAL} — something was dropped or invented")
    if len(r["identical"]) != PARTS_TOTAL - 1:
        lost = sorted(set(r["parts_before"]) - set(r["identical"]))
        out.append(f"E3 {len(r['identical'])}/{PARTS_TOTAL} parts came through "
                   f"byte-identical; these did not: {lost}")
    if r["rpr_before"] != r["rpr_after"]:
        out.append("E3 the run's properties changed — a text replacement that resets "
                   "the font binding is how Chinese turns into tofu two steps later")
    return out


@check("E4", "a phrase broken by a line break is not silently matched, and is named")
def e4_near_miss(ctx: dict) -> list[str]:
    rep = ctx["near_miss"]["report"]
    entry = rep["replacements"][0]
    out = []
    if entry["replaced"] != 0:
        out.append(f"E4 {entry['replaced']} replacement(s) across a line break — the "
                   f"break was treated as if it were not there, which silently "
                   f"reflows the paragraph")
    near = entry.get("near_misses") or []
    if not near:
        out.append("E4 nothing matched and the report does not say why; '0 "
                   "replacements' with no reason is the answer that wastes an "
                   "afternoon")
    elif not any("三季度营业收入" in str(n) for n in near):
        out.append(f"E4 the near miss does not name the phrase it nearly matched: "
                   f"{near}")
    return out


@check("E5", "an edit that lands inside tracked content says so")
def e5_revision_context(ctx: dict) -> list[str]:
    entry = ctx["revision_edit"]["report"]["replacements"][0]
    out = []
    if entry["replaced"] != 1:
        out.append(f"E5 {entry['replaced']} replacement(s) inside the tracked "
                   f"insertion, expected 1")
    if "ins" not in (entry.get("contexts") or []):
        out.append("E5 the replacement happened inside a <w:ins> and the report does "
                   "not mention it — rewriting somebody's tracked change without "
                   "saying so is the one thing a reviewer must not discover later")
    return out


@check("E6", "--in-headers reaches header parts, and only when asked")
def e6_headers(ctx: dict) -> list[str]:
    out = []
    if "公开资料" not in ctx["headers"]["header_text"]:
        out.append("E6 --in-headers did not reach word/header1.xml")
    changed = ctx["headers"]["report"]["parts_changed"]
    if "word/header1.xml" not in changed:
        out.append(f"E6 the report does not list the header as changed: {changed}")
    # Control: without the flag the header's TEXT must be untouched, or --in-headers
    # is decoration. Measured on the header rather than on the part list, because
    # "which parts were rewritten" is E3's question and sharing it would make one
    # defect light two checks.
    if ctx["replace"]["header_text"] != HEADER_TEXT:
        out.append(f"E6 a replacement WITHOUT --in-headers changed the header text to "
                   f"{ctx['replace']['header_text']!r}; the flag decides nothing")
    return out


# ── W3: appending ─────────────────────────────────────────────────────────────
@check("A1", "an appended paragraph lands before <w:sectPr>, which stays last")
def a1_sectpr(ctx: dict) -> list[str]:
    kids = ctx["append"]["body_children"]
    out = []
    if not kids or kids[-1] != "sectPr":
        out.append(f"A1 the body ends with {kids[-1:] or ['nothing']}, not <w:sectPr> "
                   f"— Word repairs such a file by discarding the section, and with "
                   f"it the page size, margins and header bindings")
    if APPEND_TEXT not in ctx["append"]["texts"]:
        out.append(f"A1 the appended paragraph is not in the document text")
    if not ctx["append"]["section_survives"]:
        out.append("A1 the section properties are gone from the body entirely")
    return out


@check("A2", "--list is refused when there is no list to join, and works when there is")
def a2_list(ctx: dict) -> list[str]:
    without = ctx["append"]["list_without_numbering"]
    with_ = ctx["append"]["list_with_numbering"]
    out = []
    if without["exit"] != 2:
        out.append(f"A2 --list on a document with no numbering.xml exited "
                   f"{without['exit']}; a numPr pointing at a definition that does "
                   f"not exist is a paragraph Word renders without its number")
    if without["wrote"]:
        out.append("A2 it refused and wrote the file anyway")
    if "numbering" not in without["stderr"]:
        out.append(f"A2 the refusal does not say what is missing: {without['stderr']!r}")
    if with_["exit"] != 0:
        out.append(f"A2 --list on a document that HAS numbering.xml exited "
                   f"{with_['exit']} — the guard is refusing everything")
    elif with_["num_ids"].count("1") < 3:
        out.append(f"A2 the appended paragraph did not join list 1: numIds are "
                   f"{with_['num_ids']}")
    return out


@check("A3", "a Chinese paragraph this skill writes binds both font faces")
def a3_fonts(ctx: dict) -> list[str]:
    fonts = ctx["append"]["fonts"]
    out = []
    if not fonts.get("eastAsia"):
        out.append("A3 the appended run has no @w:eastAsia; Word then picks the CJK "
                   "face from the theme and the same file renders differently on "
                   "another machine")
    if not fonts.get("ascii"):
        out.append("A3 the appended run has no @w:ascii, so mixed '2026 年' text "
                   "renders in two unrelated typefaces")
    return out


# ── W13: unpack / pack ────────────────────────────────────────────────────────
@check("P1", "the round trip gives back every part, byte for byte")
def p1_roundtrip(ctx: dict) -> list[str]:
    p = ctx["package"]
    out = []
    if p["identical"] != PARTS_TOTAL:
        out.append(f"P1 {p['identical']}/{PARTS_TOTAL} parts came back identical")
    if p["report"].get("parts_lost"):
        out.append(f"P1 parts lost in the round trip: {p['report']['parts_lost']}")
    if not p["report"].get("order_preserved"):
        out.append("P1 the report itself says the part order changed")
    return out


@check("P2", "the part order survives, and the manifest is what makes it survive")
def p2_order(ctx: dict) -> list[str]:
    p = ctx["package"]
    out = []
    if p["order_after"] != p["order_before"]:
        out.append(f"P2 part order changed: {p['order_after'][:3]} vs "
                   f"{p['order_before'][:3]}")
    # Control: without the manifest the order is the filesystem's, not the
    # document's. If the two agree, the manifest is not the thing preserving it.
    without = p["without_manifest_order"]
    if without and without == p["order_before"]:
        out.append("P2 packing WITHOUT the manifest produced the same order, so this "
                   "assertion cannot tell whether the manifest does anything")
    return out


@check("P3", "a part added between unpack and pack is kept")
def p3_added(ctx: dict) -> list[str]:
    added = ctx["package"]["added_part"]
    if added["exit"] != 0:
        return [f"P3 packing a directory with a hand-added part exited {added['exit']}"]
    if not added["present"]:
        return ["P3 the added part is not in the packed file — editing a part is the "
                "entire reason to unpack one"]
    return []


@check("P4", "a part name that escapes the target directory is refused")
def p4_traversal(ctx: dict) -> list[str]:
    t = ctx["package"]["traversal"]
    out = []
    if t["escaped_written"]:
        out.append("P4 a part named ../escaped.xml was written outside the unpack "
                   "directory")
    if t["exit"] == 0:
        out.append("P4 the unpack reported success on a package carrying a traversal "
                   "part name")
    elif "escapes" not in t["stderr"]:
        out.append(f"P4 the refusal does not say why: {t['stderr']!r}")
    return out


# ── W15: element order ────────────────────────────────────────────────────────
@check("O1", "the unordered input really is rejected, by name, all three times")
def o1_input_rejected(ctx: dict) -> list[str]:
    o = ctx["order"]
    out = []
    if o["check_exit"] != 2:
        out.append(f"O1 --check exited {o['check_exit']} on a document with "
                   f"{ORDER_DEFECTS} order defects")
    findings = " ".join(o["check_findings"])
    for element in ("pPr", "rPr", "sectPr"):
        if element not in findings:
            out.append(f"O1 the check does not name <w:{element}> — a repair whose "
                       f"input was never shown to be broken proves nothing")
    return out


@check("O2", "--fix-order repairs every one of them and the output passes")
def o2_repaired(ctx: dict) -> list[str]:
    o = ctx["order"]
    out = []
    if o["fix_exit"] != 0:
        out.append(f"O2 --fix-order exited {o['fix_exit']}")
    fixes = o["fix_report"].get("fixes") or []
    moved = sum(f["elements_reordered"] for f in fixes)
    if moved != ORDER_DEFECTS:
        out.append(f"O2 {moved} element(s) reordered, expected {ORDER_DEFECTS}")
    if o["after_findings"]:
        out.append(f"O2 the repaired document still has: {o['after_findings']}")
    if o["after_exit"] != 0:
        out.append(f"O2 --check on the repaired document exited {o['after_exit']}")
    return out


@check("O3", "the repair moves elements and changes nothing else")
def o3_nothing_else(ctx: dict) -> list[str]:
    o = ctx["order"]
    out = []
    if o["text_after"] != o["text_before"]:
        out.append("O3 the document's text changed while its element order was being "
                   "repaired")
    if o["other_parts_identical"] != o["other_parts_total"]:
        out.append(f"O3 {o['other_parts_identical']}/{o['other_parts_total']} of the "
                   f"other parts are byte-identical; a reordering has business in "
                   f"word/document.xml alone")
    return out


# ── contracts ─────────────────────────────────────────────────────────────────
@check("C1", "stdout stays a summary on a long document")
def c1_stdout(ctx: dict) -> list[str]:
    c = ctx["contracts"]
    out = []
    if c["stdout_exit"] != 0:
        out.append(f"C1 reading a {SCALE_PARAGRAPHS}-paragraph document exited "
                   f"{c['stdout_exit']}")
    if c["stdout_bytes"] > STDOUT_BUDGET:
        out.append(f"C1 stdout was {c['stdout_bytes']} bytes for a "
                   f"{SCALE_PARAGRAPHS}-paragraph document (budget {STDOUT_BUDGET}); "
                   f"an agent pays for every one of them, twice under delegation")
    if c["stdout_bytes"] < 200:
        out.append("C1 stdout is nearly empty — trimming that drops the answer is not "
                   "trimming")
    return out


@check("C3", "a report with FEW but enormous entries is trimmed too")
def c3_byte_budget(ctx: dict) -> list[str]:
    c = ctx["contracts"]
    out = []
    if c["tall_exit"] != 0:
        out.append(f"C3 reading a {SCALE_TABLE_ROWS}-row table exited {c['tall_exit']}")
    if c["tall_stdout_bytes"] > STDOUT_BUDGET:
        out.append(f"C3 one table printed {c['tall_stdout_bytes']} bytes to stdout "
                   f"(budget {STDOUT_BUDGET}). The item-count trimmer cannot see this "
                   f"shape: the list has ONE entry")
    # The over-correction is its own defect: a trimmer that also removes the answer
    # is not a trimmer. The report must still say a table is there and how big.
    if "table_contents_count" not in c["tall_stdout"]:
        out.append("C3 the trimmed report does not say how many tables it dropped, "
                   "so the reader cannot tell a huge table from no table")
    if c["tall_stdout_bytes"] < 300:
        out.append(f"C3 stdout is {c['tall_stdout_bytes']} bytes — the trimming took "
                   f"the answer with it")
    return out


@check("C2", "bad inputs get one sentence, not a traceback")
def c2_contracts(ctx: dict) -> list[str]:
    c = ctx["contracts"]
    out = []
    if c["in_place"]["exit"] != 2 or "same file" not in c["in_place"]["stderr"]:
        out.append(f"C2 writing --out over --in was not refused clearly: "
                   f"{c['in_place']}")
    if c["missing"]["exit"] != 2 or c["missing"]["traceback"]:
        out.append(f"C2 a missing file produced exit {c['missing']['exit']}"
                   + (" with a traceback" if c["missing"]["traceback"] else ""))
    if c["wrong_kind"]["exit"] != 2 or c["wrong_kind"]["traceback"]:
        out.append(f"C2 an OOXML package that is not a Word document produced exit "
                   f"{c['wrong_kind']['exit']}"
                   + (" with a traceback" if c["wrong_kind"]["traceback"] else ""))
    elif "not a Word document" not in c["wrong_kind"]["stderr"]:
        out.append(f"C2 the refusal does not say what is wrong with the file: "
                   f"{c['wrong_kind']['stderr']!r}")
    return out


@check("F0", "the committed fixtures are byte-reproducible")
def f0_reproducible(ctx: dict) -> list[str]:
    f = ctx["fixtures"]
    if f["exit"] != 0:
        return [f"F0 make_fixtures.py exited {f['exit']}"]
    bad = [n for n, ok in f["identical"].items() if not ok]
    if bad:
        return [f"F0 regenerating produced different bytes for {bad} — every file "
                f"under skills/builtin/ feeds .builtin-version, so a fixture that is "
                f"not reproducible reinstalls the built-in skills on every desktop "
                f"whenever anyone reruns the generator"]
    return []



# ── W5: template fill ─────────────────────────────────────────────────────────
@check("T1", "a placeholder Word split across runs is filled")
def t1_cross_run(ctx: dict) -> list[str]:
    filled = {e["name"]: e for e in ctx["template"]["report"]["filled"]}
    out = []
    e = filled.get(FILL_SPLIT)
    if not e or e["replaced"] != 1:
        out.append(f"T1 {FILL_SPLIT!r} was filled {e['replaced'] if e else 0} time(s), "
                   f"expected 1")
    elif e["cross_run"] != 1:
        out.append(f"T1 the fill did not cross a run boundary, so the template's "
                   f"split placeholder is not what was matched")
    if any("{{" + FILL_SPLIT + "}}" in t for t in ctx["template"]["texts"]):
        out.append(f"T1 the document still says {{{{{FILL_SPLIT}}}}}")
    return out


@check("T2", "a placeholder left unfilled is named, not shipped in silence")
def t2_unfilled(ctx: dict) -> list[str]:
    report = ctx["template"]["report"]
    names = [p["name"] for p in report["unfilled"]]
    out = []
    if FILL_LEFT not in names:
        out.append(f"T2 {FILL_LEFT!r} is still in the document and is not in "
                   f"`unfilled` ({names}) — a contract going out with a hole in it "
                   f"and nothing saying so")
    if not report.get("warning"):
        out.append("T2 placeholders remain and the report carries no warning")
    return out


@check("T3", "a supplied value that matched nothing is named")
def t3_unused(ctx: dict) -> list[str]:
    unused = ctx["template"]["report"]["unused_values"]
    if FILL_TYPO not in unused:
        return [f"T3 {FILL_TYPO!r} matched no placeholder and is not reported as "
                f"unused ({unused}); a typo in the key is otherwise indistinguishable "
                f"from 'that placeholder is not in this template'"]
    return []


@check("T4", "--strict refuses and writes nothing")
def t4_strict(ctx: dict) -> list[str]:
    st = ctx["template"]["strict"]
    out = []
    if st["exit"] != 2:
        out.append(f"T4 --strict with two placeholders left over exited {st['exit']}")
    if st["wrote"]:
        out.append("T4 --strict refused and wrote the file anyway")
    if "placeholder" not in st["stderr"]:
        out.append(f"T4 the refusal does not say what is unfilled: {st['stderr']!r}")
    return out


@check("T5", "placeholders in the header are filled too")
def t5_header(ctx: dict) -> list[str]:
    filled = {e["name"]: e for e in ctx["template"]["report"]["filled"]}
    out = []
    e = filled.get(FILL_HEADER)
    if not e or not any("header" in p for p in e["parts"]):
        out.append(f"T5 {FILL_HEADER!r} lives in word/header1.xml and was not filled "
                   f"there — half of a real template's placeholders are in the "
                   f"letterhead")
    if "{{" in ctx["template"]["header_text"]:
        out.append(f"T5 the header still reads {ctx['template']['header_text']!r}")
    return out


# ── W17: render ───────────────────────────────────────────────────────────────
@check("Y1", "the document renders to a PDF with ink on it")
def y1_render(ctx: dict) -> list[str]:
    p = ctx["pdf"]
    if p.get("skipped"):
        return []
    out = []
    if p["exit"] != 0 or not p["produced"]:
        out.append(f"Y1 the conversion exited {p['exit']} / produced="
                   f"{p['produced']}")
    r = p["report"]
    if r.get("pages", 0) < 1:
        out.append(f"Y1 the PDF has {r.get('pages')} page(s)")
    if r.get("blank_pages"):
        out.append(f"Y1 page(s) {r['blank_pages']} carry no ink")
    if p["images"] < 1:
        out.append("Y1 --png was asked for and no image was written; a preview that "
                   "silently produces nothing is the failure this refuses")
    return out


@check("Y2", "a document that renders blank is refused, not handed back as a preview")
def y2_blank(ctx: dict) -> list[str]:
    p = ctx["pdf"]
    if p.get("skipped"):
        return []
    b = p["blank"]
    out = []
    if b["exit"] != 2:
        out.append(f"Y2 rendering an empty document exited {b['exit']}; a blank "
                   f"preview looks exactly like lost content")
    if b["wrote"]:
        out.append("Y2 it refused and left the PDF on disk anyway")
    if "no ink" not in b["stderr"]:
        out.append(f"Y2 the refusal does not say why: {b['stderr']!r}")
    return out


@check("Y3", "pending revisions and cached fields are named, not rendered in silence")
def y3_warnings(ctx: dict) -> list[str]:
    p = ctx["pdf"]
    if p.get("skipped"):
        return []
    r = p["report"]
    out = []
    if not r.get("warning"):
        out.append("Y3 the document has tracked changes and the report says nothing — "
                   "the PDF shows one resolution of them, which is not the document "
                   "anyone has approved")
    if not r.get("fields_note"):
        out.append("Y3 the footer's PAGE field renders from its CACHED result and the "
                   "report does not say so")
    return out



# ── W6: making tracked changes ────────────────────────────────────────────────
@check("K1", "a cross-run phrase is tracked as ONE deletion plus one insertion")
def k1_tracked_replace(ctx: dict) -> list[str]:
    r = ctx["revise"]
    out = []
    if r["exit"] != 0:
        out.append(f"K1 the tracked replace exited {r['exit']}")
    dels = [e for e in r["elements"] if e["kind"] == "del" and not e["paragraph_mark"]]
    ins = [e for e in r["elements"] if e["kind"] == "ins" and not e["paragraph_mark"]]
    mine_d = [e for e in dels if e["author"] == REVISER]
    mine_i = [e for e in ins if e["author"] == REVISER]
    if len(mine_d) != CROSS_RUN_TOTAL or len(mine_i) != CROSS_RUN_TOTAL:
        out.append(f"K1 {len(mine_d)} deletion(s) and {len(mine_i)} insertion(s) by "
                   f"{REVISER}, expected {CROSS_RUN_TOTAL} of each")
    split = [e for e in mine_d if e["runs"] > 1]
    if not split:
        out.append("K1 no deletion wraps more than one run — the phrase that spans "
                   "two runs was not split out and wrapped as a unit, which is the "
                   "case this capability exists for")
    if any(e["text"] != CROSS_RUN for e in mine_d):
        out.append(f"K1 a deletion holds {[e['text'] for e in mine_d]}, expected "
                   f"{CROSS_RUN!r} — the wrapping took the wrong characters")
    if any(e["holds_wt"] for e in mine_d):
        out.append("K1 a <w:del> holds <w:t>; deleted text must be <w:delText> or "
                   "Word treats the file as damaged")
    ids = [e["id"] for e in r["elements"]]
    if len(ids) != len(set(ids)):
        out.append(f"K1 revision ids are not unique: {ids}")
    if any(not e["author"] or not e["date"] for e in r["elements"]):
        out.append("K1 a revision carries no author or no date — who changed what is "
                   "most of what a revision is")
    return out


# ── W7: resolving them ────────────────────────────────────────────────────────
@check("K2", "accept applies the change, reject restores the original text")
def k2_round_trip(ctx: dict) -> list[str]:
    r = ctx["revise"]
    out = []
    i = TRACKED_PARAGRAPH
    if CROSS_RUN_NEW not in r["accept"]["texts"][i]:
        out.append(f"K2 accepting left {r['accept']['texts'][i]!r}, which does not "
                   f"carry {CROSS_RUN_NEW!r}")
    if r["reject"]["texts"][i] != r["original_texts"][i]:
        out.append(f"K2 rejecting left {r['reject']['texts'][i]!r}, not the original "
                   f"{r['original_texts'][i]!r} — a rejected change must leave the "
                   f"document exactly as it was")
    # The fixture's OWN revision resolves too, in opposite directions. Blanket
    # equality with the original would be the wrong assertion here and it is worth
    # saying why: reject-all resolves the pre-existing revision as well, correctly.
    if r["accept"]["texts"][REVISION_PARAGRAPH] != ACCEPTED_REVISION:
        out.append(f"K2 accepting the fixture's own revision gave "
                   f"{r['accept']['texts'][REVISION_PARAGRAPH]!r}, expected "
                   f"{ACCEPTED_REVISION!r}")
    if r["reject"]["texts"][REVISION_PARAGRAPH] != REJECTED_REVISION:
        out.append(f"K2 rejecting the fixture's own revision gave "
                   f"{r['reject']['texts'][REVISION_PARAGRAPH]!r}, expected "
                   f"{REJECTED_REVISION!r} — the deleted text must come back")
    return out


@check("K3", "an inserted paragraph carries BOTH marks, so rejecting removes it whole")
def k3_paragraph_mark(ctx: dict) -> list[str]:
    ins = ctx["revise"]["inserted"]
    out = []
    marks = [e for e in ins["elements"] if e["paragraph_mark"]]
    if not marks:
        out.append("K3 the appended paragraph's MARK is not marked as inserted; "
                   "rejecting then removes the text and leaves an empty paragraph")
    original = len(ctx["revise"]["original_texts"])
    if len(ins["accepted"]) != original + 1 or ins["accepted"][-1] != INSERTED_PARAGRAPH:
        out.append(f"K3 accepting gave {len(ins['accepted'])} paragraph(s) ending "
                   f"{ins['accepted'][-1:]!r}, expected {original + 1} ending with "
                   f"the inserted text")
    if len(ins["rejected"]) != original:
        out.append(f"K3 rejecting gave {len(ins['rejected'])} paragraph(s), expected "
                   f"{original} — an empty paragraph was left behind")
    return out


@check("K4", "accepting by author leaves the other author's revisions alone")
def k4_by_author(ctx: dict) -> list[str]:
    b = ctx["revise"]["by_author"]
    out = []
    if b["exit"] != 0:
        out.append(f"K4 --accept-author exited {b['exit']}")
    mine = [e for e in b["elements"] if e["author"] == REVISER]
    theirs = [e for e in b["elements"] if e["author"] == FIXTURE_AUTHOR]
    if mine:
        out.append(f"K4 {len(mine)} revision(s) by {REVISER} survived a filter that "
                   f"named that author")
    if not theirs:
        out.append(f"K4 {FIXTURE_AUTHOR}'s revisions are gone too — a per-author "
                   f"filter that resolves everything is not a filter")
    return out


@check("K5", "leftovers are reported, and --strict refuses to write them")
def k5_remaining(ctx: dict) -> list[str]:
    r = ctx["revise"]
    b = r["by_author"]
    out = []
    if r["accept"]["report"].get("remaining"):
        out.append(f"K5 accept-all left {r['accept']['report']['remaining']} behind "
                   f"and still reported success")
    if r["accept"]["elements"]:
        out.append(f"K5 accept-all wrote a document that still holds "
                   f"{len(r['accept']['elements'])} revision element(s)")
    if "remaining" not in r["accept"]["report"]:
        out.append("K5 the report has no `remaining` field, so a form the resolver "
                   "does not handle would be indistinguishable from success")
    if not b["report"].get("remaining"):
        out.append("K5 a per-author pass left revisions behind and did not say so")
    if b["strict_exit"] != 2 or b["strict_wrote"]:
        out.append(f"K5 --strict with leftovers exited {b['strict_exit']} "
                   f"(wrote={b['strict_wrote']})")
    return out


@check("K6", "text inserted and then deleted disappears whichever way it is resolved")
def k6_nested(ctx: dict) -> list[str]:
    n = ctx["revise"]["nested"]
    out = []
    nested = [e for e in n["elements"] if e["kind"] == "del"
              and e["text"] == CROSS_RUN_NEW]
    if not nested:
        out.append(f"K6 deleting the tracked insertion did not produce a deletion "
                   f"holding {CROSS_RUN_NEW!r}")
    i = TRACKED_PARAGRAPH
    if CROSS_RUN_NEW in n["accepted"][i]:
        out.append(f"K6 accepting left {CROSS_RUN_NEW!r} in place; it was inserted "
                   f"and then deleted, so accepting both means it is gone")
    if CROSS_RUN_NEW in n["rejected"][i]:
        out.append(f"K6 rejecting left {CROSS_RUN_NEW!r} in place; rejecting the "
                   f"insertion removes it whatever happened inside")
    return out


# ── W8: comments ──────────────────────────────────────────────────────────────
@check("B1", "adding a comment writes all five pieces, anchored across runs")
def b1_add(ctx: dict) -> list[str]:
    c = ctx["comment"]
    out = []
    if c["exit"] != 0:
        out.append(f"B1 adding a comment exited {c['exit']}")
    added = c["report"].get("added") or {}
    if not added.get("cross_run"):
        out.append(f"B1 the anchor {COMMENT_ANCHOR_SPLIT!r} spans two runs in the "
                   f"fixture and the comment did not report a cross-run anchor")
    if added.get("runs_wrapped", 0) < 2:
        out.append("B1 the range wraps a single run, so the split phrase was not "
                   "isolated — a range marker cannot start mid-run")
    p, before = c["pieces"], c["before_pieces"]
    for piece in ("part", "override", "relationship"):
        if not p[piece]:
            out.append(f"B1 the {piece} is missing from the result")
    for piece in ("range_starts", "range_ends", "references"):
        if p[piece] != before[piece] + 1:
            out.append(f"B1 {piece} went {before[piece]} -> {p[piece]}, expected one "
                       f"more")
    return out


@check("B2", "a document with no comments part gets one, wired up")
def b2_from_scratch(ctx: dict) -> list[str]:
    sc = ctx["comment"]["scratch"]
    out = []
    if sc["exit"] != 0:
        out.append(f"B2 adding to a document with no comments part exited {sc['exit']}")
    created = (sc["report"].get("added") or {}).get("package_pieces_created") or []
    for piece in ("part", "content-type Override", "relationship"):
        if piece not in created:
            out.append(f"B2 the report does not say it created the {piece}")
    for piece in ("part", "override", "relationship"):
        if not sc["pieces"][piece]:
            out.append(f"B2 the {piece} is missing — a comments part nothing points "
                       f"at is a comment Word never shows")
    return out


@check("B3", "deleting the last comment takes the part and both its indexes")
def b3_delete(ctx: dict) -> list[str]:
    d = ctx["comment"]["deleted"]
    out = []
    if d["exit"] != 0:
        out.append(f"B3 deleting exited {d['exit']}")
    rep = d["report"].get("deleted") or {}
    if sorted(rep.get("removed") or []) != ["1", "2"]:
        out.append(f"B3 removed {rep.get('removed')}, expected both comments")
    if not rep.get("comments_part_dropped"):
        out.append("B3 the last comment is gone and word/comments.xml is still there")
    for piece in ("part", "override", "relationship"):
        if d["pieces"][piece]:
            out.append(f"B3 the {piece} survived — removing only the bytes leaves a "
                       f"package pointing at nothing")
    for piece in ("range_starts", "range_ends", "references"):
        if d["pieces"][piece] != 0:
            out.append(f"B3 {d['pieces'][piece]} {piece} left in the body, anchored "
                       f"to a comment that no longer exists")
    return out


@check("B4", "a comment anchored to text that is not there is refused")
def b4_missing_anchor(ctx: dict) -> list[str]:
    m = ctx["comment"]["missing_anchor"]
    out = []
    if m["exit"] != 2:
        out.append(f"B4 anchoring to absent text exited {m['exit']}; a comment with "
                   f"no anchor is a balloon Word draws next to the wrong paragraph")
    if m["wrote"]:
        out.append("B4 it refused and wrote the file anyway")
    if "does not appear" not in m["stderr"]:
        out.append(f"B4 the refusal does not say why: {m['stderr']!r}")
    return out


@check("B5", "the listing says whether each comment is still anchored")
def b5_listing(ctx: dict) -> list[str]:
    c = ctx["comment"]
    out = []
    if c["list_exit"] != 0:
        out.append(f"B5 --list exited {c['list_exit']}")
    listing = c["report"].get("comments") or []
    if len(listing) != 2:
        out.append(f"B5 {len(listing)} comment(s) listed after adding one to a "
                   f"document that had one")
    if not all(e.get("anchored") for e in listing):
        out.append("B5 a comment is reported as unanchored when both have ranges")
    if not all(e.get("author") and e.get("text") for e in listing):
        out.append("B5 a comment is listed without its author or its text")
    return out


# ── the negative controls ─────────────────────────────────────────────────────
# Each one is a defect an assertion above claims to catch, applied to the collected
# context. They are the implementations somebody reaches for first, not invented
# damage.

def flaw_replace_run_by_run(ctx, work):
    """THE defect: iterate paragraph.runs and call str.replace on each.

    The replaced count is the number that implementation really produces on this
    file (measured, 0), not a number chosen to make the assertion fire.
    """
    r = copy.deepcopy(ctx["replace"])
    entry = r["report"]["replacements"][0]
    entry["replaced"] = ctx["fixture"]["naive_hits"]
    entry["cross_run"] = 0
    r["texts"] = [t.replace(CROSS_RUN_NEW, CROSS_RUN) for t in r["texts"]]
    ctx["replace"] = r
    return ctx


def flaw_replace_reports_more_than_it_did(ctx, work):
    r = copy.deepcopy(ctx["replace"])
    r["report"]["replacements"][0]["replaced"] = 5
    ctx["replace"] = r
    return ctx


def flaw_replace_leaves_the_old_text(ctx, work):
    r = copy.deepcopy(ctx["replace"])
    r["texts"] = [t.replace(CROSS_RUN_NEW, CROSS_RUN) for t in r["texts"]]
    ctx["replace"] = r
    return ctx


def flaw_replace_misses_the_placeholder(ctx, work):
    r = copy.deepcopy(ctx["replace"])
    r["texts"] = [t.replace(PLACEHOLDER_NEW, PLACEHOLDER) for t in r["texts"]]
    ctx["replace"] = r
    return ctx


def flaw_edit_rebuilds_the_package(ctx, work):
    """python-docx load→save keeps the parts but rewrites their bytes."""
    r = copy.deepcopy(ctx["replace"])
    r["identical"] = [n for n in r["identical"] if n.startswith("docProps")]
    r["report"]["parts_changed"] = sorted(set(r["parts_before"]) - set(r["identical"]))
    ctx["replace"] = r
    return ctx


def flaw_edit_drops_the_custom_xml(ctx, work):
    r = copy.deepcopy(ctx["replace"])
    r["parts_after"] = [n for n in r["parts_after"] if not n.startswith("customXml/")]
    r["identical"] = [n for n in r["identical"] if not n.startswith("customXml/")]
    ctx["replace"] = r
    return ctx


def flaw_edit_resets_the_run_font(ctx, work):
    r = copy.deepcopy(ctx["replace"])
    r["rpr_after"] = "<w:rPr/>"
    ctx["replace"] = r
    return ctx


def flaw_replace_ignores_line_breaks(ctx, work):
    n = copy.deepcopy(ctx["near_miss"])
    n["report"]["replacements"][0]["replaced"] = 1
    ctx["near_miss"] = n
    return ctx


def flaw_near_miss_reported_as_plain_zero(ctx, work):
    n = copy.deepcopy(ctx["near_miss"])
    n["report"]["replacements"][0]["near_misses"] = []
    ctx["near_miss"] = n
    return ctx


def flaw_revision_edit_says_nothing(ctx, work):
    r = copy.deepcopy(ctx["revision_edit"])
    r["report"]["replacements"][0]["contexts"] = []
    ctx["revision_edit"] = r
    return ctx


def flaw_headers_always_edited(ctx, work):
    """The flag is decoration: header parts are edited whether or not it was passed."""
    r = copy.deepcopy(ctx["replace"])
    r["header_text"] = HEADER_TEXT.replace("内部资料", "公开资料")
    ctx["replace"] = r
    return ctx


def flaw_in_headers_does_nothing(ctx, work):
    h = copy.deepcopy(ctx["headers"])
    h["header_text"] = HEADER_TEXT
    h["report"]["parts_changed"] = ["word/document.xml"]
    ctx["headers"] = h
    return ctx


def flaw_append_after_sectpr(ctx, work):
    """`body.append(p)` — the natural implementation, and an invalid document."""
    a = copy.deepcopy(ctx["append"])
    kids = [k for k in a["body_children"] if k != "sectPr"]
    a["body_children"] = kids[:-1] + ["sectPr", "p"]
    ctx["append"] = a
    return ctx


def flaw_append_drops_the_section(ctx, work):
    a = copy.deepcopy(ctx["append"])
    a["body_children"] = [k for k in a["body_children"] if k != "sectPr"]
    a["section_survives"] = False
    ctx["append"] = a
    return ctx


def flaw_list_accepted_without_numbering(ctx, work):
    a = copy.deepcopy(ctx["append"])
    a["list_without_numbering"] = {"exit": 0, "stderr": "", "wrote": True}
    ctx["append"] = a
    return ctx


def flaw_list_refused_always(ctx, work):
    a = copy.deepcopy(ctx["append"])
    a["list_with_numbering"] = {"exit": 2, "num_ids": ["1"]}
    ctx["append"] = a
    return ctx


def flaw_appended_run_has_no_eastasia(ctx, work):
    a = copy.deepcopy(ctx["append"])
    a["fonts"] = {"ascii": "Calibri", "eastAsia": None}
    ctx["append"] = a
    return ctx


def flaw_pack_loses_a_part(ctx, work):
    p = copy.deepcopy(ctx["package"])
    p["identical"] -= 1
    p["report"]["parts_lost"] = ["customXml/item1.xml"]
    ctx["package"] = p
    return ctx


def flaw_pack_reorders(ctx, work):
    p = copy.deepcopy(ctx["package"])
    p["order_after"] = sorted(p["order_before"])
    p["report"]["order_preserved"] = False
    ctx["package"] = p
    return ctx


def flaw_manifest_makes_no_difference(ctx, work):
    """The control's control: if name order equals the recorded order, P2 is blind."""
    p = copy.deepcopy(ctx["package"])
    p["without_manifest_order"] = list(p["order_before"])
    ctx["package"] = p
    return ctx


def flaw_pack_drops_added_parts(ctx, work):
    p = copy.deepcopy(ctx["package"])
    p["added_part"] = {"exit": 0, "present": False}
    ctx["package"] = p
    return ctx


def flaw_unpack_trusts_part_names(ctx, work):
    p = copy.deepcopy(ctx["package"])
    p["traversal"] = {"exit": 0, "stderr": "", "escaped_written": True}
    ctx["package"] = p
    return ctx


def flaw_check_ignores_element_order(ctx, work):
    o = copy.deepcopy(ctx["order"])
    o["check_exit"] = 0
    o["check_findings"] = []
    ctx["order"] = o
    return ctx


def flaw_check_only_finds_sectpr(ctx, work):
    o = copy.deepcopy(ctx["order"])
    o["check_findings"] = [f for f in o["check_findings"] if "sectPr" in f]
    ctx["order"] = o
    return ctx


def flaw_fix_repairs_only_the_body(ctx, work):
    o = copy.deepcopy(ctx["order"])
    o["fix_report"]["fixes"] = [{"part": "word/document.xml",
                                 "elements_reordered": 1, "detail": []}]
    o["after_findings"] = ["word/document.xml: document/body[1]/p[1] has pPr out of "
                           "the ECMA-376 order"]
    o["after_exit"] = 2
    ctx["order"] = o
    return ctx


def flaw_fix_rewrites_the_text(ctx, work):
    o = copy.deepcopy(ctx["order"])
    o["text_after"] = [t.replace("第三季度", "") for t in o["text_after"]]
    ctx["order"] = o
    return ctx


def flaw_fix_rewrites_every_part(ctx, work):
    o = copy.deepcopy(ctx["order"])
    o["other_parts_identical"] = 0
    ctx["order"] = o
    return ctx


def flaw_stdout_dumps_every_paragraph(ctx, work):
    c = copy.deepcopy(ctx["contracts"])
    c["stdout_bytes"] = 400_000
    ctx["contracts"] = c
    return ctx


def flaw_trimming_drops_the_report(ctx, work):
    c = copy.deepcopy(ctx["contracts"])
    c["stdout_bytes"] = 12
    ctx["contracts"] = c
    return ctx


def flaw_tall_table_dumped_whole(ctx, work):
    """The defect as measured before the byte budget existed: 130,602 bytes."""
    c = copy.deepcopy(ctx["contracts"])
    c["tall_stdout_bytes"] = 130_602
    ctx["contracts"] = c
    return ctx


def flaw_byte_budget_drops_the_answer(ctx, work):
    """The over-correction: trimmed so hard the report no longer names the table."""
    c = copy.deepcopy(ctx["contracts"])
    c["tall_stdout"] = "{}"
    c["tall_stdout_bytes"] = 2
    ctx["contracts"] = c
    return ctx


def flaw_in_place_write_allowed(ctx, work):
    c = copy.deepcopy(ctx["contracts"])
    c["in_place"] = {"exit": 0, "stderr": ""}
    ctx["contracts"] = c
    return ctx


def flaw_missing_file_raises(ctx, work):
    c = copy.deepcopy(ctx["contracts"])
    c["missing"] = {"exit": 1, "stderr": "Traceback (most recent call last): ...",
                    "traceback": True}
    ctx["contracts"] = c
    return ctx


def flaw_xlsx_accepted_as_docx(ctx, work):
    c = copy.deepcopy(ctx["contracts"])
    c["wrong_kind"] = {"exit": 1, "stderr": "KeyError: 'word/document.xml'",
                       "traceback": True}
    ctx["contracts"] = c
    return ctx


def flaw_fixture_not_reproducible(ctx, work):
    f = copy.deepcopy(ctx["fixtures"])
    f["identical"]["report.docx"] = False
    ctx["fixtures"] = f
    return ctx


def flaw_reader_hands_back_runs(ctx, work):
    r = copy.deepcopy(ctx["read"])
    for p in r["report"]["paragraphs"]:
        if p["text"] == SPLIT_PARAGRAPH:
            p["text"] = "2026 年第"
    ctx["read"] = r
    return ctx


def flaw_reader_folds_in_deleted_text(ctx, work):
    r = copy.deepcopy(ctx["read"])
    for p in r["report"]["paragraphs"]:
        if "同比增长。" in p["text"]:
            p["text"] = p["text"].replace("同比增长。", DELETED + "同比增长。")
    ctx["read"] = r
    return ctx


def flaw_reader_drops_revisions_entirely(ctx, work):
    r = copy.deepcopy(ctx["read"])
    r["report"].pop("revisions", None)
    ctx["read"] = r
    return ctx


def flaw_reader_skips_inserted_text(ctx, work):
    """What python-docx itself does: walk direct <w:r> children only."""
    r = copy.deepcopy(ctx["read"])
    for p in r["report"]["paragraphs"]:
        p["text"] = p["text"].replace(INSERTED, "")
    ctx["read"] = r
    return ctx


def flaw_tables_flattened(ctx, work):
    r = copy.deepcopy(ctx["read"])
    r["report"]["table_contents"] = []
    ctx["read"] = r
    return ctx


def flaw_table_rows_ragged(ctx, work):
    r = copy.deepcopy(ctx["read"])
    r["report"]["table_contents"][0]["cells"][1] = ["营业收入"]
    ctx["read"] = r
    return ctx


def flaw_list_level_not_reported(ctx, work):
    r = copy.deepcopy(ctx["read"])
    for p in r["report"]["paragraphs"]:
        p.pop("list", None)
    ctx["read"] = r
    return ctx


def flaw_section_reported_without_bindings(ctx, work):
    r = copy.deepcopy(ctx["read"])
    for s in r["report"]["sections"]:
        s["headers"] = []
    ctx["read"] = r
    return ctx


def flaw_footer_field_read_as_text(ctx, work):
    r = copy.deepcopy(ctx["read"])
    for h in r["report"]["headers_and_footers"]:
        h["fields"] = 0
    ctx["read"] = r
    return ctx


def flaw_headers_not_reported(ctx, work):
    r = copy.deepcopy(ctx["read"])
    r["report"]["headers_and_footers"] = []
    ctx["read"] = r
    return ctx


def flaw_fixture_stops_splitting_runs(ctx, work):
    """CONTROL: the fixture stops exercising the case, so V0 must say so."""
    f = copy.deepcopy(ctx["fixture"])
    f["phrase_runs"] = 1
    f["naive_hits"] = CROSS_RUN_TOTAL
    ctx["fixture"] = f
    return ctx


def flaw_fixture_loses_its_custom_xml(ctx, work):
    f = copy.deepcopy(ctx["fixture"])
    f["custom_xml"] = False
    ctx["fixture"] = f
    return ctx


def flaw_fixture_stops_being_unordered(ctx, work):
    """CONTROL: unordered.docx stops carrying the defects the repair is judged on."""
    f = copy.deepcopy(ctx["fixture"])
    f["order_defects"] = 0
    ctx["fixture"] = f
    return ctx



def flaw_fill_only_walks_runs(ctx, work):
    """The scanner walks runs, so a split placeholder is invisible to it."""
    r = copy.deepcopy(ctx["template"])
    for e in r["report"]["filled"]:
        if e["name"] == FILL_SPLIT:
            e["replaced"], e["cross_run"] = 0, 0
    ctx["template"] = r
    return ctx


def flaw_fill_leaves_the_placeholder_visible(ctx, work):
    r = copy.deepcopy(ctx["template"])
    r["texts"] = [t.replace("示例科技有限公司", "{{" + FILL_SPLIT + "}}")
                  for t in r["texts"]]
    ctx["template"] = r
    return ctx


def flaw_unfilled_not_reported(ctx, work):
    r = copy.deepcopy(ctx["template"])
    r["report"]["unfilled"] = []
    r["report"].pop("warning", None)
    ctx["template"] = r
    return ctx


def flaw_unused_value_not_reported(ctx, work):
    r = copy.deepcopy(ctx["template"])
    r["report"]["unused_values"] = []
    ctx["template"] = r
    return ctx


def flaw_strict_writes_anyway(ctx, work):
    r = copy.deepcopy(ctx["template"])
    r["strict"] = {"exit": 0, "stderr": "", "wrote": True}
    ctx["template"] = r
    return ctx


def flaw_fill_skips_headers(ctx, work):
    r = copy.deepcopy(ctx["template"])
    for e in r["report"]["filled"]:
        if e["name"] == FILL_HEADER:
            e["parts"] = {}
            e["replaced"] = 0
    r["header_text"] = HEADER_TEXT
    ctx["template"] = r
    return ctx


def flaw_render_produces_nothing(ctx, work):
    p = copy.deepcopy(ctx["pdf"])
    if p.get("skipped"):
        return ctx
    p["produced"] = False
    p["exit"] = 0
    ctx["pdf"] = p
    return ctx


def flaw_render_skips_the_images(ctx, work):
    p = copy.deepcopy(ctx["pdf"])
    if p.get("skipped"):
        return ctx
    p["images"] = 0
    ctx["pdf"] = p
    return ctx


def flaw_blank_render_handed_back(ctx, work):
    p = copy.deepcopy(ctx["pdf"])
    if p.get("skipped"):
        return ctx
    p["blank"] = {"exit": 0, "stderr": "", "wrote": True}
    ctx["pdf"] = p
    return ctx


def flaw_revisions_rendered_in_silence(ctx, work):
    p = copy.deepcopy(ctx["pdf"])
    if p.get("skipped"):
        return ctx
    p["report"].pop("warning", None)
    ctx["pdf"] = p
    return ctx


def flaw_cached_field_rendered_in_silence(ctx, work):
    p = copy.deepcopy(ctx["pdf"])
    if p.get("skipped"):
        return ctx
    p["report"].pop("fields_note", None)
    ctx["pdf"] = p
    return ctx



def flaw_track_replaces_without_tracking(ctx, work):
    """The edit is made, but silently — no revision markup at all."""
    r = copy.deepcopy(ctx["revise"])
    r["elements"] = [e for e in r["elements"] if e["author"] != REVISER]
    ctx["revise"] = r
    return ctx


def flaw_track_wraps_one_run_only(ctx, work):
    """Only the occurrence that happens to sit in a single run is tracked."""
    r = copy.deepcopy(ctx["revise"])
    for e in r["elements"]:
        if e["author"] == REVISER:
            e["runs"] = 1
    ctx["revise"] = r
    return ctx


def flaw_del_keeps_wt(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    for e in r["elements"]:
        if e["kind"] == "del":
            e["holds_wt"] = True
    ctx["revise"] = r
    return ctx


def flaw_revision_ids_reused(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    for e in r["elements"]:
        e["id"] = "101"
    ctx["revise"] = r
    return ctx


def flaw_revision_without_author(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    r["elements"][0] = {**r["elements"][0], "author": None}
    ctx["revise"] = r
    return ctx


def flaw_accept_does_nothing(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    r["accept"]["texts"] = list(r["original_texts"])
    ctx["revise"] = r
    return ctx


def flaw_reject_keeps_the_new_text(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    r["reject"]["texts"] = list(r["accept"]["texts"])
    ctx["revise"] = r
    return ctx


def flaw_reject_drops_the_deleted_text(ctx, work):
    """Rejecting a deletion unwraps it but forgets to turn delText back into text."""
    r = copy.deepcopy(ctx["revise"])
    t = list(r["reject"]["texts"])
    t[REVISION_PARAGRAPH] = "本季度同比增长。"
    r["reject"]["texts"] = t
    ctx["revise"] = r
    return ctx


def flaw_paragraph_mark_not_tracked(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    r["inserted"]["elements"] = [e for e in r["inserted"]["elements"]
                                 if not e["paragraph_mark"]]
    ctx["revise"] = r
    return ctx


def flaw_reject_leaves_an_empty_paragraph(ctx, work):
    """The defect this repo actually had before paragraph marks were ordered last."""
    r = copy.deepcopy(ctx["revise"])
    r["inserted"]["rejected"] = r["inserted"]["rejected"] + [""]
    ctx["revise"] = r
    return ctx


def flaw_author_filter_ignored(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    r["by_author"]["elements"] = []
    ctx["revise"] = r
    return ctx


def flaw_author_filter_does_nothing(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    r["by_author"]["elements"] = list(r["elements"])
    ctx["revise"] = r
    return ctx


def flaw_remaining_not_reported(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    r["accept"]["report"].pop("remaining", None)
    ctx["revise"] = r
    return ctx


def flaw_accept_leaves_markup_and_says_nothing(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    r["accept"]["elements"] = [{"kind": "ins", "id": "1", "author": "x", "date": "y",
                                "paragraph_mark": False, "runs": 1, "text": "",
                                "holds_wt": False}]
    ctx["revise"] = r
    return ctx


def flaw_strict_writes_with_leftovers(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    r["by_author"]["strict_exit"] = 0
    r["by_author"]["strict_wrote"] = True
    ctx["revise"] = r
    return ctx


def flaw_nested_survives_accept(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    t = list(r["nested"]["accepted"])
    t[TRACKED_PARAGRAPH] = t[TRACKED_PARAGRAPH] + CROSS_RUN_NEW
    r["nested"]["accepted"] = t
    ctx["revise"] = r
    return ctx


def flaw_nested_survives_reject(ctx, work):
    r = copy.deepcopy(ctx["revise"])
    t = list(r["nested"]["rejected"])
    t[TRACKED_PARAGRAPH] = t[TRACKED_PARAGRAPH] + CROSS_RUN_NEW
    r["nested"]["rejected"] = t
    ctx["revise"] = r
    return ctx


def flaw_comment_anchor_not_isolated(ctx, work):
    c = copy.deepcopy(ctx["comment"])
    c["report"]["added"]["cross_run"] = False
    c["report"]["added"]["runs_wrapped"] = 1
    ctx["comment"] = c
    return ctx


def flaw_comment_without_range_markers(ctx, work):
    c = copy.deepcopy(ctx["comment"])
    c["pieces"] = {**c["pieces"], "range_starts": c["before_pieces"]["range_starts"]}
    ctx["comment"] = c
    return ctx


def flaw_comment_part_not_wired(ctx, work):
    c = copy.deepcopy(ctx["comment"])
    c["scratch"]["pieces"] = {**c["scratch"]["pieces"], "relationship": False}
    ctx["comment"] = c
    return ctx


def flaw_comment_creation_not_reported(ctx, work):
    c = copy.deepcopy(ctx["comment"])
    c["scratch"]["report"]["added"]["package_pieces_created"] = []
    ctx["comment"] = c
    return ctx


def flaw_delete_leaves_the_part(ctx, work):
    c = copy.deepcopy(ctx["comment"])
    c["deleted"]["pieces"] = {**c["deleted"]["pieces"], "part": True}
    c["deleted"]["report"]["deleted"]["comments_part_dropped"] = False
    ctx["comment"] = c
    return ctx


def flaw_delete_leaves_orphan_markers(ctx, work):
    c = copy.deepcopy(ctx["comment"])
    c["deleted"]["pieces"] = {**c["deleted"]["pieces"], "range_starts": 2,
                              "references": 2}
    ctx["comment"] = c
    return ctx


def flaw_missing_anchor_accepted(ctx, work):
    c = copy.deepcopy(ctx["comment"])
    c["missing_anchor"] = {"exit": 0, "stderr": "", "wrote": True}
    ctx["comment"] = c
    return ctx


def flaw_listing_hides_the_anchor_state(ctx, work):
    c = copy.deepcopy(ctx["comment"])
    c["report"]["comments"] = [{**e, "anchored": False}
                               for e in c["report"]["comments"]]
    ctx["comment"] = c
    return ctx


FLAWS = [
    ("replace-run-by-run", flaw_replace_run_by_run, {"E1", "E2"},
     "E2 also fires, and it must: a replacement that never happened leaves the old "
     "phrase in the text. E1 owns the reason (the phrase spans runs), E2 owns the "
     "consequence (the document still says it)"),
    ("replace-reports-more-than-it-did", flaw_replace_reports_more_than_it_did,
     {"E1"}, ""),
    ("replace-leaves-the-old-text", flaw_replace_leaves_the_old_text, {"E2"}, ""),
    ("replace-misses-the-placeholder", flaw_replace_misses_the_placeholder, {"E2"}, ""),
    ("edit-rebuilds-every-part", flaw_edit_rebuilds_the_package, {"E3"}, ""),
    ("edit-drops-the-custom-xml", flaw_edit_drops_the_custom_xml, {"E3"}, ""),
    ("edit-resets-the-run-font", flaw_edit_resets_the_run_font, {"E3"}, ""),
    ("replace-steps-over-a-line-break", flaw_replace_ignores_line_breaks, {"E4"}, ""),
    ("near-miss-reported-as-plain-zero", flaw_near_miss_reported_as_plain_zero,
     {"E4"}, ""),
    ("edit-inside-a-tracked-change-says-nothing", flaw_revision_edit_says_nothing,
     {"E5"}, ""),
    ("headers-edited-whether-asked-or-not", flaw_headers_always_edited, {"E6"}, ""),
    ("in-headers-does-nothing", flaw_in_headers_does_nothing, {"E6"}, ""),

    ("append-after-sectpr", flaw_append_after_sectpr, {"A1"}, ""),
    ("append-drops-the-section", flaw_append_drops_the_section, {"A1"}, ""),
    ("list-accepted-with-no-list-to-join", flaw_list_accepted_without_numbering,
     {"A2"}, ""),
    ("list-guard-refuses-everything", flaw_list_refused_always, {"A2"}, ""),
    ("written-run-has-no-eastasia", flaw_appended_run_has_no_eastasia, {"A3"}, ""),

    ("pack-loses-a-part", flaw_pack_loses_a_part, {"P1"}, ""),
    ("pack-reorders-the-parts", flaw_pack_reorders, {"P1", "P2"},
     "P1 also fires: the report's own order_preserved flag is what P1 reads, and a "
     "pack that reorders sets it. P2 owns the order, P1 owns the report agreeing "
     "with the file"),
    ("manifest-makes-no-difference", flaw_manifest_makes_no_difference, {"P2"}, ""),
    ("pack-drops-hand-added-parts", flaw_pack_drops_added_parts, {"P3"}, ""),
    ("unpack-trusts-part-names", flaw_unpack_trusts_part_names, {"P4"}, ""),

    ("check-ignores-element-order", flaw_check_ignores_element_order, {"O1"}, ""),
    ("check-only-looks-at-the-body", flaw_check_only_finds_sectpr, {"O1"}, ""),
    ("fix-repairs-only-one-of-them", flaw_fix_repairs_only_the_body, {"O2"}, ""),
    ("fix-rewrites-the-text", flaw_fix_rewrites_the_text, {"O3"}, ""),
    ("fix-rewrites-every-part", flaw_fix_rewrites_every_part, {"O3"}, ""),

    ("read-hands-back-runs-not-paragraphs", flaw_reader_hands_back_runs, {"R1"}, ""),
    ("read-folds-in-deleted-text", flaw_reader_folds_in_deleted_text, {"R2"}, ""),
    ("read-drops-revisions-entirely", flaw_reader_drops_revisions_entirely, {"R2"}, ""),
    ("read-skips-inserted-text", flaw_reader_skips_inserted_text, {"R3"}, ""),
    ("read-flattens-tables", flaw_tables_flattened, {"R4"}, ""),
    ("read-returns-ragged-rows", flaw_table_rows_ragged, {"R4"}, ""),
    ("read-forgets-list-levels", flaw_list_level_not_reported, {"R5"}, ""),
    ("read-forgets-the-header-binding", flaw_section_reported_without_bindings,
     {"R5"}, ""),
    ("read-reports-a-page-field-as-text", flaw_footer_field_read_as_text, {"R6"}, ""),
    ("read-ignores-headers-and-footers", flaw_headers_not_reported, {"R6"}, ""),

    ("stdout-dumps-every-paragraph", flaw_stdout_dumps_every_paragraph, {"C1"}, ""),
    ("trimming-drops-the-report", flaw_trimming_drops_the_report, {"C1"}, ""),
    ("edit-made-without-tracking-it", flaw_track_replaces_without_tracking, {"K1"}, ""),
    ("tracking-wraps-a-single-run-only", flaw_track_wraps_one_run_only, {"K1"}, ""),
    ("deleted-text-left-as-w-t", flaw_del_keeps_wt, {"K1"}, ""),
    ("revision-ids-reused", flaw_revision_ids_reused, {"K1"}, ""),
    ("revision-without-an-author", flaw_revision_without_author, {"K1"}, ""),
    ("accept-changes-nothing", flaw_accept_does_nothing, {"K2"}, ""),
    ("reject-keeps-the-new-text", flaw_reject_keeps_the_new_text, {"K2"}, ""),
    ("reject-drops-the-deleted-text", flaw_reject_drops_the_deleted_text, {"K2"}, ""),
    ("inserted-paragraph-mark-not-tracked", flaw_paragraph_mark_not_tracked,
     {"K3"}, ""),
    ("reject-leaves-an-empty-paragraph", flaw_reject_leaves_an_empty_paragraph,
     {"K3"}, ""),
    ("author-filter-resolves-everything", flaw_author_filter_ignored, {"K4"}, ""),
    ("author-filter-resolves-nothing", flaw_author_filter_does_nothing, {"K4"}, ""),
    ("remaining-not-reported", flaw_remaining_not_reported, {"K5"}, ""),
    ("accept-leaves-markup-and-claims-success",
     flaw_accept_leaves_markup_and_says_nothing, {"K5"}, ""),
    ("strict-writes-with-leftovers", flaw_strict_writes_with_leftovers, {"K5"}, ""),
    ("insert-then-delete-survives-accept", flaw_nested_survives_accept, {"K6"}, ""),
    ("insert-then-delete-survives-reject", flaw_nested_survives_reject, {"K6"}, ""),

    ("comment-anchor-not-isolated", flaw_comment_anchor_not_isolated, {"B1"}, ""),
    ("comment-without-range-markers", flaw_comment_without_range_markers, {"B1"}, ""),
    ("comments-part-not-wired-up", flaw_comment_part_not_wired, {"B2"}, ""),
    ("comment-part-creation-not-reported", flaw_comment_creation_not_reported,
     {"B2"}, ""),
    ("delete-leaves-the-comments-part", flaw_delete_leaves_the_part, {"B3"}, ""),
    ("delete-leaves-orphan-range-markers", flaw_delete_leaves_orphan_markers,
     {"B3"}, ""),
    ("comment-anchored-to-text-that-is-not-there", flaw_missing_anchor_accepted,
     {"B4"}, ""),
    ("listing-hides-whether-a-comment-is-anchored",
     flaw_listing_hides_the_anchor_state, {"B5"}, ""),

    ("one-huge-table-dumped-to-stdout", flaw_tall_table_dumped_whole, {"C3"}, ""),
    ("byte-budget-drops-the-answer-too", flaw_byte_budget_drops_the_answer, {"C3"}, ""),
    ("writer-overwrites-its-own-input", flaw_in_place_write_allowed, {"C2"}, ""),
    ("missing-file-answers-with-a-traceback", flaw_missing_file_raises, {"C2"}, ""),
    ("an-xlsx-is-accepted-as-a-docx", flaw_xlsx_accepted_as_docx, {"C2"}, ""),
    ("fixture-is-not-reproducible", flaw_fixture_not_reproducible, {"F0"}, ""),

    ("fill-scans-runs-not-paragraphs", flaw_fill_only_walks_runs, {"T1"}, ""),
    ("fill-reports-a-hit-it-did-not-make", flaw_fill_leaves_the_placeholder_visible,
     {"T1"}, ""),
    ("unfilled-placeholders-not-reported", flaw_unfilled_not_reported, {"T2"}, ""),
    ("unused-value-not-reported", flaw_unused_value_not_reported, {"T3"}, ""),
    ("strict-writes-the-file-anyway", flaw_strict_writes_anyway, {"T4"}, ""),
    ("fill-never-reaches-the-header", flaw_fill_skips_headers, {"T5"}, ""),

    ("render-produces-no-file", flaw_render_produces_nothing, {"Y1"}, ""),
    ("render-skips-the-page-images", flaw_render_skips_the_images, {"Y1"}, ""),
    ("blank-render-handed-back-as-a-preview", flaw_blank_render_handed_back,
     {"Y2"}, ""),
    ("tracked-changes-rendered-in-silence", flaw_revisions_rendered_in_silence,
     {"Y3"}, ""),
    ("cached-field-rendered-in-silence", flaw_cached_field_rendered_in_silence,
     {"Y3"}, ""),

    ("CONTROL: fixture stops splitting the phrase across runs",
     flaw_fixture_stops_splitting_runs, {"V0", "E1"},
     "E1 also fires, and that is the point: once the per-run search finds as much as "
     "this implementation does, E1's comparison is meaningless. V0 says the fixture "
     "stopped exercising it; E1 says the assertion stopped distinguishing"),
    ("CONTROL: fixture loses its custom XML part", flaw_fixture_loses_its_custom_xml,
     {"V0"}, ""),
    ("CONTROL: unordered.docx stops being unordered", flaw_fixture_stops_being_unordered,
     {"V0"}, ""),
]


def fired(ctx: dict) -> dict[str, list[str]]:
    out = {}
    for cid, c in CHECKS.items():
        findings = c["fn"](ctx)
        if findings:
            out[cid] = findings
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    for f in (REPORT, UNORDERED):
        if not f.is_file():
            print(f"[error] fixture missing: {f} (run fixtures/make_fixtures.py)",
                  file=sys.stderr)
            return 1

    results = []
    SKIPS.clear()
    with tempfile.TemporaryDirectory(prefix="docx-skill-test-") as td:
        work = Path(td)
        base = collect(work)

        clean = fired(base)
        results.append({"case": "real output of the real scripts", "expect": "silence",
                        "ok": not clean,
                        "detail": [f for v in clean.values() for f in v]})

        no_soffice = bool(base["pdf"].get("skipped"))
        matrix = []
        for name, mutate, expected, cascade in FLAWS:
            # A negative control whose check needs a tier this host lacks cannot
            # fire, and calling that a failure makes the suite red for a reason that
            # has nothing to do with the code. It is skipped and NAMED — never
            # folded into the pass count, and never quietly dropped either.
            if no_soffice and expected <= SOFFICE_CHECKS:
                SKIPS.append(f"negative control {name!r}: needs LibreOffice")
                continue
            ctx = mutate(copy.deepcopy(base), work)
            got = fired(ctx)
            unexpected = set(got) - expected
            missing = expected - set(got)
            matrix.append({"flaw": name, "expected": sorted(expected),
                           "fired": sorted(got), "cascade_note": cascade})
            detail = []
            if missing:
                detail.append(f"expected {sorted(missing)} to fire and it did not")
            if unexpected and not cascade:
                detail.append(f"unexpected checks fired: {sorted(unexpected)} — either "
                              f"a real cascade that needs documenting, or a check "
                              f"measuring the wrong thing")
            results.append({"case": f"flaw: {name}",
                            "expect": f"fires {sorted(expected)}",
                            "ok": not detail, "detail": detail,
                            "fired": sorted(got)})

    failed = [r for r in results if not r["ok"]]
    if args.json:
        print(json.dumps({"results": results, "matrix": matrix,
                          "skipped": SKIPS, "failed": len(failed)},
                         ensure_ascii=False, indent=2))
        return 1 if failed else 0

    for r in results:
        print(f"{'PASS' if r['ok'] else 'FAIL'}  [{r['expect']}] {r['case']}")
        for d in r["detail"][:6]:
            print(f"      · {d}")
    print("\n[flaw -> fired] every row must light the check that owns the defect, "
          "and nothing else:")
    for m in matrix:
        extra = sorted(set(m["fired"]) - set(m["expected"]))
        note = f"   (also {', '.join(extra)}: {m['cascade_note']})" if extra else ""
        print(f"  {m['flaw']:<52} -> {', '.join(m['fired']) or '(nothing)'}{note}")
    if SKIPS:
        print("\n[skipped] claims this host could not exercise:")
        for note in SKIPS:
            print(f"  - {note}")
    print(f"\n[docx-skill] {len(results) - len(failed)} passed, {len(failed)} failed, "
          f"{len(CHECKS)} assertions"
          + (f", {len(SKIPS)} skipped" if SKIPS else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
