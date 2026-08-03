#!/usr/bin/env python3
"""W14 — validate a .docx against the ECMA-376 schemas, on the user's own machine.

Word's "we found unreadable content" dialog is the last place anyone wants to learn
that a document is malformed, because by then it has already been sent. Everything
else in this skill checks the rules it happens to know about; this checks the
document against the **published grammar** — a source that is not this repository's
opinion and does not share its blind spots. It is the reason the L2 gate could
overrule a hand-written rule of its own earlier in this project (gotchas §21.2 ㉛).

**The schemas ship with the skill.** 13 files, the transitive closure of wml.xsd,
55 KB compressed — 1.5% of the built-in skills archive. That was the decision to
make, because the alternative (point at a directory the user is expected to populate)
turns W14 into a capability that does nothing by default, and the whole point of it
is to work on a machine that has had nothing set up.

Where they come from, in order:

    --schemas DIR          an explicit path always wins
    $ECMA376_XSD_DIR       for a site that keeps its own vetted copy
    <skill>/schemas/       what ships, and what normally answers

⚠️ **And if none of those resolves, this says so and exits non-zero.** It never
returns "no problems found" from a run in which nothing was checked — a silent
degradation is the one outcome that was ruled out from the start, because a green
result nobody can distinguish from an empty one is worse than an error.

    python3 docx_validate.py --in report.docx
    python3 docx_validate.py --in report.docx --report validate.json
    python3 docx_validate.py --in report.docx --schemas /opt/ecma376
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docxcommon import emit, fail, open_document, run  # noqa: E402
from office.package import Package  # noqa: E402
from office.validate import check_package  # noqa: E402

SKILL_ROOT = Path(__file__).resolve().parent.parent
BUNDLED = SKILL_ROOT / "schemas"
ENV_VAR = "ECMA376_XSD_DIR"

# Which schema validates which part. A part with no entry is not validated and is
# REPORTED as such — "we checked everything we have a grammar for" is only useful
# next to "and here is what we did not".
SCHEMA_FOR = {
    "word/document.xml": "wml.xsd",
    "word/styles.xml": "wml.xsd",
    "word/numbering.xml": "wml.xsd",
    "word/settings.xml": "wml.xsd",
    "word/fontTable.xml": "wml.xsd",
    "word/footnotes.xml": "wml.xsd",
    "word/endnotes.xml": "wml.xsd",
    "word/comments.xml": "wml.xsd",
}
PREFIX_SCHEMA = (("word/header", "wml.xsd"), ("word/footer", "wml.xsd"))

# Transitional, not Strict. Every document Word actually produces lives in the
# `schemas.openxmlformats.org` namespaces; Part 1's Strict schemas use
# `purl.oclc.org`, so validating real files against them fails at the namespace
# level for all of them — which reads as "your output is non-conformant" when
# nothing is wrong. See schemas/NOTICE.
MCE_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006"


def schema_dir(explicit: str | None) -> tuple[Path | None, str, list[str]]:
    """Where the grammar comes from, and every place that was tried.

    ⚠️ An EXPLICIT `--schemas` that does not resolve is an error, not the first step
    of a search. Falling through to the bundled copy would validate against a
    different grammar than the one the caller named and report success — a site that
    keeps its own vetted schemas would be told its documents pass while nothing of
    theirs was consulted. The first version of this function did exactly that, and
    Z3 caught it: pointed at an empty directory it silently used the shipped copy and
    exited 0.
    """
    tried: list[str] = []
    if explicit:
        path = Path(explicit)
        tried.append(f"--schemas: {path}")
        if (path / "wml.xsd").is_file():
            return path, "--schemas", tried
        return None, "", tried
    for label, candidate in ((f"${ENV_VAR}", Path(os.environ[ENV_VAR])
                              if os.environ.get(ENV_VAR) else None),
                             ("bundled with the skill", BUNDLED)):
        if candidate is None:
            continue
        tried.append(f"{label}: {candidate}")
        if (candidate / "wml.xsd").is_file():
            return candidate, label, tried
    return None, "", tried


def apply_mce(root):
    """Honour `mc:Ignorable`, which is what makes a real document validate at all.

    Markup Compatibility lets a producer emit elements from namespaces the schema
    predates and mark them ignorable. Word does this constantly (w14, w15, wp14…).
    A validator that does not strip them reports a wall of violations on documents
    that are perfectly fine, which trains people to ignore it.
    """
    from lxml import etree
    ignorable = set()
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        raw = el.get(f"{{{MCE_NS}}}Ignorable")
        if raw:
            for prefix in raw.split():
                uri = el.nsmap.get(prefix)
                if uri:
                    ignorable.add(uri)
    # `mc:AlternateContent` offers a Choice a modern consumer takes and a Fallback for
    # everyone else. Validating the bare XSDs means being the "everyone else": take
    # the Fallback, which is exactly what the standard prescribes.
    for alt in list(root.iter(f"{{{MCE_NS}}}AlternateContent")):
        parent = alt.getparent()
        if parent is None:
            continue
        fallback = alt.find(f"{{{MCE_NS}}}Fallback")
        index = list(parent).index(alt)
        parent.remove(alt)
        if fallback is not None:
            for i, child in enumerate(list(fallback)):
                parent.insert(index + i, child)

    # ⚠️ `or ns == MCE_NS` on BOTH lines, and the attribute half is the one that is
    # easy to miss: `mc:Ignorable` itself lives in the MCE namespace, not in the
    # namespace it names. Strip only what it points at and the attribute survives —
    # and wml.xsd rejects it, so the validator reds every document Word writes for
    # carrying the very declaration that says what to ignore. Found by this skill's
    # own Z4 assertion the first time it ran.
    for el in list(root.iter()):
        if not isinstance(el.tag, str):
            continue
        uri = etree.QName(el).namespace
        if (uri in ignorable or uri == MCE_NS) and el.getparent() is not None:
            el.getparent().remove(el)
            continue
        for name in list(el.attrib):
            if not name.startswith("{"):
                continue
            ans = name[1:].split("}")[0]
            if ans in ignorable or ans == MCE_NS:
                del el.attrib[name]
    return root


def schema_for(part: str) -> str | None:
    if part in SCHEMA_FOR:
        return SCHEMA_FOR[part]
    for prefix, name in PREFIX_SCHEMA:
        if part.startswith(prefix) and part.endswith(".xml"):
            return name
    return None


def validate(pkg: Package, root: Path, limit: int) -> dict:
    from lxml import etree
    compiled: dict[str, object] = {}
    findings: list[dict] = []
    checked, skipped = [], []

    for part in sorted(pkg.names()):
        name = schema_for(part)
        if name is None:
            if part.endswith(".xml") and part.startswith("word/"):
                skipped.append({"part": part,
                                "why": "no schema is mapped for this part"})
            continue
        if name not in compiled:
            try:
                compiled[name] = etree.XMLSchema(etree.parse(str(root / name)))
            except Exception as e:  # noqa: BLE001 - a broken schema must be loud
                fail(f"cannot load {name} from {root}: {type(e).__name__}: {e}. "
                     f"The schemas are meant to ship with this skill; if they were "
                     f"removed, pass --schemas DIR or set ${ENV_VAR}")
        try:
            tree = apply_mce(etree.fromstring(pkg.read(part)))
        except etree.XMLSyntaxError as e:
            findings.append({"part": part, "line": getattr(e, "lineno", None),
                             "schema": name, "message": f"will not parse: {e}"})
            continue
        checked.append(part)
        schema = compiled[name]
        if not schema.validate(tree):
            for err in list(schema.error_log)[:limit]:
                findings.append({"part": part, "line": err.line, "schema": name,
                                 "message": err.message})
    return {"checked": checked, "not_checked": skipped, "findings": findings}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--schemas", help="an ECMA-376 Transitional schema directory")
    ap.add_argument("--max-per-part", type=int, default=5,
                    help="violations reported per part; one broken element can "
                         "produce hundreds and the first few are the actionable ones")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    def entry():
        pkg = open_document(args.src)
        root, source, tried = schema_dir(args.schemas)
        if root is None:
            # The loud degradation. Never "0 problems" from a run that checked
            # nothing — a green that cannot be told apart from an empty one is the
            # single outcome this capability was not allowed to have.
            fail("no ECMA-376 schemas could be found, so NOTHING was validated and "
                 "this is not a pass.\n  tried:\n    - "
                 + "\n    - ".join(tried)
                 + f"\n  The skill ships them in {BUNDLED.name}/; if that directory "
                   f"was stripped, pass --schemas DIR or set ${ENV_VAR}.")
        result = validate(pkg, root, args.max_per_part)
        report = {
            "in": args.src.name,
            "schemas": {"directory": str(root), "resolved_from": source,
                        "tried": tried},
            "parts_checked": len(result["checked"]),
            "checked": result["checked"],
            # Reported next to the verdict on purpose: "valid" means "valid where a
            # grammar existed", and the parts without one are how a reader knows the
            # difference.
            "not_checked": result["not_checked"],
            "violations": result["findings"],
            "violation_count": len(result["findings"]),
            "package_findings": check_package(pkg),
            "valid": not result["findings"],
        }
        emit(report, args.report, "violations", "checked", "not_checked",
             "package_findings")
        if result["findings"]:
            raise SystemExit(1)

    return run(entry)


if __name__ == "__main__":
    raise SystemExit(main())
