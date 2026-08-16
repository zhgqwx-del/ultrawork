#!/usr/bin/env python3
"""OOXML package: unpack, pack, and the fidelity graft.

A .docx is a zip of parts wired together by two indexes: `[Content_Types].xml`
says what each part IS, and the `.rels` parts say who POINTS at it. A part is only
really present when all three exist, which is why restoring one means restoring
three things — and why deleting one means deleting three.

⚠️ The measured picture for .docx is NOT the one for .xlsx, and copying the xlsx
story over would have been a lie. Round-tripping a document through
`python-docx.Document(p).save(q)` — the library everybody reaches for — drops
NOTHING: 17 of 17 parts came back byte-identical (measured 2026-08-02). python-docx
holds the package open at the OPC layer and rewrites the parts it has models for,
so unknown parts survive. openpyxl rebuilds a workbook from its object model, which
is why the xlsx skill needs a graft on every write and this one does not.

What python-docx *does* drop, measured the same day: a part that no relationship
points at. Injecting `word/orphan.xml` with a content-type Override but no
Relationship, then re-saving, loses it. That is a narrow case and it is written
down here rather than advertised, because the honest headline for docx editing is
elsewhere — see `document.py` on text that spans runs.

So the graft below exists for a different reason than xlsx's: it is what makes
`drop`/`restore` symmetric and what lets a caller prove a package survived a
third-party tool, not a bandage applied on every write.
"""
from __future__ import annotations

import posixpath
import zipfile
from pathlib import Path

CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES = "[Content_Types].xml"

# Parts that must never be carried across an edit because their content is a cache
# of something the edit may have changed. SpreadsheetML has one (`xl/calcChain.xml`);
# WordprocessingML has no equivalent — a Word document carries no derived index that
# goes stale when text changes. The dict is kept, and kept empty, so that "nothing
# is volatile here" reads as a decision rather than an oversight.
VOLATILE_PARTS: dict[str, str] = {}


class PackageError(Exception):
    """Something about the package itself is wrong, in words the caller can act on."""


def _q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


