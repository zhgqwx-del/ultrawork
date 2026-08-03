#!/usr/bin/env python3
"""ECMA-376 child element order for WordprocessingML.

Most WordprocessingML content models are `xsd:sequence`, not `xsd:all`: the children
of `<w:pPr>` have a fixed order and a file that gets it wrong is invalid even though
every element in it is spelled correctly. Word's response is the "unreadable content"
repair dialog, and the repaired file has lost whatever it could not place.

Three shapes of rule live here, because WordprocessingML uses all three:

  SEQUENCES   a strict order over known children (`w:pPr`, `w:rPr`, `w:sectPr`, …)
  LEADING     elements that must come first, in this order, before free content
              (`w:pPr` in a `w:p`, `w:rPr` in a `w:r`, `w:tblPr`+`w:tblGrid` in a
              `w:tbl`) — the rest of the children are a repeatable choice
  TRAILING    elements that must come last (`w:sectPr` in `w:body`)

TRAILING is not a footnote. Appending a paragraph to `<w:body>` is the single most
common docx edit there is, and the obvious implementation — `body.append(p)` — puts
it after `<w:sectPr>`, which is invalid. `insert_ordered` is the only way anything
in this skill adds a child, precisely so that trap is closed once.

The sequences below are the schema's (ECMA-376 Part 1, §17.3 / §17.4 / §17.6) —
a published standard, not someone's code.
"""
from __future__ import annotations

MAIN_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

# CT_PPr (= EG_PPrBase + rPr + sectPr + pPrChange), §17.3.1.26.
PPR = (
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl",
    "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens",
    "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE",
    "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind",
    "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection",
    "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle",
    "rPr", "sectPr", "pPrChange",
)

# CT_RPr, §17.3.2.28. The four revision elements at the front belong to CT_ParaRPr
# (the run properties of a paragraph MARK, which is what a tracked paragraph
# insertion marks up); an ordinary run's rPr never carries them, so one table serves
# both without a document ever being able to tell.
RPR = (
    "ins", "del", "moveFrom", "moveTo",
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike",
    "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid",
    "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs",
    "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs",
    "em", "lang", "eastAsianLayout", "specVanish", "oMath", "rPrChange",
)

# CT_SectPr, §17.6.17. The header/footer references are an unbounded choice that
# precedes the sequence, so they all rank 0 and never fight each other.
SECTPR = (
    "headerReference", "footerReference",
    "footnotePr", "endnotePr", "type", "pgSz", "pgMar", "paperSrc", "pgBorders",
    "lnNumType", "pgNumType", "cols", "formProt", "vAlign", "noEndnote", "titlePg",
    "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings", "sectPrChange",
)

TBLPR = (
    "tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize",
    "tblStyleColBandSize", "tblW", "jc", "tblCellSpacing", "tblInd", "tblBorders",
    "shd", "tblLayout", "tblCellMar", "tblLook", "tblCaption", "tblDescription",
    "tblPrChange",
)

TCPR = (
    "cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap",
    "tcMar", "textDirection", "tcFitText", "vAlign", "hideMark", "headers",
    "tcPrChange",
)

TRPR = (
    "cnfStyle", "divId", "gridBefore", "gridAfter", "wBefore", "wAfter", "cantSplit",
    "trHeight", "tblHeader", "tblCellSpacing", "jc", "hidden", "ins", "del",
    "trPrChange",
)

# §17.7 — styles and numbering. Needed by the style and list capabilities; ordering
# mistakes there are just as fatal and far less obvious.
STYLES = ("docDefaults", "latentStyles", "style")
DOCDEFAULTS = ("rPrDefault", "pPrDefault")
STYLE = (
    "name", "aliases", "basedOn", "next", "link", "autoRedefine", "hidden",
    "uiPriority", "semiHidden", "unhideWhenUsed", "qFormat", "locked", "personal",
    "personalCompose", "personalReply", "rsid", "pPr", "rPr", "tblPr", "trPr",
    "tcPr", "tblStylePr",
)
NUMBERING = ("numPicBullet", "abstractNum", "num", "numIdMacAtCleanup")
ABSTRACTNUM = ("nsid", "multiLevelType", "tmpl", "name", "styleLink", "numStyleLink",
               "lvl")
