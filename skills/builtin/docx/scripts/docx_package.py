#!/usr/bin/env python3
"""W13 / W15 — open the package up, put it back, and repair ECMA-376 element order.

A .docx is a zip. Unpacking it is the escape hatch for everything this skill does
not model: hand-edit a part, run a diff, look at what a tool did. The two rules
that make the round trip trustworthy are the ones a plain `unzip`/`zip` pair break:

  * **Part order is part of the file.** `[Content_Types].xml` conventionally comes
    first and some readers are stricter about it than the spec is, so the manifest
    records the order and `--pack` restores it. `zip -r` gives you directory order.
  * **A part is three things** (bytes, a content-type declaration, a relationship).
    `--check` says whether all three still line up; deleting a part with `rm` and
    rezipping does not, and produces a package that opens in some readers and asks
    to be repaired in others.

W15 is `--fix-order`. WordprocessingML content models are `xsd:sequence`: the
children of `<w:pPr>` have a fixed order and a document that gets it wrong is
invalid even though every element in it is spelled correctly. Word answers with
the "unreadable content" dialog and the repaired file has lost whatever it could
not place. The repair is **explicit and reported per element** rather than applied
on every write: an element in the wrong place means some writer has a bug, and
quietly reordering it hides which one.

Usage:

    python3 scripts/docx_package.py --in report.docx --unpack ./unpacked
    python3 scripts/docx_package.py --pack ./unpacked --out rebuilt.docx
    python3 scripts/docx_package.py --in report.docx --check
    python3 scripts/docx_package.py --in messy.docx --fix-order --out fixed.docx
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import (emit, ensure_distinct, fail, open_document,  # noqa: E402
                        run, save_checked, write_json)
from office.package import CONTENT_TYPES, Package  # noqa: E402
from office.validate import ORDERED_PARTS, check_package  # noqa: E402
from office.xmlorder import local, reorder  # noqa: E402

MANIFEST = "_manifest.json"


def safe_relative(name: str) -> Path:
    """A part name turned into a path that cannot leave the target directory.

    Part names come out of a zip written by someone else. `../../.ssh/authorized_keys`
    is a valid zip entry name and an unpack that trusts it writes wherever it likes.
    """
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts) or name.startswith("/") or ":" in name.split("/")[0]:
        fail(f"refusing to unpack a part whose name escapes the target directory: "
             f"{name!r}")
    return Path(*parts)


def unpack(pkg: Package, dest: Path) -> dict:
    if dest.exists() and any(dest.iterdir()):
        fail(f"{dest} is not empty; unpack into a new directory so nothing of yours "
             f"is overwritten")
    manifest = {"order": list(pkg.order),
                "content_types": {n: pkg.content_type(n) for n in pkg.order
                                  if n != CONTENT_TYPES},
                "note": "written by docx_package.py --unpack; --pack reads `order` "
                        "from here so the rebuilt package keeps the part order the "
                        "original had"}
    for name in pkg.order:
        target = dest / safe_relative(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(pkg.parts[name])
    write_json(dest / MANIFEST, manifest)
    return {"parts": len(pkg.order), "directory": str(dest),
            "manifest": str(dest / MANIFEST)}


def pack(source: Path, out: Path) -> dict:
    if not source.is_dir():
        fail(f"--pack needs the directory a previous --unpack wrote; {source} is not "
             f"a directory")
    found = sorted(str(p.relative_to(source)).replace("\\", "/")
                   for p in source.rglob("*") if p.is_file())
    found = [n for n in found if n != MANIFEST]
    manifest_path = source / MANIFEST
    order: list[str] = []
    if manifest_path.is_file():
        try:
            order = list(json.loads(manifest_path.read_text(encoding="utf-8"))["order"])
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            fail(f"{MANIFEST} is unreadable ({e}); delete it to pack in name order, "
                 f"or restore it from the unpack that made this directory")
    # Parts added by hand since the unpack are kept, appended after the recorded
    # ones — dropping them silently would make "I added a part and packed" a no-op.
    names = [n for n in order if n in found] + [n for n in found if n not in order]
    if CONTENT_TYPES not in names:
        fail(f"{source} has no {CONTENT_TYPES}; this is not an unpacked OOXML package")
    parts = {n: (source / n).read_bytes() for n in names}
    pkg = Package(parts, names)
    findings = check_package(pkg)
    pkg.save(out)
    return {"parts": len(names), "out": str(out),
            "added_since_unpack": [n for n in found if order and n not in order],
            "missing_since_unpack": [n for n in order if n not in found],
            "package_findings": findings}


def fix_order(pkg: Package) -> list[dict]:
    """Sort every element this skill has a schema model for. One entry per fix."""
    fixes: list[dict] = []
    for name in sorted(n for n in pkg.names() if ORDERED_PARTS.match(n)):
        root = pkg.tree(name)
        changed: list[str] = []

        def visit(el, path: str) -> None:
            before = [local(c.tag) for c in el]
            if reorder(el):
                after = [local(c.tag) for c in el]
                changed.append(f"{path}: {' '.join(before)} -> {' '.join(after)}")
            counts: dict[str, int] = {}
            for child in el:
                n = local(child.tag)
                counts[n] = counts.get(n, 0) + 1
                visit(child, f"{path}/{n}[{counts[n]}]")

        visit(root, local(root.tag))
        if changed:
            pkg.put_tree(name, root)
            fixes.append({"part": name, "elements_reordered": len(changed),
                          "detail": changed})
    return fixes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src")
    ap.add_argument("--unpack", metavar="DIR")
    ap.add_argument("--pack", metavar="DIR")
    ap.add_argument("--out")
    ap.add_argument("--check", action="store_true",
                    help="report package consistency: parts, content types, "
                         "relationships, r:id targets and element order")
    ap.add_argument("--fix-order", action="store_true",
                    help="rewrite children into the ECMA-376 sequence (needs --out)")
    ap.add_argument("--report", help="write the full report here")
    args = ap.parse_args()

    def entry():
        report_path = Path(args.report) if args.report else None
        if args.pack:
            if not args.out:
                fail("--pack needs --out")
            emit(pack(Path(args.pack), Path(args.out)), report_path,
                 "package_findings")
            return
        if not args.src:
            fail("pass --in FILE (or --pack DIR)")
        src = Path(args.src)
        pkg = open_document(src)

        if args.unpack:
            report = {"in": src.name, **unpack(pkg, Path(args.unpack))}
            if args.out:
                # unpack + pack in one go: the round trip is the thing worth
                # proving, and a report that only says "17 files written" does not
                # prove it. `identical_parts` is counted from the packed result, so
                # it answers "did the document survive being taken apart" rather
                # than "did the writer feel confident".
                out = Path(args.out)
                ensure_distinct(src, out)
                report["repacked"] = pack(Path(args.unpack), out)
                rebuilt = Package.open(out)
                report["identical_parts"] = sum(
                    1 for n in pkg.parts if rebuilt.parts.get(n) == pkg.parts[n])
                report["order_preserved"] = rebuilt.order == pkg.order
                report["parts_lost"] = sorted(set(pkg.parts) - set(rebuilt.parts))
            emit(report, report_path)
            return
        if args.fix_order:
            if not args.out:
                fail("--fix-order needs --out")
            out = Path(args.out)
            ensure_distinct(src, out)
            before = check_package(pkg)
            fixes = fix_order(pkg)
            # The order findings are expected to disappear; anything else in the
            # input stays reported and does not block the write.
            still = save_checked(pkg, out, before)
            emit({"in": src.name, "out": str(out), "parts_reordered": len(fixes),
                  "fixes": fixes,
                  "findings_before": before,
                  "pre_existing_package_findings": still}, report_path,
                 "fixes", "findings_before")
            return

        findings = check_package(pkg)
        emit({"in": src.name, "parts": len(pkg.names()), "consistent": not findings,
              "findings": findings,
              "content_types": {n: pkg.content_type(n) for n in sorted(pkg.names())
                                if n != CONTENT_TYPES}},
             report_path, "findings", "content_types")
        if args.check and findings:
            fail(f"{src.name} has {len(findings)} package problem(s); see the report")

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