class Package:
    """Every part of an OOXML file, in the order the zip stored them.

    Held in memory on purpose: these are single-digit-MB documents, and a
    read-modify-write that streams would have to decide midway what the output
    looks like. Order is preserved because `[Content_Types].xml` conventionally
    comes first and some readers are less relaxed about that than the spec is.
    """

    def __init__(self, parts: dict[str, bytes], order: list[str]):
        self.parts = parts
        self.order = order

    # ── in / out ──────────────────────────────────────────────────────────────
    @classmethod
    def open(cls, path: Path) -> "Package":
        if not path.is_file():
            raise PackageError(f"no such file: {path}")
        try:
            with zipfile.ZipFile(path) as z:
                order = [i.filename for i in z.infolist() if not i.filename.endswith("/")]
                parts = {n: z.read(n) for n in order}
        except zipfile.BadZipFile as e:
            raise PackageError(f"{path.name} is not a readable OOXML package "
                               f"(a .docx is a zip): {e}") from e
        if CONTENT_TYPES not in parts:
            raise PackageError(f"{path.name} has no {CONTENT_TYPES} — it is a zip, "
                               f"but not an Office document")
        return cls(parts, order)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Content types first: the spec does not require it, but it is what every
        # producer does, and a reader that assumes it is not a reader we can fix.
        names = ([CONTENT_TYPES] if CONTENT_TYPES in self.parts else []) + \
                [n for n in self.order if n != CONTENT_TYPES]
        names += [n for n in self.parts if n not in names]
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for n in names:
                if n in self.parts:
                    z.writestr(n, self.parts[n])

    # ── parts ─────────────────────────────────────────────────────────────────
    def names(self) -> list[str]:
        return list(self.parts)

    def has(self, name: str) -> bool:
        return name in self.parts

    def read(self, name: str) -> bytes:
        if name not in self.parts:
            raise PackageError(f"package has no part {name}")
        return self.parts[name]

    def write(self, name: str, data: bytes) -> None:
        if name not in self.parts:
            self.order.append(name)
        self.parts[name] = data

    def drop(self, name: str) -> None:
        """Remove a part AND everything that points at it.

        Removing only the bytes leaves a Relationship and a content-type Override
        aimed at nothing — a package that is broken in a way readers do notice. This
        is the mirror image of `graft_missing_parts`: a part is three things, so
        both adding and removing one are three edits.
        """
        if name not in self.parts:
            return
        self.parts.pop(name, None)
        self.order = [n for n in self.order if n != name]
        root = self.tree(CONTENT_TYPES)
        for el in list(root):
            if el.tag == _q(CT_NS, "Override") and el.get("PartName") == "/" + name:
                root.remove(el)
        self.put_tree(CONTENT_TYPES, root)
        for rels_part in self.rels_parts():
            tree = self.tree(rels_part)
            removed = False
            for el in list(tree):
                if el.tag != _q(REL_NS, "Relationship"):
                    continue
                if el.get("TargetMode") == "External":
                    continue
                if self.resolve_target(rels_part, el.get("Target") or "") == name:
                    tree.remove(el)
                    removed = True
            if removed:
                self.put_tree(rels_part, tree)

    def tree(self, name: str):
        """Parse a part as XML, or say which part failed rather than raising lxml's."""
        from lxml import etree
        try:
            return etree.fromstring(self.read(name))
        except etree.XMLSyntaxError as e:
            raise PackageError(f"{name} is not well-formed XML: {e}") from e

    def put_tree(self, name: str, root) -> None:
        from lxml import etree
        self.write(name, etree.tostring(root, xml_declaration=True, encoding="UTF-8",
                                        standalone=True))

    # ── content types ─────────────────────────────────────────────────────────
    def content_type(self, name: str) -> str | None:
        """What this part IS: an explicit Override, else the Default for its extension."""
        root = self.tree(CONTENT_TYPES)
        for el in root:
            if el.tag == _q(CT_NS, "Override") and el.get("PartName") == "/" + name:
                return el.get("ContentType")
        ext = posixpath.splitext(name)[1].lstrip(".").lower()
        for el in root:
            if el.tag == _q(CT_NS, "Default") and (el.get("Extension") or "").lower() == ext:
                return el.get("ContentType")
        return None

    def set_override(self, name: str, content_type: str) -> None:
        from lxml import etree
        root = self.tree(CONTENT_TYPES)
        for el in root:
            if el.tag == _q(CT_NS, "Override") and el.get("PartName") == "/" + name:
                el.set("ContentType", content_type)
                self.put_tree(CONTENT_TYPES, root)
                return
        etree.SubElement(root, _q(CT_NS, "Override"), PartName="/" + name,
                         ContentType=content_type)
        self.put_tree(CONTENT_TYPES, root)

    def set_default(self, extension: str, content_type: str) -> None:
        """Declare a Default for an extension, if one is not already declared.

        Adding `word/media/image1.png` to a package that has never held a PNG needs
        this: without a Default (or an Override) the part has no content type, and
        Word treats a package with an undeclared part as damaged.
        """
        from lxml import etree
        ext = extension.lstrip(".").lower()
        root = self.tree(CONTENT_TYPES)
        for el in root:
            if el.tag == _q(CT_NS, "Default") and (el.get("Extension") or "").lower() == ext:
                return
        first_override = next((el for el in root if el.tag == _q(CT_NS, "Override")), None)
        node = etree.Element(_q(CT_NS, "Default"), Extension=ext, ContentType=content_type)
        if first_override is not None:
            first_override.addprevious(node)   # Defaults precede Overrides by convention
        else:
            root.append(node)
        self.put_tree(CONTENT_TYPES, root)

    # ── relationships ─────────────────────────────────────────────────────────
    @staticmethod
    def rels_part_of(owner: str) -> str:
        """`word/document.xml` → `word/_rels/document.xml.rels`; `` → `_rels/.rels`."""
        d, base = posixpath.split(owner)
        return posixpath.join(d, "_rels", base + ".rels") if d else \
            posixpath.join("_rels", base + ".rels")

    @staticmethod
    def resolve_target(rels_part: str, target: str) -> str:
        """The part a Relationship points at, as a package-absolute name.

        A Target is relative to the OWNER's directory, not to the .rels file's. Both
        live in the same folder except that the .rels file sits one level down in
        `_rels/`, so the owner directory is the .rels part's grandparent.
        """
        if target.startswith("/"):
            return target.lstrip("/")
        owner_dir = posixpath.dirname(posixpath.dirname(rels_part))
        return posixpath.normpath(posixpath.join(owner_dir, target)).lstrip("./")

    def rels_parts(self) -> list[str]:
        return [n for n in self.parts if n.endswith(".rels")]

    def relationships(self, rels_part: str) -> list[dict]:
        if rels_part not in self.parts:
            return []
        return [{"id": el.get("Id"), "type": el.get("Type"), "target": el.get("Target"),
                 "mode": el.get("TargetMode"),
                 "resolved": self.resolve_target(rels_part, el.get("Target") or "")}
                for el in self.tree(rels_part) if el.tag == _q(REL_NS, "Relationship")]

    def add_relationship(self, rels_part: str, rel_type: str, target: str,
                         mode: str | None = None) -> str:
        """Append a Relationship with a free Id and return it.

        The Id must be allocated, never copied: a library that rewrites a package
        renumbers rIds freely, so the rId a part had in the input routinely means
        something else in the output. Reusing it silently repoints an existing link.
        """
        from lxml import etree
        if rels_part in self.parts:
            root = self.tree(rels_part)
        else:
            root = etree.Element(_q(REL_NS, "Relationships"))
        used = {el.get("Id") for el in root}
        n = 1
        while f"rId{n}" in used:
            n += 1
        attrs = {"Id": f"rId{n}", "Type": rel_type, "Target": target}
        if mode:
            attrs["TargetMode"] = mode
        etree.SubElement(root, _q(REL_NS, "Relationship"), **attrs)
        self.put_tree(rels_part, root)
        return f"rId{n}"

    def free_part_name(self, pattern: str) -> str:
        """`word/media/image{n}.png` → the first name that is not taken."""
        n = 1
        while pattern.format(n=n) in self.parts:
            n += 1
        return pattern.format(n=n)