LVL = ("start", "numFmt", "lvlRestart", "pStyle", "isLgl", "suff", "lvlText",
       "lvlPicBulletId", "legacy", "lvlJc", "pPr", "rPr")
NUMPR = ("ilvl", "numId", "numberingChange", "ins")

# CT_Settings, §17.15.1.78. Ninety-seven children in one xsd:sequence, and the two
# this skill has to write sit ~30 elements apart in the middle of it:
# `w:evenAndOddHeaders` (what makes an even-page header take effect at all) and
# `w:updateFields` (what asks the reader to refresh a table of contents). Appending
# either produces a settings part Word repairs. Transcribed from the vendored
# ECMA-376 schema rather than typed from memory — a published order, not a guess.
SETTINGS = (
    "writeProtection", "view", "zoom", "removePersonalInformation",
    "removeDateAndTime", "doNotDisplayPageBoundaries",
    "displayBackgroundShape", "printPostScriptOverText",
    "printFractionalCharacterWidth", "printFormsData", "embedTrueTypeFonts",
    "embedSystemFonts", "saveSubsetFonts", "saveFormsData", "mirrorMargins",
    "alignBordersAndEdges", "bordersDoNotSurroundHeader",
    "bordersDoNotSurroundFooter", "gutterAtTop", "hideSpellingErrors",
    "hideGrammaticalErrors", "activeWritingStyle", "proofState",
    "formsDesign", "attachedTemplate", "linkStyles", "stylePaneFormatFilter",
    "stylePaneSortMethod", "documentType", "mailMerge", "revisionView",
    "trackRevisions", "doNotTrackMoves", "doNotTrackFormatting",
    "documentProtection", "autoFormatOverride", "styleLockTheme",
    "styleLockQFSet", "defaultTabStop", "autoHyphenation",
    "consecutiveHyphenLimit", "hyphenationZone", "doNotHyphenateCaps",
    "showEnvelope", "summaryLength", "clickAndTypeStyle", "defaultTableStyle",
    "evenAndOddHeaders", "bookFoldRevPrinting", "bookFoldPrinting",
    "bookFoldPrintingSheets", "drawingGridHorizontalSpacing",
    "drawingGridVerticalSpacing", "displayHorizontalDrawingGridEvery",
    "displayVerticalDrawingGridEvery", "doNotUseMarginsForDrawingGridOrigin",
    "drawingGridHorizontalOrigin", "drawingGridVerticalOrigin",
    "doNotShadeFormData", "noPunctuationKerning", "characterSpacingControl",
    "printTwoOnOne", "strictFirstAndLastChars", "noLineBreaksAfter",
    "noLineBreaksBefore", "savePreviewPicture", "doNotValidateAgainstSchema",
    "saveInvalidXml", "ignoreMixedContent", "alwaysShowPlaceholderText",
    "doNotDemarcateInvalidXml", "saveXmlDataOnly", "useXSLTWhenSaving",
    "saveThroughXslt", "showXMLTags", "alwaysMergeEmptyNamespace",
    "updateFields", "hdrShapeDefaults", "footnotePr", "endnotePr", "compat",
    "docVars", "rsids", "attachedSchema", "themeFontLang", "clrSchemeMapping",
    "doNotIncludeSubdocsInStats", "doNotAutoCompressPictures", "forceUpgrade",
    "captions", "readModeInkLockDown", "smartTagType", "shapeDefaults",
    "doNotEmbedSmartTags", "decimalSymbol", "listSeparator",
)

SEQUENCES = {
    "pPr": PPR, "rPr": RPR, "sectPr": SECTPR, "tblPr": TBLPR, "tcPr": TCPR,
    "trPr": TRPR, "styles": STYLES, "docDefaults": DOCDEFAULTS, "style": STYLE,
    "numbering": NUMBERING, "abstractNum": ABSTRACTNUM, "lvl": LVL, "numPr": NUMPR,
    "settings": SETTINGS,
}

# Children that must precede the free content of a mixed model, in this order.
LEADING = {
    "p": ("pPr",),
    "r": ("rPr",),
    "tbl": ("tblPr", "tblGrid"),
    "tr": ("trPr",),
    "tc": ("tcPr",),
}

# Children that must come last. `w:body`'s `w:sectPr` is the one that bites.
TRAILING = {
    "body": ("sectPr",),
}


