#!/usr/bin/env python3
"""W5 — fill `{{placeholder}}` templates.

Mechanically this is W2's cross-run replacement with a different contract, and the
contract is the whole point. A text replacement that finds nothing has done what it
was told. **A template fill that finds nothing has shipped a contract that still
says `{{客户名称}}`** — and that is a document going out with a hole in it.

So this script answers three questions that `--replace` does not:

  * which placeholders are still in the document after filling (`unfilled`)
  * which values you supplied that matched no placeholder (`unused_values`) —
    almost always a typo in the key, which is otherwise indistinguishable from
    "that placeholder is not in this template"
  * with `--strict`, whether to refuse the write over either of those

Headers and footers are filled **by default**, unlike `--replace`, because a
letterhead is where half of a real template's placeholders live. That asymmetry is
deliberate: a body-text replacement reaching into a header would be a surprise; a
template fill NOT reaching one leaves the classification marking unfilled.

    python3 docx_template.py --in contract.docx --out filled.docx \\
            --set 客户名称=示例科技有限公司 --set 日期=2026-08-02
    python3 docx_template.py --in contract.docx --out filled.docx \\
            --values values.json --strict
    python3 docx_template.py --in contract.docx --list
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (DOCUMENT, emit, ensure_distinct, fail,  # noqa: E402
                        open_document, run, save_checked)
from office import document as doc  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402

# `[^{}]` keeps a stray `{` in the document from swallowing the rest of a paragraph,
# and the length cap keeps an unclosed `{{` from matching a whole contract.
PLACEHOLDER = re.compile(r"\{\{([^{}]{1,64})\}\}")


def fillable_parts(pkg: Package) -> list[str]:
    return [DOCUMENT] + sorted(
        n for n in pkg.names()
        if n.startswith(("word/header", "word/footer")) and n.endswith(".xml"))


def scan(pkg: Package) -> dict[str, dict]:
    """Every placeholder in the template, and where it is.

    Found over the paragraph's joined text, so a placeholder Word split across runs
    — which is what happens the moment anyone edits the template — is found like any
    other. A scanner that walked runs would report a template as having no
    placeholders and be believed.
    """
    found: dict[str, dict] = {}
    for part in fillable_parts(pkg):
        for paragraph in doc.iter_paragraphs(doc.body(pkg.tree(part))):
            for name in PLACEHOLDER.findall(doc.paragraph_text(paragraph)):
                entry = found.setdefault(name, {"name": name, "occurrences": 0,
                                                "parts": []})
                entry["occurrences"] += 1
                if part not in entry["parts"]:
                    entry["parts"].append(part)
    return found


def split_pair(spec: str) -> tuple[str, str]:
    if "=" not in spec:
        fail(f"--set expects NAME=VALUE, got {spec!r}")
    name, value = spec.split("=", 1)
    if not name:
        fail("--set was given an empty placeholder name")
    return name, value


def load_values(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        fail(f"--values {path} could not be read as JSON: {e}")
    if not isinstance(data, dict):
        fail(f"--values {path} must hold a JSON object of name -> value, got "
             f"{type(data).__name__}")
    bad = sorted(k for k, v in data.items() if not isinstance(v, (str, int, float)))
    if bad:
        fail(f"--values holds non-scalar value(s) for {bad}; a template placeholder "
             f"is replaced by text, and silently stringifying a list or an object "
             f"produces a document with Python syntax in it")
    return {k: str(v) for k, v in data.items()}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE")
    ap.add_argument("--values", type=Path, metavar="FILE",
                    help="a JSON object of placeholder -> value")
    ap.add_argument("--list", action="store_true",
                    help="report the template's placeholders and write nothing")
    ap.add_argument("--strict", action="store_true",
                    help="refuse to write if any placeholder is left unfilled or any "
                         "supplied value matched nothing")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        pkg = open_document(args.src)
        placeholders = scan(pkg)

        if args.list:
            emit({"in": args.src.name, "placeholders": sorted(placeholders.values(),
                                                              key=lambda p: p["name"])},
                 args.report, "placeholders")
            return

        if not args.out:
            fail("pass --out FILE (or --list to only report the placeholders)")
        ensure_distinct(args.src, args.out)
        values = dict(load_values(args.values) if args.values else {})
        values.update(dict(split_pair(s) for s in args.set))
        if not values:
            fail("no values given: pass --set NAME=VALUE and/or --values FILE")

        pre_existing = check_package(pkg)
        before = dict(pkg.parts)
        filled = []
        for name, value in values.items():
            entry_report = {"name": name, "value": value, "replaced": 0,
                            "cross_run": 0, "parts": {}}
            for part in fillable_parts(pkg):
                root = pkg.tree(part)
                hits = 0
                for paragraph in doc.iter_paragraphs(doc.body(root)):
                    r = doc.replace_in_paragraph(paragraph, "{{" + name + "}}", value)
                    hits += r["replaced"]
                    entry_report["cross_run"] += r["cross_run"]
                if hits:
                    entry_report["replaced"] += hits
                    entry_report["parts"][part] = hits
                    pkg.put_tree(part, root)
            filled.append(entry_report)

        remaining = scan(pkg)
        unfilled = sorted(remaining.values(), key=lambda p: p["name"])
        unused = sorted(e["name"] for e in filled if e["replaced"] == 0)

        if args.strict and (unfilled or unused):
            reasons = []
            if unfilled:
                reasons.append(f"{len(unfilled)} placeholder(s) are still in the "
                               f"document: {', '.join(p['name'] for p in unfilled)}")
            if unused:
                reasons.append(f"{len(unused)} supplied value(s) matched no "
                               f"placeholder (a typo in the name looks exactly like "
                               f"this): {', '.join(unused)}")
            fail("--strict, and " + "; ".join(reasons) + ". Nothing was written")

        still = save_checked(pkg, args.out, pre_existing)
        report = {
            "in": args.src.name, "out": str(args.out),
            "filled": filled,
            # Always present, never only-when-nonempty: a report that mentions holes
            # only when there are some is indistinguishable from one nobody wrote.
            "unfilled": unfilled,
            "unused_values": unused,
            "parts_changed": sorted(n for n in pkg.parts
                                    if before.get(n) != pkg.parts[n]),
            "parts_byte_identical": sum(1 for n in before
                                        if pkg.parts.get(n) == before[n]),
            "pre_existing_package_findings": still,
        }
        if unfilled:
            report["warning"] = (
                f"the document still contains {len(unfilled)} placeholder(s) — it "
                f"reads as a template, not as a finished document. Pass --strict to "
                f"make this refuse rather than warn")
        emit(report, args.report, "filled", "unfilled")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
