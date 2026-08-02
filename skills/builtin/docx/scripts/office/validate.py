#!/usr/bin/env python3
"""Is this package internally consistent?

Not schema validation — that needs the ECMA-376 XSDs, which are not shipped with
the skill. This is the layer below: the wiring. Every part declared, every
relationship resolving to something that exists, every XML part parsing, every
`r:id` in the document body backed by a Relationship, and the element order the
schema fixes.

It is worth having separately from "does the library reopen it" because a library
is forgiving in exactly the places a different reader is not: python-docx will
happily reopen a document whose `r:embed` points at an image that is no longer in
the package, and Word will not.
"""
from __future__ import annotations

import re

from .package import CONTENT_TYPES, Package
from .xmlorder import MAIN_NS, walk_out_of_order

REQUIRED_DOCX_PARTS = ("[Content_Types].xml", "_rels/.rels", "word/document.xml")

REL_ATTR_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# Parts whose child ordering this file understands. Anything else is left alone
# rather than judged by a model it does not have.
ORDERED_PARTS = re.compile(
    r"^word/(document|styles|numbering|header\d*|footer\d*|footnotes|endnotes)\.xml$")


def rel_ids_used(root) -> set[str]:
    """Every r:id / r:embed / r:link referenced anywhere under `root`."""
    used: set[str] = set()
    for el in root.iter():
        for attr, value in el.attrib.items():
            if str(attr).startswith(f"{{{REL_ATTR_NS}}}") and value:
                used.add(value)
    return used


def check_package(pkg: Package, kind: str = "docx") -> list[str]:
    """Returns a list of findings; empty means consistent."""
    from lxml import etree
    findings: list[str] = []
    names = set(pkg.names())

    if kind == "docx":
        for req in REQUIRED_DOCX_PARTS:
            if req not in names:
                findings.append(f"required part missing: {req}")

    for name in sorted(names):
        if not name.endswith((".xml", ".rels")):
            continue
        try:
            etree.fromstring(pkg.parts[name])
        except etree.XMLSyntaxError as e:
            findings.append(f"{name} will not parse: {e}")

    if CONTENT_TYPES in names:
        for name in sorted(names):
            if name == CONTENT_TYPES or name.endswith(".rels"):
                continue  # .rels is covered by a Default extension, never an Override
            try:
                if pkg.content_type(name) is None:
                    findings.append(f"{name} has no content type — neither an Override "
                                    f"nor a Default for its extension")
            except Exception as e:  # noqa: BLE001 - a broken [Content_Types] already reported
                findings.append(f"cannot resolve the content type of {name}: {e}")
                break

    for rels_part in sorted(pkg.rels_parts()):
        owner = rels_part.replace("_rels/", "", 1)[:-len(".rels")]
        if owner and owner not in names:
            findings.append(f"{rels_part} describes {owner}, which is not in the package")
        for rel in pkg.relationships(rels_part):
            if rel["mode"] == "External":
                continue
            if rel["resolved"] not in names:
                findings.append(f"{rels_part} relationship {rel['id']} points at "
                                f"{rel['resolved']}, which is not in the package")

    # An r:id with no Relationship behind it is the failure that produces a document
    # whose images are gone and whose hyperlinks do nothing, while every part is
    # still present and every XML file still parses.
    for name in sorted(n for n in names if n.startswith("word/") and n.endswith(".xml")):
        rels_part = Package.rels_part_of(name)
        declared = {r["id"] for r in pkg.relationships(rels_part)}
        try:
            root = pkg.tree(name)
        except Exception:  # noqa: BLE001 - unparseable already reported above
            continue
        for rid in sorted(rel_ids_used(root) - declared):
            findings.append(f"{name} references r:id={rid} with no matching "
                            f"relationship in {rels_part}")

    for name in sorted(n for n in names if ORDERED_PARTS.match(n)):
        try:
            root = pkg.tree(name)
        except Exception:  # noqa: BLE001 - unparseable already reported above
            continue
        for path, bad in walk_out_of_order(root):
            findings.append(f"{name}: {path} has {', '.join(sorted(set(bad)))} out of "
                            f"the ECMA-376 order — Word will offer to repair this file")
    return findings


def is_wordprocessing(pkg: Package) -> bool:
    """A cheap sanity gate: does this package actually hold a Word document?"""
    if "word/document.xml" not in pkg.parts:
        return False
    try:
        return str(pkg.tree("word/document.xml").tag) == f"{{{MAIN_NS}}}document"
    except Exception:  # noqa: BLE001
        return False
