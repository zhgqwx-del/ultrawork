#!/usr/bin/env python3
"""Threshold calibration + negative controls for check-skill-originality.py (059 §5 L0).

The originality gate is only worth having if it catches the way clean-room work
ACTUALLY gets contaminated — not byte-copying (nobody does that on purpose) but
"I wrote it while looking at theirs". This script measures where the detector's
floor really is, instead of assuming.

It synthesizes progressively heavier rewrites of reference files (rename ->
restructure -> control-flow change) and reports which ones the gate still catches,
then contrasts that against our own independently written scripts. Thresholds in
check-skill-originality.py must sit inside the gap it prints.

    python3 scripts/test-skill-originality.py --reference /path/to/skill_reference

Exit 0 = thresholds sit in the separating band, 1 = calibration broken,
2 = reference corpus unavailable (skipped).
"""
from __future__ import annotations

import argparse
import ast
import importlib.util
import os
import random
import re
import sys
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

spec = importlib.util.spec_from_file_location(
    "originality", REPO / "scripts" / "check-skill-originality.py")
G = importlib.util.module_from_spec(spec)
spec.loader.exec_module(G)

# Our own scripts: written for this repo, never derived from the reference corpus.
# Whatever they score is the detector's false-positive floor.
#
# KNOWN LIMIT of this negative sample: deckcraft/doc-edit do DIFFERENT jobs than the
# reference skills, so their score is a floor for "unrelated code", not for "same job,
# written independently". `pdf` was added 2026-08-01 (059 S2) precisely because it IS
# same-job code — it reads the same PDFs as four of the reference skills — so it is the
# first sample that measures what this threshold actually has to survive. `xlsx` joined
# 2026-08-02 (059 S3) for the same reason: it opens the same OOXML packages with the
# same library as all four reference skills. `docx` must be added the same way when S4
# lands; a threshold calibrated only against unrelated code starts crying wolf on
# same-job code.
#
# ⚠️ One thing this sample no longer proves: `pdf` was rewritten off PyMuPDF onto four
# permissive libraries (059 §5·补.8c), so it and the reference skills no longer call
# the same API. Same job, different library, which is a weaker resemblance than "same
# job, same library" was. Measured across that rewrite the floor went 0.187 -> 0.191
# and stayed the same file pair (pdf_form_inspect.py <- qa_text.py), so nothing about
# the threshold changed — but the sample's strength did, and only `xlsx` still carries
# the same-library case.
OWN_SKILLS = ["deckcraft", "doc-edit", "docx", "pdf", "xlsx"]

RENAMES = [("field", "entry"), ("writer", "out_doc"), ("reader", "in_doc"),
           ("annotation", "annot"), ("value", "val"), ("page", "pg"),
           ("data", "payload"), ("result", "outcome"), ("path", "loc"),
           ("name", "label"), ("text", "body"), ("index", "pos")]


def rewrite_rename(src: str) -> str:
    """L1 — what a hurried copy looks like: new identifiers, reworded comments."""
    out = src
    for a, b in RENAMES:
        out = re.sub(rf"\b{a}\b", b, out)
    return re.sub(r"#.*", "# reworded", out)


def rewrite_restructure(src: str) -> str:
    """L2 — L1 plus reordered top-level defs and rewritten string literals."""
    out = rewrite_rename(src)
    try:
        tree = ast.parse(out)
    except SyntaxError:
        return out

    class Strings(ast.NodeTransformer):
        def visit_Constant(self, node):
            if isinstance(node.value, str) and len(node.value) > 3:
                return ast.copy_location(ast.Constant(value="s" + str(len(node.value))), node)
            return node

    tree = Strings().visit(tree)
    body_defs = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))]
    others = [n for n in tree.body if n not in body_defs]
    rng = random.Random(1234)          # deterministic: no Math.random-style flake
    rng.shuffle(body_defs)
    tree.body = others + body_defs
    ast.fix_missing_locations(tree)
    return ast.unparse(tree)


