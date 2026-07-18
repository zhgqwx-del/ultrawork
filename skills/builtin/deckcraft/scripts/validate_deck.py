#!/usr/bin/env python3
"""deckcraft QA gate — validate page fragments against the spec_lock contract.

    python3 validate_deck.py <project_dir> [--single]

  --single   first-page-gate mode: skip deck-level checks (E7 diversity,
             page-count vs outline) so a lone probe page can be validated
             before fanning out the rest.

Style rules are checked against style="..." attribute contents only — visible
text is free to mention "Gradient Descent", HTML entities (&#8212;), issue
numbers (#123) etc. without tripping the gate.

Checks (ERROR fails the gate, WARN is advisory):
  E1 literal colors (hex/rgb/hsl) in style attributes — palette vars only
  E2 literal px font-size in style attributes — ramp vars only
  E3 var() reference not defined in tokens.css
  E4 forbidden styling: gradient, box-shadow, italic, underline decoration;
     <script>/<style> tags anywhere in a fragment
  E5 data-layout/data-rhythm missing, unknown (registry = layouts.html), or
     mismatching outline.json; page count mismatch
  E6 placeholder residue in visible text (lorem/ipsum/TODO/待补充/[insert/占位符)
  E7 layout diversity: distinct < min(6, N) or 3+ consecutive same layout
  E8 fragment shape: not exactly one <section>, or missing the "slide" class
  W1 style margin/padding/gap not on the 8px module (border widths exempt)
  W2 breathing page unusually text-heavy (> 120 visible chars)

Exit 0 = pass (warnings allowed), 1 = errors found, 2 = usage/setup problem.
"""
from __future__ import annotations

import itertools
import json
import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
VALID_RHYTHMS = {"anchor", "dense", "breathing"}
# Placeholder scan runs on visible text: word-boundary + uppercase TODO so
# "Todoist"/"todos" don't trip it; lorem/ipsum stay case-insensitive.
PLACEHOLDER_RES = [
    re.compile(r"\blorem\b|\bipsum\b", re.I),
    re.compile(r"\bTODO\b(?!-)"),  # (?!-) exempts compounds like "TODO-list 工具"
    re.compile(r"待补充|\[insert|占位符"),
]
# Style-attribute-scoped forbidden rules (E4).
FORBIDDEN_STYLE = [
    (re.compile(r"gradient", re.I), "gradient"),
    (re.compile(r"box-shadow"), "box-shadow"),
    (re.compile(r"font-style:\s*italic"), "italic (CJK 禁假斜体)"),
    (re.compile(r"text-decoration:\s*underline"), "underline decoration"),
]
FORBIDDEN_TAGS = [
    (re.compile(r"<script", re.I), "script tag"),
    (re.compile(r"<style", re.I), "style tag (tokens live in tokens.css only)"),
]


def valid_layouts() -> set[str]:
    """Layout registry SSOT is layouts.html — parse it so adding S11 there
    can never desync this hard gate. Fallback: S01–S10."""
    reg = SKILL_DIR / "assets" / "templates" / "layouts.html"
    if reg.is_file():
        found = set(re.findall(r'data-layout="(S\d{2})"', reg.read_text(encoding="utf-8")))
        if found:
            return found
    return {f"S{i:02d}" for i in range(1, 11)}


def page_no(p: Path) -> int:
    m = re.search(r"(\d+)", p.stem)
    return int(m.group(1)) if m else 0


