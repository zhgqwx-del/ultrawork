#!/usr/bin/env python3
"""ECMA-376 child element order.

SpreadsheetML content models are xsd:sequence, not xsd:all: the children of
`<worksheet>` have a fixed order and a file that gets it wrong is invalid even
though every element in it is spelled correctly. Excel's response is the
"unreadable content" repair dialog, and the repaired file has lost whatever it
could not place.

This bites specifically when INSERTING. Appending `<cols>` to the end of a
worksheet is the natural thing to write and puts it after `<sheetData>`, which is
backwards. Hence `insert_ordered`, which is the only way anything in this skill is
allowed to add a child to a worksheet.

The sequences below are the schema's, which is a published standard (ECMA-376
Part 1, §18.3.1) — a fact, not someone's code.
"""
from __future__ import annotations

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

# CT_Worksheet, in schema order.
WORKSHEET = (
    "sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData",
    "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter",
    "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr",
    "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions",
    "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks",
    "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing",
    "drawingHF", "picture", "oleObjects", "controls", "webPublishItems",
    "tableParts", "extLst",
)

# CT_Workbook, in schema order.
WORKBOOK = (
    "fileVersion", "fileSharing", "workbookPr", "workbookProtection", "bookViews",
    "sheets", "functionGroups", "externalReferences", "definedNames", "calcPr",
    "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes",
    "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst",
)

SEQUENCES = {"worksheet": WORKSHEET, "workbook": WORKBOOK}


def local(tag) -> str:
    tag = str(tag)
    return tag.rsplit("}", 1)[-1]


def q(tag: str) -> str:
    return f"{{{MAIN_NS}}}{tag}"


def insert_ordered(parent, child) -> None:
    """Put `child` where the schema says it goes among `parent`'s children.

    An unknown tag (a namespace this file does not model) is appended and left
    alone rather than sorted to some guessed position — moving an element whose
    place is not known is worse than leaving it where its producer put it.
    """
    seq = SEQUENCES.get(local(parent.tag))
    name = local(child.tag)
    if seq is None or name not in seq:
        parent.append(child)
        return
    rank = seq.index(name)
    for existing in parent:
        other = local(existing.tag)
        if other in seq and seq.index(other) > rank:
            existing.addprevious(child)
            return
    parent.append(child)


def out_of_order(parent) -> list[str]:
    """Children that appear before a sibling the schema puts earlier.

    Reported rather than silently fixed: an element in the wrong place means some
    writer has a bug, and quietly reordering it hides which one.
    """
    seq = SEQUENCES.get(local(parent.tag))
    if seq is None:
        return []
    ranks = [(local(c.tag), seq.index(local(c.tag)))
             for c in parent if local(c.tag) in seq]
    findings, high = [], -1
    for name, rank in ranks:
        if rank < high:
            findings.append(name)
        high = max(high, rank)
    return findings
