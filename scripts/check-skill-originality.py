#!/usr/bin/env python3
"""Clean-room compliance gate for hand-written builtin skills (discussions/059 §5 L0).

Proves that a skill we claim to have written ourselves shares no bytes — and no
suspicious phrasing — with the third-party reference copies in skill_reference/.
Anthropic's docx/pdf/pptx/xlsx skills are proprietary and non-redistributable
(see skills/builtin/README.md); ultrawork ships signed installers, so a single
copied file contaminates the distribution.

    python3 scripts/check-skill-originality.py --target skills/builtin/pdf
    python3 scripts/check-skill-originality.py --target skills/builtin/pdf --json

The reference corpus lives OUTSIDE the repo and is not in git. Point at it with
--reference or $SKILL_REFERENCE_DIR. Without it the script exits 2 (skipped, not
red) — so this gate can only run locally, never in CI. Run it before every PR that
adds skill content and paste the report.

Exit 0 = clean, 1 = violation, 2 = reference corpus unavailable (skipped).
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

# ── stdout must be UTF-8 on every platform, and on Windows it is not ──────────
# This gate prints ✅/❌ and Chinese. Windows encodes a CAPTURED stdout in the
# machine's ANSI code page and Python only defaults to UTF-8 from 3.15 (PEP 686);
# CI pins 3.11. Measured on CI: this script died with
# `UnicodeEncodeError: 'charmap' codec can't encode character '\u2705'` inside its
# own `print(json.dumps(...))`. The skills were fixed for this first and the GATES
# were missed — the same defect has two homes, and only one of them was product.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (ValueError, OSError):        # already detached / not reconfigurable
            pass


REPO = Path(__file__).resolve().parent.parent

# Files below this many normalized words can collide innocently (empty __init__.py,
# one-line shims, tiny JSON). Reporting them would bury the real signal.
TRIVIAL_WORDS = 40
SHINGLE = 5
DEFAULT_THRESHOLD = 0.6

# AST node-type vocabulary is small (~100), so structural n-grams need to be longer
# than word n-grams to carry the same discriminating power. Threshold is calibrated
# in scripts/test-skill-originality.py against both a known-rewrite (must fire) and
# our own independently written scripts (must not) — do not tune it by intuition.
AST_SHINGLE = 7
DEFAULT_AST_THRESHOLD = 0.55
TRIVIAL_AST_NODES = 60

TEXT_SUFFIXES = {".py", ".md", ".js", ".mjs", ".ts", ".json", ".css", ".html",
                 ".txt", ".yaml", ".yml", ".toml", ".xml", ".sh", ".ps1"}

# License/notice files are EXEMPT from the byte-identical check: Apache-2.0 full text
# is supposed to be byte-identical everywhere, and flagging it buries the real signal.
# They still get scanned for the proprietary markers below.
LICENSE_NAMES = re.compile(r"^(LICENSE|LICENCE|NOTICE|COPYING)(\.[a-z]+)?$", re.I)

# Markers of the proprietary Anthropic skill license (the 1467-byte LICENSE.txt),
# NOT of Anthropic authorship as such — Apache-2.0 skills legitimately carry
# "Copyright 2026 Anthropic, PBC." on line 190 of the standard license text, and
# matching on the company name alone flags those as violations.
BANNED_PATTERNS = [
    (re.compile(r"^\s*license:\s*proprietary", re.I | re.M),
     "frontmatter declares Proprietary license"),
    (re.compile(r"Extract these materials from the Services", re.I),
     "proprietary license clause (no-extraction)"),
    (re.compile(r"Create derivative works based on these materials", re.I),
     "proprietary license clause (no-derivatives)"),
    (re.compile(r"Anthropic[^\n]{0,20}All rights reserved", re.I),
     "Anthropic all-rights-reserved notice"),
]


def normalized_words(text: str) -> list[str]:
    return re.sub(r"[^0-9a-z一-鿿]+", " ", text.lower()).split()


class _Skeleton(ast.NodeVisitor):
    """Pre-order sequence of AST node types — identifiers and literals discarded."""

    def __init__(self) -> None:
        self.seq: list[str] = []

    def generic_visit(self, node: ast.AST) -> None:
        self.seq.append(type(node).__name__)
        super().generic_visit(node)


def ast_shingles(text: str) -> set[str]:
    """Structural fingerprint of Python source, immune to renaming and re-commenting.

    Word-level shingles do NOT survive a lazy rewrite: identifiers are dense in code,
    so renaming a handful of them shatters nearly every n-gram and the score collapses
    to ~0. Measured: a copy of fill_fillable_fields.py with 6 identifiers renamed and
    comments reworded scored 0.02 on words but 1.00 here. The realistic clean-room
    failure mode is "wrote it while looking at theirs", which this catches and the
    word-level check does not.
    """
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, RecursionError):
        return set()
    v = _Skeleton()
    v.visit(tree)
    seq = v.seq
    if len(seq) < AST_SHINGLE:
        return set()
    return {"|".join(seq[i:i + AST_SHINGLE]) for i in range(len(seq) - AST_SHINGLE + 1)}


def shingles(words: list[str]) -> set[str]:
    if len(words) < SHINGLE:
        return {" ".join(words)} if words else set()
    return {" ".join(words[i:i + SHINGLE]) for i in range(len(words) - SHINGLE + 1)}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def walk_files(root: Path) -> list[Path]:
    return [p for p in sorted(root.rglob("*"))
            if p.is_file() and "__pycache__" not in p.parts and not p.name.startswith(".")]


def build_reference_index(ref_root: Path):
    """sha256 -> paths; suffix -> word shingles; and a separate Python AST index."""
    by_hash: dict[str, list[Path]] = defaultdict(list)
    by_suffix: dict[str, list[tuple[Path, set[str]]]] = defaultdict(list)
    by_ast: list[tuple[Path, set[str]]] = []
    for p in walk_files(ref_root):
        try:
            raw = p.read_bytes()
        except OSError:
            continue
        by_hash[hashlib.sha256(raw).hexdigest()].append(p)
        if p.suffix.lower() not in TEXT_SUFFIXES:
            continue
        text = read_text(p)
        if text is None:
            continue
        words = normalized_words(text)
        if len(words) >= TRIVIAL_WORDS:
            by_suffix[p.suffix.lower()].append((p, shingles(words)))
        if p.suffix.lower() == ".py":
            sk = ast_shingles(text)
            if len(sk) >= TRIVIAL_AST_NODES:
                by_ast.append((p, sk))
    return by_hash, by_suffix, by_ast


def best_match(mine: set[str], corpus) -> tuple[float, Path | None]:
    best, best_ref = 0.0, None
    for ref_path, ref_shingles in corpus:
        score = jaccard(mine, ref_shingles)
        if score > best:
            best, best_ref = score, ref_path
    return best, best_ref


# ── provenance: a published standard is not a clone of whoever else vendored it ──
# `scripts/schemas/ecma376/` is this repository's OWN vendored copy of the ECMA-376
# Transitional schemas, with its provenance recorded in that directory's NOTICE
# (source archive, sha256 prefix, download date, the two documented patches).
#
# Anthropic's proprietary docx skill bundles the same published standard. So does
# anyone else who validates OOXML. The result, measured: 6 of the 13 schema files the
# docx skill ships are byte-identical to files inside that proprietary bundle, and
# 5 more are identical once line endings are normalised — because they ARE the same
# ECMA files. A byte-identity check cannot tell that apart from copying, and it
# should not try to guess.
#
# So the exemption is by PROVENANCE, not by path: a file is exempt only when it is
# byte-identical to something in our own documented upstream copy. That cannot
# launder a copied file — the file would have to be placed in `scripts/schemas/`
# first, which is a visible, reviewable act against a directory whose NOTICE says
# exactly what is in it. And every exemption granted is REPORTED, never silent.
VENDORED_UPSTREAM = (REPO / "scripts" / "schemas" / "ecma376",)


def upstream_digests() -> dict[str, Path]:
    out: dict[str, Path] = {}
    for root in VENDORED_UPSTREAM:
        if not root.is_dir():
            continue
        for f in root.rglob("*"):
            if f.is_file():
                try:
                    out[hashlib.sha256(f.read_bytes()).hexdigest()] = f
                except OSError:
                    continue
    return out


def check_target(target: Path, ref_root: Path, by_hash, by_suffix, by_ast,
                 threshold: float, ast_threshold: float, allow: set[str]) -> list[dict]:
    findings: list[dict] = []
    UPSTREAM = upstream_digests()
    for p in walk_files(target):
        rel = p.relative_to(REPO).as_posix() if p.is_relative_to(REPO) else p.as_posix()
        if rel in allow:
            continue
        try:
            raw = p.read_bytes()
        except OSError:
            continue

        is_license = bool(LICENSE_NAMES.match(p.name))
        digest = hashlib.sha256(raw).hexdigest()
        if digest in by_hash and not is_license:
            upstream = UPSTREAM.get(digest)
            if upstream is not None:
                # Same bytes as the reference corpus AND as our own documented
                # upstream. Reported so the exemption is visible, never silent.
                findings.append({
                    "file": rel, "kind": "vendored-standard", "severity": "note",
                    "detail": f"byte-identical to {by_hash[digest][0].relative_to(ref_root).as_posix()}, "
                              f"AND to this repo's own vendored copy at "
                              f"{upstream.relative_to(REPO).as_posix()} — a published "
                              f"standard both parties vendored, not a clone",
                })
                continue
            findings.append({
                "file": rel, "kind": "identical", "severity": "violation",
                "detail": f"byte-identical to {by_hash[digest][0].relative_to(ref_root).as_posix()}",
            })
            continue  # identical already dooms it; similarity adds nothing

        if p.suffix.lower() not in TEXT_SUFFIXES and not is_license:
            continue
        text = read_text(p)
        if text is None:
            continue

        for pattern, why in BANNED_PATTERNS:
            if pattern.search(text):
                findings.append({"file": rel, "kind": "banned-phrase",
                                 "severity": "violation", "detail": why})

        if is_license:
            continue  # license text is boilerplate; similarity scoring is meaningless

        if p.suffix.lower() == ".py":
            mine_ast = ast_shingles(text)
            if len(mine_ast) >= TRIVIAL_AST_NODES:
                score, ref = best_match(mine_ast, by_ast)
                if score >= ast_threshold:
                    # Structural match survives renaming, so this is a violation, not
                    # a review item: matching control flow at this depth is not something
                    # two independent implementations arrive at by coincidence.
                    findings.append({
                        "file": rel, "kind": "ast-clone", "severity": "violation",
                        "detail": f"AST structure {score:.2f} identical to "
                                  f"{ref.relative_to(ref_root).as_posix()} (rename-immune)",
                        "score": round(score, 3),
                    })
                    continue

        words = normalized_words(text)
        if len(words) < TRIVIAL_WORDS:
            continue
        score, ref = best_match(shingles(words), by_suffix.get(p.suffix.lower(), []))
        if score >= threshold:
            findings.append({
                "file": rel, "kind": "similar", "severity": "review",
                "detail": f"wording {score:.2f} similar to {ref.relative_to(ref_root).as_posix()}",
                "score": round(score, 3),
            })
    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", action="append", required=True,
                    help="skill directory to check (repeatable)")
    ap.add_argument("--reference", default=os.environ.get("SKILL_REFERENCE_DIR"),
                    help="reference corpus root (or $SKILL_REFERENCE_DIR)")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                    help=f"wording similarity flagged for review (default {DEFAULT_THRESHOLD})")
    ap.add_argument("--ast-threshold", type=float, default=DEFAULT_AST_THRESHOLD,
                    help=f"Python AST similarity treated as a clone "
                         f"(default {DEFAULT_AST_THRESHOLD})")
    ap.add_argument("--allow", action="append", default=[],
                    help="repo-relative path to exempt (documented justification required)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not args.reference:
        print("[skip] no reference corpus: pass --reference or set $SKILL_REFERENCE_DIR",
              file=sys.stderr)
        return 2
    ref_root = Path(args.reference).expanduser().resolve()
    if not ref_root.is_dir():
        print(f"[skip] reference corpus not a directory: {ref_root}", file=sys.stderr)
        return 2

    targets = [Path(t) if Path(t).is_absolute() else REPO / t for t in args.target]
    for t in targets:
        if not t.is_dir():
            print(f"[error] target not a directory: {t}", file=sys.stderr)
            return 1

    by_hash, by_suffix, by_ast = build_reference_index(ref_root)
    ref_count = sum(len(v) for v in by_hash.values())

    findings: list[dict] = []
    for t in targets:
        findings += check_target(t, ref_root, by_hash, by_suffix, by_ast,
                                 args.threshold, args.ast_threshold, set(args.allow))

    violations = [f for f in findings if f["severity"] == "violation"]
    reviews = [f for f in findings if f["severity"] == "review"]
    # `note` = an exemption that WAS granted. It has to be printed: the first version
    # of the provenance rule collected these and printed nothing, so six exempted
    # files produced output identical to a clean run — and, because `findings` was
    # non-empty, it did not even print "clean". An exemption nobody can see is the
    # same failure as a skip nobody can see.
    notes = [f for f in findings if f["severity"] == "note"]

    if args.json:
        print(json.dumps({"reference_files": ref_count, "findings": findings,
                          "violations": len(violations), "reviews": len(reviews),
                          "exempted": len(notes)},
                         ensure_ascii=False, indent=2))
    else:
        print(f"[originality] reference corpus: {ref_count} files under {ref_root}")
        shown = [str(t.relative_to(REPO)) if t.is_relative_to(REPO) else str(t) for t in targets]
        print(f"[originality] targets: {', '.join(shown)}")
        for f in violations:
            print(f"  VIOLATION {f['file']}: {f['detail']}")
        for f in reviews:
            print(f"  REVIEW    {f['file']}: {f['detail']}")
        for f in notes:
            print(f"  EXEMPT    {f['file']}: {f['detail']}")
        if not findings:
            print("  clean — no identical files, no banned phrases, nothing above threshold")
        print(f"[originality] {len(violations)} violation(s), {len(reviews)} needing "
              f"review, {len(notes)} exempted by provenance")

    # REVIEW findings are not auto-red: a shared API surface (argparse flags, library
    # call sequences) can legitimately push similarity up. They must be justified in
    # writing and then passed via --allow, which is what makes the exemption auditable.
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