def local(tag) -> str:
    tag = str(tag)
    return tag.rsplit("}", 1)[-1]


def q(tag: str) -> str:
    return f"{{{MAIN_NS}}}{tag}"


def _rank(seq: tuple[str, ...], name: str) -> int:
    """Position in a sequence; the header/footer references share rank 0."""
    return seq.index(name)


def insert_ordered(parent, child) -> None:
    """Put `child` where the schema says it goes among `parent`'s children.

    An unknown tag (a namespace this file does not model) is appended and left
    alone rather than sorted to some guessed position — moving an element whose
    place is not known is worse than leaving it where its producer put it.
    """
    pname, cname = local(parent.tag), local(child.tag)
    seq = SEQUENCES.get(pname)
    if seq is not None and cname in seq:
        rank = _rank(seq, cname)
        for existing in parent:
            other = local(existing.tag)
            if other in seq and _rank(seq, other) > rank:
                existing.addprevious(child)
                return
        parent.append(child)
        return

    leading = LEADING.get(pname, ())
    if cname in leading:
        rank = leading.index(cname)
        for existing in parent:
            other = local(existing.tag)
            if other not in leading or leading.index(other) > rank:
                existing.addprevious(child)
                return
        parent.append(child)
        return

    trailing = TRAILING.get(pname, ())
    if trailing and cname not in trailing:
        for existing in parent:
            if local(existing.tag) in trailing:
                existing.addprevious(child)
                return
    parent.append(child)


def out_of_order(parent) -> list[str]:
    """Children that appear before a sibling the schema puts earlier.

    Reported rather than silently fixed at this layer: an element in the wrong place
    means some writer has a bug, and quietly reordering it hides which one. The
    repair is a separate, explicit request (`docx_package.py --fix-order`).
    """
    pname = local(parent.tag)
    findings: list[str] = []

    seq = SEQUENCES.get(pname)
    if seq is not None:
        high = -1
        for c in parent:
            name = local(c.tag)
            if name not in seq:
                continue
            rank = _rank(seq, name)
            if rank < high:
                findings.append(name)
            high = max(high, rank)

    leading = LEADING.get(pname, ())
    if leading:
        seen_free = False
        for c in parent:
            name = local(c.tag)
            if name in leading:
                if seen_free:
                    findings.append(name)
            else:
                seen_free = True

    for name in TRAILING.get(pname, ()):
        kids = list(parent)
        for i, c in enumerate(kids):
            if local(c.tag) == name and i != len(kids) - 1:
                findings.append(name)
    return findings


def walk_out_of_order(root) -> list[tuple[str, list[str]]]:
    """Every element in the tree whose children are out of order.

    Returns (element path, misplaced child names). The path is the chain of local
    names with an index, so a report can say WHICH paragraph rather than "some
    paragraph" — a fix nobody can locate is not a fix.
    """
    out: list[tuple[str, list[str]]] = []

    def visit(el, path: str) -> None:
        bad = out_of_order(el)
        if bad:
            out.append((path, bad))
        counts: dict[str, int] = {}
        for child in el:
            name = local(child.tag)
            counts[name] = counts.get(name, 0) + 1
            visit(child, f"{path}/{name}[{counts[name]}]")

    visit(root, local(root.tag))
    return out


def reorder(parent) -> bool:
    """Sort `parent`'s children into schema order. True if anything moved.

    Only elements the schema models are moved; anything else keeps its position
    relative to the elements around it, because an element this file cannot place
    is one it must not guess about.
    """
    pname = local(parent.tag)
    seq = SEQUENCES.get(pname)
    leading = LEADING.get(pname, ())
    trailing = TRAILING.get(pname, ())
    if not (seq or leading or trailing):
        return False

    kids = list(parent)

    def key(item):
        i, el = item
        name = local(el.tag)
        if seq is not None and name in seq:
            return (0, _rank(seq, name), i)
        if name in leading:
            return (-1, leading.index(name), i)
        if name in trailing:
            return (1, trailing.index(name), i)
        return (0, len(seq) if seq else 0, i)

    ordered = [el for _, el in sorted(enumerate(kids), key=key)]
    if ordered == kids:
        return False
    for el in ordered:
        parent.append(el)          # lxml append MOVES an existing child
    return True
