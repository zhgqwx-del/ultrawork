#!/usr/bin/env python3
"""W16 — inspect and repair the East Asian font bindings of an existing document.

Word chooses a run's typeface from `w:rFonts`, and it chooses a **different** one for
Chinese than for Latin: `@w:ascii` covers the Latin range, `@w:eastAsia` covers CJK.
A run of mixed text — `2026 年营收 Revenue 同比增长` is an ordinary sentence — is
therefore drawn in two faces, and a run that binds only one of them gets the other
from the document's theme. On a machine whose theme font has no CJK coverage, the
Chinese does not render as the wrong face; it does not render at all.

The obvious repair is to write `w:eastAsia="宋体"` on every Chinese run, and it is
wrong. **A run with no `w:rFonts` is not a run with no font.** The value may already
be stated by the run's character style, by its paragraph style, by an ancestor of
either, or by `w:docDefaults` — and overwriting any of those restyles text the
author had already made a decision about. The result passes every check there is:
the binding is present, it is explicit, the document renders. It is simply not the
document that was handed in.

So this walks the style chain first (`office/styles.py`) and reports, per run, where
each face came from:

    run           already explicit — nothing to do
    style:<id>    the document already said; materialise THAT value, not a default
    docDefaults   likewise
    nothing       nobody said. This is the only place a fallback is honest, and it
                  is counted separately and named, so `--strict` can refuse it.

What is deliberately not touched: theme bindings (`@w:eastAsiaTheme` is a binding
and resolving it needs word/theme/theme1.xml), and the styles themselves — changing
a style changes every run that uses it, which is a bigger edit than the one asked
for. Both are reported rather than silently included.

    python3 docx_fonts.py --in a.docx --check
    python3 docx_fonts.py --in a.docx --out b.docx --fix --east-asia 宋体
    python3 docx_fonts.py --in a.docx --out b.docx --fix --strict
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, clip, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office import styles as sty  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402
from office.xmlorder import q  # noqa: E402

STYLES = "word/styles.xml"
HEADER_FOOTER = ("word/header", "word/footer")
# The two faces D6 judges a document by. `hAnsi` is written alongside `ascii`
# because Word picks it for the high-ANSI range and a document that sets one and
# not the other renders punctuation in a third typeface.
SLOTS = ("ascii", "eastAsia")


def text_parts(pkg: Package) -> list[str]:
    """Every part holding runs. Headers and footers are where letterheads live —
    the text most likely to have been pasted in from somewhere with its own fonts."""
    return ([DOCUMENT] if pkg.has(DOCUMENT) else []) + \
        sorted(n for n in pkg.names() if n.startswith(HEADER_FOOTER))


def audit_part(root, styles_root, part: str) -> list[dict]:
    """Every CJK run in this part that does not state its own faces."""
    out = []
    for p_index, paragraph in enumerate(doc.iter_paragraphs(root)):
        for r_index, node in enumerate(paragraph.iter(q("r"))):
            text = "".join(t.text or "" for t in node.iter(q("t")))
            if not doc.has_cjk(text):
                continue
            resolved = {slot: sty.resolve_font(node, paragraph, styles_root, slot)
                        for slot in SLOTS}
            missing = [slot for slot in SLOTS if resolved[slot][1] != "run"]
            if not missing:
                continue
            out.append({
                "part": part, "paragraph": p_index, "run": r_index,
                "text": clip(text, 24),
                "missing": missing,
                "resolved": {slot: {"value": resolved[slot][0],
                                    "from": resolved[slot][1]}
                             for slot in missing},
            })
    return out


def repair(root, styles_root, findings: list[dict], part: str,
           east_asia: str, ascii_font: str) -> list[dict]:
    """Write the resolved value onto each run. Returns what was written."""
    paragraphs = list(doc.iter_paragraphs(root))
    done = []
    for finding in findings:
        if finding["part"] != part:
            continue
        paragraph = paragraphs[finding["paragraph"]]
        node = list(paragraph.iter(q("r")))[finding["run"]]
        rfonts = sty.ensure_rfonts(node)
        written = {}
        for slot in finding["missing"]:
            value, source = finding["resolved"][slot]["value"], \
                finding["resolved"][slot]["from"]
            if value is None:
                value = east_asia if slot == "eastAsia" else ascii_font
                source = "fallback"
            if value.startswith("theme:"):
                # A theme binding is a binding. Copying the ATTRIBUTE keeps the
                # indirection intact; copying the value would write the literal
                # string "theme:minorEastAsia" as a typeface name.
                rfonts.set(q(sty.THEME_OF[slot]), value.split(":", 1)[1])
            else:
                rfonts.set(q(slot), value)
                if slot == "ascii" and not rfonts.get(q("hAnsi")):
                    rfonts.set(q("hAnsi"), value)
            written[slot] = {"value": value, "from": source}
        done.append({**finding, "written": written})
    return done


def summarise(written: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for entry in written:
        for slot in entry["written"].values():
            counts[slot["from"]] = counts.get(slot["from"], 0) + 1
    return counts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--check", action="store_true",
                    help="report what is unbound and change nothing")
    ap.add_argument("--fix", action="store_true",
                    help="write an explicit binding on every CJK run")
    ap.add_argument("--east-asia", default="宋体",
                    help="the CJK face to use where the document states none")
    ap.add_argument("--ascii", dest="ascii_font", default="Calibri",
                    help="the Latin face to use where the document states none")
    ap.add_argument("--strict", action="store_true",
                    help="refuse to write when any face had to come from the "
                         "fallback — i.e. when the document never said")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        if args.fix and args.check:
            fail("--check and --fix are opposites: --check reports and writes "
                 "nothing, --fix writes. Pick one")
        if not (args.fix or args.check):
            fail("nothing to do: pass --check to inspect or --fix to repair")
        pkg = open_document(args.src)
        styles_root = pkg.tree(STYLES) if pkg.has(STYLES) else None
        parts = text_parts(pkg)
        trees = {part: pkg.tree(part) for part in parts}
        findings: list[dict] = []
        cjk_runs = 0
        for part, root in trees.items():
            for paragraph in doc.iter_paragraphs(root):
                cjk_runs += sum(
                    1 for node in paragraph.iter(q("r"))
                    if doc.has_cjk("".join(t.text or "" for t in node.iter(q("t")))))
            findings += audit_part(root, styles_root, part)

        report: dict = {
            "in": args.src.name,
            "parts_examined": parts,
            "runs_with_cjk": cjk_runs,
            "unbound_runs": len(findings),
            "problems": findings,
            "not_examined": [
                "word/styles.xml — a style binds every run that uses it, so "
                "changing one is a wider edit than this reports on",
                "theme fonts — @w:eastAsiaTheme IS a binding; runs carrying one are "
                "counted as bound and left alone",
            ],
        }
        if args.check:
            report["verdict"] = ("every CJK run states both faces"
                                 if not findings else
                                 f"{len(findings)} CJK run(s) do not state their own "
                                 f"faces; --fix writes the resolved value onto each")
            emit(report, args.report, "problems", "not_examined")
            # `--check` is an inspection, not a gate: exit 0 with a verdict. `--strict`
            # turns it into a gate, which is what a CI caller wants.
            if args.strict and findings:
                fail(f"--strict: {len(findings)} CJK run(s) are unbound")
            return

        if not args.out:
            fail("pass --out FILE")
        ensure_distinct(args.src, args.out)
        pre_existing = check_package(pkg)
        before = dict(pkg.parts)
        written: list[dict] = []
        for part, root in trees.items():
            done = repair(root, styles_root, findings, part,
                          args.east_asia, args.ascii_font)
            if done:
                pkg.put_tree(part, root)
            written += done
        sources = summarise(written)
        fallback = [e for e in written
                    if any(s["from"] == "fallback" for s in e["written"].values())]
        if args.strict and fallback:
            fail(f"--strict: {len(fallback)} run(s) had no face stated anywhere in "
                 f"the document — not on the run, not on its styles, not in "
                 f"w:docDefaults — so {args.east_asia!r} would be this tool's choice "
                 f"and not the document's. Nothing was written. Drop --strict to "
                 f"accept the fallback, or set the face in w:docDefaults first")
        report["repaired"] = len(written)
        report["sources"] = sources
        report["fallback_used"] = [
            {"part": e["part"], "paragraph": e["paragraph"], "text": e["text"],
             "faces": [s for s, v in e["written"].items() if v["from"] == "fallback"]}
            for e in fallback]
        report["problems"] = written
        report["pre_existing_package_findings"] = save_checked(pkg, args.out,
                                                              pre_existing)
        report["out"] = str(args.out)
        report["parts_changed"] = sorted(n for n in pkg.parts
                                         if before.get(n) != pkg.parts[n])
        report["parts_byte_identical"] = sum(1 for n in before
                                             if pkg.parts.get(n) == before[n])
        emit(report, args.report, "problems", "fallback_used", "not_examined",
             "parts_changed")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