def main() -> int:
    args = [x for x in sys.argv[1:] if x != "--single"]
    single = "--single" in sys.argv[1:]
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    proj = Path(args[0])
    pages = sorted((proj / "pages").glob("page-*.html"), key=page_no)
    tokens_f = proj / "tokens.css"
    if not pages or not tokens_f.is_file():
        print(f"ERROR: need {proj}/pages/page-*.html and tokens.css", file=sys.stderr)
        return 2

    allowed_vars = set(re.findall(r"(--[\w-]+)\s*:", tokens_f.read_text(encoding="utf-8")))
    layouts_registry = valid_layouts()
    outline = {}
    outline_f = proj / "outline.json"
    if outline_f.is_file():
        try:
            data = json.loads(outline_f.read_text(encoding="utf-8"))
            outline = {s["index"]: s for s in data.get("slides", []) if "index" in s}
        except (json.JSONDecodeError, KeyError, TypeError):
            print("WARN: outline.json unreadable — skipping cross-checks")

    errors: list[str] = []
    warns: list[str] = []
    layouts: list[str] = []

    for p in pages:
        n = page_no(p)
        t = p.read_text(encoding="utf-8")
        body = re.sub(r"<!--.*?-->", "", t, flags=re.S)
        style_text = " ".join(re.findall(r'style="([^"]*)"', body))
        visible = re.sub(r"<[^>]+>", " ", body)

        # E8 fragment shape — export splitting and shell styling both rely on it
        n_sections = len(re.findall(r"<section\b", body))
        if n_sections != 1:
            errors.append(f"E8 {p.name}: expected exactly one <section>, found {n_sections}")
        sec_tag = re.search(r"<section\b[^>]*>", body)
        if sec_tag and not re.search(r'class="[^"]*\bslide\b[^"]*"', sec_tag.group(0)):
            errors.append(f"E8 {p.name}: <section> missing the \"slide\" class")

        for m in re.findall(r"#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(", style_text):
            errors.append(f"E1 {p.name}: literal color {m}")
        for m in re.findall(r"font-size:\s*([\d.]+px)", style_text):
            errors.append(f"E2 {p.name}: literal font-size {m}")
        for m in re.findall(r"var\((--[\w-]+)\)", style_text):
            if m not in allowed_vars:
                errors.append(f"E3 {p.name}: unknown var {m}")
        for rx, label in FORBIDDEN_STYLE:
            if rx.search(style_text):
                errors.append(f"E4 {p.name}: forbidden {label}")
        for rx, label in FORBIDDEN_TAGS:
            if rx.search(body):
                errors.append(f"E4 {p.name}: forbidden {label}")

        lay = re.search(r'data-layout="([\w-]+)"', body)
        ryt = re.search(r'data-rhythm="([\w-]+)"', body)
        lay_v = lay.group(1) if lay else None
        ryt_v = ryt.group(1) if ryt else None
        if lay_v not in layouts_registry:
            errors.append(f"E5 {p.name}: data-layout={lay_v!r} not in registry {sorted(layouts_registry)}")
        if ryt_v not in VALID_RHYTHMS:
            errors.append(f"E5 {p.name}: data-rhythm={ryt_v!r} invalid")
        layouts.append(lay_v or "?")
        if n in outline:
            want_lay, want_ryt = outline[n].get("layout"), outline[n].get("rhythm")
            if want_lay and lay_v != want_lay:
                errors.append(f"E5 {p.name}: layout {lay_v} != outline {want_lay}")
            if want_ryt and ryt_v != want_ryt:
                errors.append(f"E5 {p.name}: rhythm {ryt_v} != outline {want_ryt}")

        for rx in PLACEHOLDER_RES:
            if rx.search(visible):
                errors.append(f"E6 {p.name}: placeholder residue ({rx.pattern})")
                break

        for m in re.findall(r"(?:margin|padding|gap)[^:;]*:\s*([\d]+)px", style_text):
            if int(m) % 8 != 0:
                warns.append(f"W1 {p.name}: {m}px off the 8px module")
        if ryt_v == "breathing":
            vlen = len(re.sub(r"\s+", "", visible))
            if vlen > 120:
                warns.append(f"W2 {p.name}: breathing page has {vlen} chars of text")

    if not single:
        distinct = len(set(layouts))
        need = min(6, len(pages))
        if distinct < need:
            errors.append(f"E7 layout diversity: {distinct} distinct < {need} required for {len(pages)} pages")
        run = max(len(list(g)) for _, g in itertools.groupby(layouts))
        if run >= 3:
            errors.append(f"E7 {run} consecutive pages share one layout (max 2)")
        if outline and len(pages) != len(outline):
            errors.append(f"E5 page count {len(pages)} != outline {len(outline)}")

    for w in warns:
        print("WARN ", w)
    for e in errors:
        print("ERROR", e)

    # qa_report.json aggregation — the "structure" section; probe_overflow.py
    # appends its own section. Receipt rule: pages listed must equal pages seen.
    report_f = proj / "qa_report.json"
    report = {}
    if report_f.is_file():
        try:
            report = json.loads(report_f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            report = {}
    report["structure"] = {
        "mode": "single" if single else "full",
        "pages": [page_no(p) for p in pages],
        "layouts": layouts,
        "errors": errors,
        "warnings": warns,
    }
    report_f.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"validate: {len(pages)} pages · layouts={layouts} · {len(errors)} errors · {len(warns)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
