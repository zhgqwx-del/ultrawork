#!/usr/bin/env python3
"""Is this package internally consistent?

Not schema validation — that needs the ECMA-376 XSDs, which are not shipped here.
This is the layer below: the wiring. Every part declared, every relationship
resolving to something that exists, every XML part parsing, and the worksheet
children in schema order.

It is worth having separately from "does the library reopen it" because a library
is forgiving in exactly the places a different reader is not: openpyxl will happily
reopen a workbook whose relationship points at a part that is no longer there.
"""
from __future__ import annotations

from .package import CONTENT_TYPES, Package
from .xmlorder import out_of_order

REQUIRED_XLSX_PARTS = ("[Content_Types].xml", "_rels/.rels", "xl/workbook.xml")


def check_package(pkg: Package, kind: str = "xlsx") -> list[str]:
    """Returns a list of findings; empty means consistent."""
    from lxml import etree
    findings: list[str] = []
    names = set(pkg.names())

    if kind == "xlsx":
        for req in REQUIRED_XLSX_PARTS:
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
        if owner and owner not in names and owner != "":
            findings.append(f"{rels_part} describes {owner}, which is not in the package")
        for rel in pkg.relationships(rels_part):
            if rel["mode"] == "External":
                continue
            if rel["resolved"] not in names:
                findings.append(f"{rels_part} relationship {rel['id']} points at "
                                f"{rel['resolved']}, which is not in the package")

    for name in sorted(n for n in names if n.startswith("xl/worksheets/sheet")
                       and n.endswith(".xml")):
        try:
            bad = out_of_order(pkg.tree(name))
        except Exception:  # noqa: BLE001 - unparseable already reported above
            continue
        if bad:
            findings.append(f"{name}: {', '.join(bad)} appear(s) after an element the "
                            f"ECMA-376 sequence puts later — Excel will offer to repair "
                            f"this file")
    return findings
