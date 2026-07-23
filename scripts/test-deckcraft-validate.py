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

print(f"\n=== {len(PASS)} passed, {len(FAIL)} failed ===")
if FAIL:
    print("FAILED:", FAIL)
sys.exit(1 if FAIL else 0)