def rewrite_control_flow(src: str) -> str:
    """L3 — L2 plus control-flow surgery: for->while, if-not inversion, guard hoisting.

    This is the honest upper bound of "rewriting while looking at the original".
    Past this point the author is genuinely reimplementing, and no structural
    detector should — or can — call it a clone.
    """
    out = rewrite_restructure(src)
    try:
        tree = ast.parse(out)
    except SyntaxError:
        return out

    class Flow(ast.NodeTransformer):
        def visit_For(self, node):
            self.generic_visit(node)
            if node.orelse:
                return node
            idx = ast.Name(id="_i", ctx=ast.Store())
            seq = ast.Name(id="_seq", ctx=ast.Store())
            setup = [
                ast.Assign(targets=[seq], value=ast.Call(
                    func=ast.Name(id="list", ctx=ast.Load()), args=[node.iter], keywords=[])),
                ast.Assign(targets=[idx], value=ast.Constant(value=0)),
            ]
            body = [ast.Assign(targets=[node.target], value=ast.Subscript(
                value=ast.Name(id="_seq", ctx=ast.Load()),
                slice=ast.Name(id="_i", ctx=ast.Load()), ctx=ast.Load()))]
            body += node.body
            body.append(ast.AugAssign(target=ast.Name(id="_i", ctx=ast.Store()),
                                      op=ast.Add(), value=ast.Constant(value=1)))
            loop = ast.While(test=ast.Compare(
                left=ast.Name(id="_i", ctx=ast.Load()), ops=[ast.Lt()],
                comparators=[ast.Call(func=ast.Name(id="len", ctx=ast.Load()),
                                      args=[ast.Name(id="_seq", ctx=ast.Load())],
                                      keywords=[])]), body=body, orelse=[])
            return setup + [loop]

        def visit_If(self, node):
            self.generic_visit(node)
            if node.orelse and not isinstance(node.orelse[0], ast.If):
                node.test = ast.UnaryOp(op=ast.Not(), operand=node.test)
                node.body, node.orelse = node.orelse, node.body
            return node

    tree = Flow().visit(tree)
    ast.fix_missing_locations(tree)
    return ast.unparse(tree)


