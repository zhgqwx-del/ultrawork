"""Shared OOXML plumbing for the ultrawork office skills (self-written).

Each office skill carries its OWN copy of this package (discussions/059 §4·补):
`scripts/pack-builtin-skills.ts` refuses to pack a symlink, so a shared base layer
would have to be a build-time copy — and the decision was to let the copies evolve
independently rather than add a sync step nobody would notice breaking. The docx
copy therefore differs from the xlsx one where WordprocessingML differs from
SpreadsheetML, and `document.py` has no counterpart there at all.

    package  — the zip: parts, content types, relationships, and the graft that
               puts back what a library dropped
    document — the WordprocessingML body: paragraphs, runs, and the text spans that
               cross run boundaries (which is where docx editing actually goes wrong)
    soffice  — finding LibreOffice on three platforms, and converting with it
    validate — is this package internally consistent
    xmlorder — ECMA-376 child ordering, which readers enforce and writers forget
"""