# ── the graft ─────────────────────────────────────────────────────────────────
def graft_missing_parts(baseline: Package, produced: Package) -> dict:
    """Put back every part of `baseline` that `produced` lost.

    Returns a report — always, including when nothing was lost. A caller that only
    hears about failures cannot tell "nothing was dropped" from "nobody looked".

    What it restores per part: the bytes, the `[Content_Types].xml` Override, and
    every Relationship that pointed at it, each with a freshly allocated Id.
    """
    restored: list[dict] = []
    skipped: list[dict] = []
    before = set(baseline.parts)
    after = set(produced.parts)
    for name in sorted(before - after):
        if name in VOLATILE_PARTS:
            skipped.append({"part": name, "bytes": len(baseline.parts[name]),
                            "reason": VOLATILE_PARTS[name], "deliberate": True})
            continue
        produced.write(name, baseline.parts[name])
        entry = {"part": name, "bytes": len(baseline.parts[name]), "rels": []}
        ct = baseline.content_type(name)
        # Only an Override needs restoring; a Default is keyed on the extension and
        # the writer's own Defaults already cover .xml.
        if ct and _has_override(baseline, name):
            produced.set_override(name, ct)
            entry["content_type"] = ct
        for rels_part in baseline.rels_parts():
            for rel in baseline.relationships(rels_part):
                if rel["resolved"] == name and rel["mode"] != "External":
                    if _already_linked(produced, rels_part, name):
                        continue
                    new_id = produced.add_relationship(rels_part, rel["type"],
                                                       rel["target"])
                    entry["rels"].append({"from": rels_part, "id": new_id,
                                          "was": rel["id"]})
        restored.append(entry)
    return {"restored": restored, "skipped": skipped,
            "restored_count": len(restored), "skipped_count": len(skipped)}


def _has_override(pkg: Package, name: str) -> bool:
    root = pkg.tree(CONTENT_TYPES)
    return any(el.tag == _q(CT_NS, "Override") and el.get("PartName") == "/" + name
               for el in root)


def _already_linked(pkg: Package, rels_part: str, name: str) -> bool:
    return any(r["resolved"] == name for r in pkg.relationships(rels_part))


def part_is_inert(name: str, data: bytes) -> bool:
    """True when losing this part loses nothing.

    Counting parts is not a fidelity test. An empty `.rels` holding zero
    Relationship elements is routinely omitted by writers and that is correct;
    a 900-byte `customXml/item1.xml` looks the same from a part list and is real
    data. Same symptom, opposite verdicts — only the content separates them.
    """
    from lxml import etree
    if not data.strip():
        return True
    if not name.endswith((".xml", ".rels")):
        return False
    try:
        root = etree.fromstring(data)
    except etree.XMLSyntaxError:
        return False
    return len(root) == 0 and not (root.text or "").strip()
