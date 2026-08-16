#!/usr/bin/env python3
"""Regression guard for deckcraft validate_outline.py (discussions/051 Phase A).

    python3 scripts/test-deckcraft-validate.py

Covers the delivery_purpose double-band, S04 budget hole closure, O3 assertion
generalization, and the O9 dense floor. Lives OUTSIDE skills/builtin/ so it is not
packed into skills-builtin.zip. NOT in the CI matrix (CI runs TS + cargo) — run manually
after touching validate_outline.py. Exit 0 = all pass, 1 = a case failed."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

# stdout must be UTF-8 on every platform, and on Windows a CAPTURED stdout is not:
# it is encoded in the machine's ANSI code page, and Python only defaults to UTF-8
# from 3.15 (PEP 686). This gate prints Chinese (the strings it asserts on are the
# skill's own Chinese output), so without these lines it exits 1 with
# UnicodeEncodeError on a Windows dev machine — reproducible anywhere with
# PYTHONIOENCODING=cp1252, which is how it was found. The other gates in this
# directory each carry the same block; these three deckcraft ones never did,
# and deckcraft's gates are NOT in CI, so only a real Windows machine would have
# hit it.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "builtin" / "deckcraft"
VALIDATE = SKILL / "scripts" / "validate_outline.py"
sys.path.insert(0, str(SKILL / "scripts"))
import validate_outline as V  # noqa: E402

PASS, FAIL = [], []


def check(name, cond):
    (PASS if cond else FAIL).append(name)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}")


def run(outline, facts=None):
    with tempfile.TemporaryDirectory() as td:
        p = Path(td)
        (p / "outline.json").write_text(json.dumps(outline, ensure_ascii=False), encoding="utf-8")
        if facts is not None:
            (p / "research").mkdir()
            (p / "research" / "facts.json").write_text(json.dumps(facts, ensure_ascii=False), encoding="utf-8")
        r = subprocess.run([sys.executable, str(VALIDATE), str(p)],
                           capture_output=True, text=True, encoding="utf-8")
        return r.returncode, r.stdout + r.stderr


def cover(idx=1):
    return {"index": idx, "layout": "S01", "rhythm": "anchor", "title": "封面",
            "content": {"kicker": "K", "subtitle": "副题", "meta": "M"}, "speaker_notes": "notes"}


def close_(idx):
    return {"index": idx, "layout": "S08", "rhythm": "anchor", "title": "收尾",
            "content": {"statement_prefix": "前", "statement_accent": "强调", "cta": "行动", "sign": "S"},
            "speaker_notes": "notes"}


def s03(idx, points, takeaway="吞吐提升 38%", ev=3, rhythm="dense"):
    return {"index": idx, "layout": "S03", "rhythm": rhythm, "title": "要点页",
            "takeaway": takeaway, "confidence": "high", "evidence": [{"scenario": True}] * ev,
            "content": {"points": points}, "speaker_notes": "notes"}


def deck(*slides, delivery=None):
    d = {"title": "T", "mode": "instructional", "language": "zh", "slides": list(slides)}
    if delivery is not None:
        d["delivery_purpose"] = delivery
    return d


# 1. band monotonicity
keys = set(V.DELIVERY_BANDS["presentation"])
check("band values monotone presentation<=balanced<=document",
      all(V.DELIVERY_BANDS["presentation"][k] <= V.DELIVERY_BANDS["balanced"][k]
          <= V.DELIVERY_BANDS["document"][k] for k in keys))

# 2. default band = balanced when absent
_, out = run(deck(cover(1), s03(2, [{"h": "标", "p": "字" * 30}]), close_(3)))
check("absent delivery_purpose -> balanced", "delivery=balanced" in out)

# 3. invalid delivery_purpose -> error + fallback
e, out = run(deck(cover(1), close_(2), delivery="projector"))
check("invalid delivery_purpose flagged", "delivery_purpose 'projector'" in out and e == 1)

# 4. p budget bands
p30 = {"h": "标题", "p": "字" * 30}
_, o_pres = run(deck(cover(1), s03(2, [p30]), close_(3), delivery="presentation"))
_, o_doc = run(deck(cover(1), s03(2, [p30]), close_(3), delivery="document"))
check("p=30 fails presentation(26)", "content.points[0].p" in o_pres)
check("p=30 passes document(42)", "content.points[0].p" not in o_doc)

# 5. S03 count band
five = [{"h": "h", "p": "释义"} for _ in range(5)]
_, o_p = run(deck(cover(1), s03(2, five), close_(3), delivery="presentation"))
_, o_d = run(deck(cover(1), s03(2, five), close_(3), delivery="document"))
check("S03 5 points fail presentation", "points 条目数 5" in o_p)
check("S03 5 points pass document", "points 条目数" not in o_d)


def s04(col_pts, delivery):
    d = deck(cover(1),
             {"index": 2, "layout": "S04", "rhythm": "dense", "title": "两栏",
              "takeaway": "A 用 X，B 用 Y 各有取舍", "confidence": "high",
              "evidence": [{"scenario": True}] * 3,
              "content": {"col_a": {"h": "A", "points": col_pts},
                          "col_b": {"h": "B", "points": ["短"] * len(col_pts)}},
              "speaker_notes": "n"}, close_(3), delivery=delivery)
    return run(d)


# 6. S04 hole closed
_, o = s04(["字" * 40, "短", "短"], "presentation")
check("S04 point char budget enforced presentation", "content.col_a.points[0]" in o)
_, o = s04(["字" * 40, "短", "短"], "document")
check("S04 point char budget passes document(42)", "content.col_a.points[0]" not in o)
_, o = s04(["短"] * 5, "presentation")
check("S04 5 points/col fail presentation(4)", "S04 col_a.points 条目数 5 > 4" in o)
_, o = s04(["短"] * 5, "document")
check("S04 5 points/col pass document(5)", "S04 col_a.points 条目数" not in o)


def s10(nrows, delivery):
    d = deck(cover(1),
             {"index": 2, "layout": "S10", "rhythm": "dense", "title": "表",
              "takeaway": "七项指令覆盖四类决策 100%", "confidence": "high",
              "evidence": [{"scenario": True}] * 3,
              "content": {"headers": ["列1", "列2", "列3"], "rows": [["a", "b", "c"] for _ in range(nrows)]},
              "speaker_notes": "n"}, close_(3), delivery=delivery)
    return run(d)


# 7. S10 rows band
_, o = s10(7, "presentation")
check("S10 7 rows fail presentation(5)", "S10 rows 7 > 5" in o)
_, o = s10(7, "balanced")
check("S10 7 rows fail balanced(6)", "S10 rows 7 > 6" in o)
_, o = s10(7, "document")
check("S10 7 rows pass document(8)", "S10 rows" not in o)

# 8. O3 generalization
check("O3 teaching pairing accepted", V.looks_like_assertion("内容敏感用 ETag，成本敏感用 Last-Modified"))
check("O3 digit assertion accepted", V.looks_like_assertion("吞吐提升 38%"))
check("O3 bare label 市场概览 rejected", not V.looks_like_assertion("市场概览"))
check("O3 bare label 内容概要 rejected", not V.looks_like_assertion("内容概要"))
_, o = run(deck(cover(1), s03(2, [{"h": "h", "p": "释义"}], takeaway="市场概览"), close_(3)))
check("O3 integration: bare label flagged", "O3 p2" in o)

# 9. O9 dense floor is WARNING, count-based
e, o = run(deck(cover(1), s03(2, [{"h": "h", "p": "释义"} for _ in range(3)], ev=2), close_(3)))
check("O9 evidence<3 warns", "O9 p2" in o and "evidence" in o)
check("O9 is warning not error (exit 0)", e == 0)
_, o = run(deck(cover(1), s03(2, [{"h": "h", "p": "释义"} for _ in range(2)], ev=3), close_(3)))
check("O9 items<3 warns", "O9 p2" in o and "要点" in o)
e, o = run(deck(cover(1), s03(2, [{"h": "h", "p": "释义"} for _ in range(3)], ev=3), close_(3)))
check("O9 clean at 3+3", "O9 p" not in o and e == 0)
_, o = run(deck(cover(1), s03(2, [{"h": "h", "p": "释义"} for _ in range(2)], ev=2, rhythm="anchor"), close_(3)))
check("O9 skips non-dense pages", "O9 p2" not in o)

# 10. no-regression: shipped example exit 0
e = subprocess.run([sys.executable, str(VALIDATE), str(SKILL / "examples" / "ai-coding-pilot")],
                   capture_output=True, text=True).returncode
check("shipped ai-coding-pilot exit 0", e == 0)

# 11. fixed h budget unchanged in document band
_, o = run(deck(cover(1), s03(2, [{"h": "字" * 13, "p": "释义"} for _ in range(3)]), close_(3), delivery="document"))
check("h budget stays fixed 12 in document band", "content.points[0].h" in o)

# ── 12. ADR-068 D5 — skeleton geometry folds into the budgets ────────────────
def run_with_tokens(outline, tokens_css, facts=None):
    with tempfile.TemporaryDirectory() as td:
        q = Path(td)
        (q / "outline.json").write_text(json.dumps(outline, ensure_ascii=False), encoding="utf-8")
        (q / "tokens.css").write_text(tokens_css, encoding="utf-8")
        r = subprocess.run([sys.executable, str(VALIDATE), str(q)],
                           capture_output=True, text=True, encoding="utf-8")
        return r.returncode, r.stdout + r.stderr


BASE_CSS = (":root{--sl-pad:64px;--fw-body:300;--lh-body:1.65;--measure:36em;}")

s, cs, geo, errs = V.geometry_scale({})
check("D5 absent tokens.css → base geometry, scale 1.0", s == 1.0 and cs == 1.0 and not errs)

s, cs, geo, errs = V.geometry_scale(V.read_css_tokens(BASE_CSS))
check("D5 base values → scale 1.0", abs(s - 1.0) < 1e-9 and not errs)

# wider page margin + looser leading must TIGHTEN, never loosen
s, cs, _, errs = V.geometry_scale(V.read_css_tokens(
    ":root{--sl-pad:80px;--lh-body:1.85;--fw-body:300;--measure:36em;}"))
check("D5 roomier skeleton tightens char budget", s < 0.9 and not errs)
check("D5 line-height also tightens item counts", cs < 1.0)

# a narrower page must NOT buy extra characters (cap at 1.0)
s, _, _, errs = V.geometry_scale(V.read_css_tokens(
    ":root{--sl-pad:48px;--lh-body:1.45;--fw-body:300;--measure:44em;}"))
check("D5 tighter skeleton never loosens budget (cap 1.0)", s == 1.0 and not errs)

# out-of-band values are errors, not silent guesses
_, _, _, errs = V.geometry_scale(V.read_css_tokens(":root{--sl-pad:96px;}"))
check("D5 out-of-band --sl-pad is an O10 error", len(errs) == 1 and "O10" in errs[0])
_, _, _, errs = V.geometry_scale(V.read_css_tokens(":root{--lh-body:2.4;}"))
check("D5 out-of-band --lh-body is an O10 error", len(errs) == 1 and "O10" in errs[0])
_, _, _, errs = V.geometry_scale(V.read_css_tokens(":root{--sl-pad:wide;}"))
check("D5 non-numeric token is an O10 error", len(errs) == 1)

# counts never tighten past the O9 content floor — an unsatisfiable cap is a
# contradiction in the skeleton, not in the author's outline
b = V.scaled_band(V.DELIVERY_BANDS["presentation"], 0.1, 0.1)
check("D5 count caps floor at DENSE_MIN_ITEMS",
      b["s03_points"] >= V.DENSE_MIN_ITEMS and b["s10_rows"] >= V.DENSE_MIN_ITEMS)

# end-to-end: same outline, base geometry passes, roomy geometry rejects
# 22 视觉宽：base 档 32 放行，roomy 档（scale 0.65 → 20）拒绝。夹具必须落在两档之间，
# 取 20 会正好等于收紧后的上限而不越界（首版就踩了这个 off-by-one）。
wide = deck(cover(1), s03(2, [{"h": "h", "p": "\u5b57" * 22} for _ in range(3)]), close_(3),
            delivery="balanced")
e_base, _ = run_with_tokens(wide, BASE_CSS)
e_roomy, o_roomy = run_with_tokens(
    wide, ":root{--sl-pad:80px;--fw-body:500;--lh-body:1.85;--measure:28em;}")
check("D5 e2e: budget that passes at base geometry fails at roomy geometry",
      e_base == 0 and e_roomy == 1 and "O8" in o_roomy)

_, o = run_with_tokens(wide, BASE_CSS)
check("D5 prints the geometry it used", "geometry: pad=64px" in o and "char\u00d71.00" in o)

# 13. no-regression: every shipped example still exits 0 under its own geometry
for ex in sorted((SKILL / "examples").iterdir()):
    if not ex.is_dir():
        continue
    e = subprocess.run([sys.executable, str(VALIDATE), str(ex)],
                       capture_output=True, text=True).returncode
    check(f"shipped {ex.name} exit 0 with per-style geometry", e == 0)

# ── 14. ADR-068 Phase C — layout registry is the directory; E4 allowances ─────
sys.path.insert(0, str(SKILL / "scripts"))
import validate_deck as VD  # noqa: E402

reg = VD.valid_layouts()
skel_dir = SKILL / "assets" / "templates" / "layouts"
check("registry == layouts/ directory contents",
      reg == {f.stem for f in skel_dir.glob("S*.html")} and len(reg) >= 10)
check("every registered layout has an _index.md row",
      all(f"`{s}`" in (skel_dir / "_index.md").read_text(encoding="utf-8") for s in sorted(reg)))

# E4 waivers. `gradient` was gated on probe_overflow being able to MEASURE a
# gradient backdrop (ADR-068 D6): an unreadable backdrop exempts every text element
# above it, so waiving gradients earlier would have switched ADR-067's contrast
# floor off on exactly the pages using them. Both are claimable now.
check("E4 ALLOWABLE holds shadow", "shadow" in VD.ALLOWABLE)
check("E4 gradient waivable now that D6 samples its colour stops",
      "gradient" in VD.ALLOWABLE)
check("E4 nothing left held back", VD.PENDING_ALLOWANCE == {})
check("E4 an unknown waiver is still an error, not a silent pass",
      "made-up" not in VD.ALLOWABLE)
check("E4 italic/underline are never waivable",
      all(k is None for _, lbl, k in VD.FORBIDDEN_STYLE if "italic" in lbl or "underline" in lbl))

# every shipped style file declares a Signature id and a 骨相 token table
styles = sorted((SKILL / "references" / "design-styles").glob("*.md"))
named = [f for f in styles if f.stem != "_index"]
idx = (SKILL / "references" / "design-styles" / "_index.md").read_text(encoding="utf-8")
check(f"style library has >= 10 entries (has {len(named)})", len(named) >= 10)
for f in named:
    s = f.read_text(encoding="utf-8")
    check(f"{f.stem}: registered in _index with a temperature",
          f"`{f.stem}`" in idx)
    check(f"{f.stem}: declares Signature + 骨相 token table",
          "## Signature" in s and "data-signature=" in s and "## 骨相 token" in s)

# ── 15. ADR-068 Phase D — new layouts, O11 numeric safety, E7 proportional, W5 ──
check("registry grew to >= 20 layouts", len(VD.valid_layouts()) >= 20)
check("media layouts declared in index", VD.media_layouts() == {"S11", "S17", "S19"})
check("S17/S19 join the content-exempt family",
      {"S17", "S19"} <= V.CONTENT_EXEMPT_LAYOUTS)
for lay in ("S11", "S12", "S13", "S14", "S15", "S16", "S18", "S20"):
    check(f"{lay} has a STRUCT_CAPS entry", lay in V.STRUCT_CAPS)

# O11 — data→geometry is the one place arithmetic fails silently
ok = [{"label": "a", "value": 10}, {"label": "b", "value": 0}]
check("O11 accepts a finite non-negative series", V.check_bar_values(ok) == [])
check("O11 rejects a non-number", any("not a number" in e
      for e in V.check_bar_values([{"label": "a", "value": "十"}])))
check("O11 rejects bool (isinstance(True, int) trap)", any("not a number" in e
      for e in V.check_bar_values([{"label": "a", "value": True}])))
check("O11 rejects negative", any("negative" in e
      for e in V.check_bar_values([{"label": "a", "value": -1}])))
check("O11 rejects an all-zero series (division by zero)", any("division by zero" in e
      for e in V.check_bar_values([{"label": "a", "value": 0}, {"label": "b", "value": 0}])))
check("O11 rejects infinity", any("finite" in e
      for e in V.check_bar_values([{"label": "a", "value": float("inf")}])))
check("O11 rejects an empty series", V.check_bar_values([]) != [])
check("O11 rejects a missing value key", V.check_bar_values([{"label": "a"}]) != [])

# primary_count must see the new layouts' main lists, else O9 silently skips them
for lay, fld in (("S11", "points"), ("S12", "cards"), ("S13", "quadrants"),
                 ("S14", "steps"), ("S15", "bars"), ("S16", "stats"),
                 ("S18", "levels"), ("S20", "notes")):
    check(f"O9 counts {lay}.{fld}", V.primary_count(lay, {fld: [1, 2, 3]}) == 3)

print(f"\n=== {len(PASS)} passed, {len(FAIL)} failed ===")
if FAIL:
    print("FAILED:", FAIL)
sys.exit(1 if FAIL else 0)