LEVELS = [("L1 rename+comments", rewrite_rename),
          ("L2 +reorder+strings", rewrite_restructure),
          ("L3 +control-flow", rewrite_control_flow)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reference", default=os.environ.get("SKILL_REFERENCE_DIR"))
    ap.add_argument("--samples", type=int, default=12,
                    help="reference files to rewrite per level (default 12)")
    args = ap.parse_args()

    if not args.reference or not Path(args.reference).expanduser().is_dir():
        print("[skip] no reference corpus: pass --reference or set $SKILL_REFERENCE_DIR",
              file=sys.stderr)
        return 2
    ref_root = Path(args.reference).expanduser().resolve()

    _, _, by_ast = G.build_reference_index(ref_root)
    print(f"[calibrate] reference python skeletons: {len(by_ast)}")

    # ---- false-positive floor: our own code, written independently ----
    own: list[tuple[float, str, str]] = []
    for skill in OWN_SKILLS:
        for p in sorted((REPO / "skills" / "builtin" / skill).rglob("*.py")):
            if "__pycache__" in p.parts:
                continue
            sk = G.ast_shingles(G.read_text(p) or "")
            if len(sk) < G.TRIVIAL_AST_NODES:
                continue
            score, ref = G.best_match(sk, by_ast)
            own.append((score, p.name, ref.name if ref else "-"))
    own.sort(reverse=True)
    own_max = own[0][0] if own else 0.0
    print(f"\n[negative] {len(own)} independently written scripts vs corpus")
    for s, n, r in own[:3]:
        print(f"    {s:.3f}  {n} <- {r}")
    print(f"    max={own_max:.3f}  median={own[len(own) // 2][0]:.3f}")

    # ---- detection floor: how heavy a rewrite still reads as a clone ----
    corpus = sorted(by_ast, key=lambda t: -len(t[1]))[:args.samples]
    print(f"\n[positive] rewriting {len(corpus)} reference files at 3 levels")
    level_min: dict[str, float] = {}
    for label, fn in LEVELS:
        scores = []
        for path, _ in corpus:
            try:
                mutated = fn(G.read_text(path) or "")
            except (SyntaxError, ValueError, RecursionError, AttributeError):
                continue
            sk = G.ast_shingles(mutated)
            if len(sk) < G.TRIVIAL_AST_NODES:
                continue
            scores.append(G.best_match(sk, by_ast)[0])
        if not scores:
            continue
        scores.sort()
        level_min[label] = scores[0]
        caught = sum(1 for s in scores if s >= G.DEFAULT_AST_THRESHOLD)
        print(f"    {label:<22} min={scores[0]:.3f} median={scores[len(scores) // 2]:.3f} "
              f"max={scores[-1]:.3f}  caught {caught}/{len(scores)}")

    # ---- verdict ----
    weakest_caught = min((v for k, v in level_min.items()
                          if v >= G.DEFAULT_AST_THRESHOLD), default=None)
    print(f"\n[verdict] threshold in use: {G.DEFAULT_AST_THRESHOLD}")
    print(f"    separating band: own code tops out at {own_max:.3f}, "
          f"weakest still-caught rewrite scores {weakest_caught if weakest_caught else float('nan'):.3f}")

    ok = True
    if G.DEFAULT_AST_THRESHOLD <= own_max:
        print(f"    BROKEN: threshold {G.DEFAULT_AST_THRESHOLD} <= own-code max {own_max:.3f} "
              f"— our own scripts would be flagged")
        ok = False
    escaped = [k for k, v in level_min.items() if v < G.DEFAULT_AST_THRESHOLD]
    if escaped:
        # Not automatically a failure: L3 escaping is expected and is the documented
        # limit of the gate. L1 escaping would mean the gate is useless.
        print(f"    NOTE: these rewrite levels can slip past: {', '.join(escaped)}")
        if any(k.startswith("L1") for k in escaped):
            print("    BROKEN: even a plain rename escapes — gate provides no protection")
            ok = False

    # ── the provenance exemption must not be a blanket loophole ───────────────
    # `check-skill-originality.py` exempts a file that is byte-identical to the
    # reference corpus AND to this repo's own vendored upstream — that is how the
    # docx skill can ship the ECMA-376 schemas, which Anthropic's proprietary skill
    # also bundles (measured: 6 of 13 byte-identical, 5 more identical once line
    # endings are normalised, because they ARE the same published files).
    #
    # An exemption with no control is a hole. Two arms, and the second is the one
    # that matters: a real file from the proprietary bundle, which is NOT in our
    # upstream, must still be a VIOLATION.
    import shutil, tempfile
    prov_ok = True
    ref_docx = ref_root / "claude-desktop" / "bundled-skills" / "docx" / "scripts"
    upstream = G.upstream_digests()
    if not upstream:
        print("\n[provenance] SKIPPED: no vendored upstream at scripts/schemas/ecma376")
    else:
        with tempfile.TemporaryDirectory(prefix="prov-") as td:
            probe = Path(td)
            # arm A: a file that is in our upstream AND in the reference corpus, so
            # it actually reaches the exemption. ⚠️ Picking the first .xsd by name
            # did NOT: only 6 of the 13 overlap (the rest differ by line endings),
            # and an arm that never enters the code path is not an arm — it reported
            # "no finding", which looks nothing like a pass and is not one either.
            h_all, _, _ = G.build_reference_index(ref_root)
            sample = next((f for d, f in upstream.items() if d in h_all), None)
            if sample is None:
                print("\n[provenance] SKIPPED: no upstream file also present in the "
                      "reference corpus, so the exemption cannot be exercised")
                prov_ok = None
            else:
                shutil.copy2(sample, probe / sample.name)
                # arm B: a real file from the proprietary bundle -> still a violation
                stolen = next((f for f in sorted(ref_docx.glob("*.py"))), None)
                if stolen is not None:
                    shutil.copy2(stolen, probe / "_stolen.py")
                _, s_idx, a_idx = G.build_reference_index(ref_root)
                found = G.check_target(probe, ref_root, h_all, s_idx, a_idx,
                                       G.DEFAULT_THRESHOLD, G.DEFAULT_AST_THRESHOLD,
                                       set())
                kinds = {f["file"].rsplit("/", 1)[-1]: f["severity"] for f in found}
                exempted = kinds.get(sample.name)
                flagged = kinds.get("_stolen.py")
                print(f"\n[provenance] {sample.name} (ours AND theirs) -> "
                      f"{exempted or 'NO FINDING'}; proprietary file -> "
                      f"{flagged or 'NO FINDING'}")
                if exempted != "note":
                    print("    BROKEN: a file from our own documented upstream was "
                          "not exempted, so the docx skill cannot ship the schemas")
                    prov_ok = False
                if stolen is not None and flagged != "violation":
                    print("    BROKEN: a real file from the proprietary bundle was "
                          "NOT flagged — the exemption is a blanket loophole")
                    prov_ok = False
    ok = ok and (prov_ok is not False)

    print(f"[calibrate] {'OK' if ok else 'FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
