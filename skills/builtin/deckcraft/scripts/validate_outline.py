#!/usr/bin/env python3
"""deckcraft outline gate — content-thickness validation BEFORE any HTML is generated.

    python3 validate_outline.py <project_dir>

Validates <project>/outline.json against the evidence contract
(references/content-engineering.md / outline-schema.md):

  O1 structure: contiguous indexes from 1, valid rhythm, mode known
  O2 content pages must carry takeaway / evidence(>=2) / confidence / speaker_notes
  O3 takeaway must be a real conclusion (a digit, an assertion verb, OR a compound
     pairing/contrast) — not a bare topic label. Accepts persuasive AND
     teaching/briefing conclusions ("内容敏感用 ETag，成本敏感用 Last-Modified").
  O4 evidence entries must be {"fact_id": ...} (existing in research/facts.json),
     {"source":"user-doc"} or {"scenario": true}
  O5 buzzword slop (赋能/抓手/闭环/…) — checked per field: a digit elsewhere on
     the page does not excuse an empty phrase in this field
  O6 rhythm cadence: >=1 breathing page per 8 pages (decks >= 8 pages)
  O7 scenario pages: content must not pretend to be real (advisory reminder in output)
  O8 character budgets + per-layout structure caps — the IR-level overflow gate.
     Caps are a floor+cap DOUBLE band selected by `delivery_purpose` (consumption
     distance), anchored to what a slot physically holds at 1280x720 (probe-calibrated,
     not an aesthetic 26). The physical probe stays as the second layer.
  O11 numeric safety for S15 bar charts — value must be a finite, non-negative number
     and the series must not be all-zero (width = value/max would divide by zero and
     paint nothing). The physical probe cannot see this: a zero-width bar overflows
     nothing. Data→geometry is the one place arithmetic can fail silently.
  O9 dense floor (advisory): a page whose rhythm is `dense` must not be near-empty —
     >=3 primary items AND >=3 evidence, else WARN to densify (add points / switch to a
     denser layout). Anchored on item/evidence COUNT, not字数 (guards thin→bloated).
     `references/visual-review.md` R3 is the binding judgment on over-sparse dense pages.

`delivery_purpose` (top-level, default "balanced"): consumption distance, orthogonal to
`mode`. presentation = projected/far-view (airy), balanced = default (~today),
document = read-close (dense). Selects the O8 band; mode never touches density.

Exit 0 = pass, 1 = errors, 2 = usage/setup problem.
"""
from __future__ import annotations

import json
import math
import re
import sys
import unicodedata
from pathlib import Path

from console_encoding import configure_utf8_stdio

configure_utf8_stdio()

# cover/section/quote/closing carry a statement, not evidence-bearing body content.
# S17 (full-bleed hero) and S19 (portrait quote) are the Phase D members of that
# family — one line of assertion over an image is the whole page.
CONTENT_EXEMPT_LAYOUTS = {"S01", "S02", "S07", "S08", "S17", "S19"}
VALID_RHYTHMS = {"anchor", "dense", "breathing"}
VALID_MODES = {"pyramid", "narrative", "instructional", "showcase", "briefing"}
VALID_CONFIDENCE = {"high", "medium", "low"}
BUZZWORDS = re.compile(r"赋能|抓手|闭环|降本增效|全面提升|更快更强|极致体验|革命性|颠覆式")
HAS_DIGIT = re.compile(r"\d")
# O3 — an assertion verb: predicates seen in real conclusions. Broadened beyond the old
# persuasive-only whitelist to admit teaching/briefing predicates (用/选/避免/优先/…).
ASSERTION_VERB = re.compile(
    r"是|有|将|能|让|使|领先|超过|优于|下降|上升|增长|减少|带来|证明|支持|覆盖|完成"
    r"|指向|推进|意味|说明|需要|应当|决定|构成|来自|翻倍|可控|风险|对策"
    r"|用|选|避免|优先|区分|判断|采用|通过|导致|取决|适合|适用|对应|区别|依赖|靠|改为")
# a compound statement (pairing / contrast) reads as a conclusion, not a bare label
COMPOUND_SEP = re.compile(r"[，,、：:；;]")

# O8 — delivery_purpose bands (consumption distance → density). Values are probe-calibrated
# against 1280x720 at body 21px (see discussions/051 §4.1.1). caps carry ~20% headroom for
# Linux CJK font variance (the gate measures the box, not the glyph).
#   `p`               = point/node description 视觉宽度 (S03 point.p, S06 node.p)
#   `points_char`     = S04 col bare-string point 视觉宽度 (was ungoverned — a hole)
#   `s03_points`      = S03 point COUNT cap
#   `s04_col_points`  = S04 per-column point COUNT cap (skeleton uses min-height, not fixed 432)
#   `s10_rows`        = S10 row COUNT cap
DELIVERY_BANDS = {
    "presentation": {"p": 26, "points_char": 30, "s03_points": 4, "s04_col_points": 4, "s10_rows": 5},
    "balanced":     {"p": 32, "points_char": 35, "s03_points": 4, "s04_col_points": 4, "s10_rows": 6},
    "document":     {"p": 42, "points_char": 42, "s03_points": 5, "s04_col_points": 5, "s10_rows": 8},
}
DEFAULT_DELIVERY = "balanced"
VALID_DELIVERY = set(DELIVERY_BANDS)

# O8 — fixed character budgets (视觉宽度：全角 1、半角 0.5). Band-selected leaves (`p`,
# `points`) are resolved in budget_for(); everything here is distance-invariant structure.
KEY_BUDGETS_FIXED = {"h": 12, "n": 6, "quote": 40,
                     "subtitle": 30, "cta": 30, "attribution": 30,
                     "items": 18, "headers": 12}  # S09 议程项 / S10 表头单元格
TITLE_BUDGET = 18       # 页标题
COVER_TITLE_BUDGET = 16  # 封面主标题 / deck 标题
# O8 — 每版式的条目数下限/上限 (field, min, max_or_None). max=None → resolved from band.
STRUCT_CAPS = {"S03": ("points", 1, None), "S05": ("stats", 2, 4),
               "S06": ("nodes", 3, 5), "S09": ("items", 1, 6),
               # ADR-068 Phase D — counts are probe-calibrated at base geometry;
               # geometry_scale() tightens them the same way it does S03/S04/S10.
               "S11": ("points", 2, 4), "S12": ("cards", 3, 3),
               "S13": ("quadrants", 4, 4), "S14": ("steps", 3, 5),
               "S15": ("bars", 2, 6), "S16": ("stats", 4, 6),
               "S18": ("levels", 3, 5), "S20": ("notes", 1, 4)}

# O9 — dense-rhythm content floor (advisory / count-based, guards thin→bloated)
DENSE_MIN_ITEMS = 3
DENSE_MIN_EVIDENCE = 3

# ── O10 — skeleton geometry → budget scaling (ADR-068 D5) ────────────────────
# The DELIVERY_BANDS numbers above were probe-calibrated against ONE geometry:
# 1280x720, page padding 64px, body 21px/300/1.65, measure 36em. ADR-068 D3 makes
# four of those adjustable per style, so the bands are no longer geometry-free —
# a deck with 80px padding has ~6% less column width and the same budget would be
# optimistic. Optimism here is not a crash, it is churn: outline passes, probe
# rejects, and validate_outline exists precisely to spend that round trip cheaply.
#
# Two rules keep this honest:
#  1. Legal values are ENUMERATED, not free. An out-of-band value means "budgets
#     were never calibrated for this" — an error, not a silent guess.
#  2. Scale may only TIGHTEN (capped at 1.0). A roomier skeleton does not buy more
#     characters: the caps are an aesthetic upper bound (ADR-066's finding), and
#     `delivery_purpose` is the intended density knob. Loosening here would erode
#     the ~20% headroom the caps carry for Linux CJK font variance.
SKELETON_BANDS = {
    "--sl-pad":   [48, 56, 64, 72, 80],                 # px, 8px module
    "--fw-body":  [300, 400, 500],
    "--lh-body":  [1.45, 1.5, 1.55, 1.6, 1.65, 1.75, 1.85],
    "--measure":  [28, 30, 32, 34, 36, 38, 40, 42, 44],  # em
}
BASE_GEOMETRY = {"--sl-pad": 64, "--fw-body": 300, "--lh-body": 1.65, "--measure": 36}
CANVAS_W = 1280
# Latin advance widens with weight; CJK ideographs are fixed-advance, so the effect
# on a 视觉宽度 budget is small. Conservative (over-tightening beats churn).
FW_FACTOR = {300: 1.0, 400: 0.97, 500: 0.94}


def read_css_tokens(css: str) -> dict[str, str]:
    """Declarations only. CSS comments are stripped first: tokens.css carries a
    documentation header, and a line like `/* --radius: 圆角用 */` would otherwise
    read as a real declaration — silently widening E3's allow-list here and, in
    validate_outline, fabricating an out-of-band geometry error."""
    css = re.sub(r"/\*.*?\*/", " ", css, flags=re.S)
    return {m.group(1): m.group(2).strip()
            for m in re.finditer(r"(--[\w-]+)\s*:\s*([^;}]+)", css)}


def _num(raw: str) -> float | None:
    m = re.match(r"^\s*([\d.]+)", raw or "")
    return float(m.group(1)) if m else None


def geometry_scale(tokens: dict[str, str]) -> tuple[float, float, dict, list[str]]:
    """(char-budget multiplier, item-count multiplier, resolved geometry, band errors).

    Two multipliers because the two kinds of cap are bound by different axes: a
    character budget is column WIDTH (padding, measure) plus how much vertical room
    a line eats (line-height, and marginally weight); an item count is purely how
    many lines fit, i.e. line-height. Padding does not change item counts — the
    skeletons are flex columns that grow downward.

    tokens.css is absent on the Phase 2 run (it is written in Phase 3), which is
    why a missing file means base geometry rather than a failure — and why
    SKILL.md re-runs this gate once tokens.css exists.
    """
    errs: list[str] = []
    geo = dict(BASE_GEOMETRY)
    for name, legal in SKELETON_BANDS.items():
        raw = tokens.get(name)
        if raw is None:
            continue                      # shell.html fallback == base geometry
        v = _num(raw)
        if v is None:
            errs.append(f"O10 {name}: {raw!r} is not a number — budgets uncalibrated")
            continue
        if not any(abs(v - c) < 1e-9 for c in legal):
            errs.append(f"O10 {name}:{raw.strip()} outside the calibrated band {legal} "
                        f"— the character budgets were never measured for this geometry; "
                        f"pick a listed value (spec-lock-format.md §Structure)")
            continue
        geo[name] = v
    width_f = (CANVAS_W - 2 * geo["--sl-pad"]) / (CANVAS_W - 2 * BASE_GEOMETRY["--sl-pad"])
    measure_f = geo["--measure"] / BASE_GEOMETRY["--measure"]
    lh_f = min(1.0, BASE_GEOMETRY["--lh-body"] / geo["--lh-body"])
    fw_f = FW_FACTOR.get(int(geo["--fw-body"]), 1.0)
    return min(1.0, width_f, measure_f) * lh_f * fw_f, lh_f, geo, errs


def scaled_band(band: dict, char_scale: float, count_scale: float) -> dict:
    """Apply geometry to a delivery band. Counts floor at DENSE_MIN_ITEMS so O8 can
    never tighten past O9's content floor — a cap below the floor is unsatisfiable,
    and that contradiction belongs to the skeleton, not to the author's outline."""
    out = dict(band)
    for k in ("p", "points_char"):
        out[k] = math.floor(band[k] * char_scale)
    for k in ("s03_points", "s04_col_points", "s10_rows"):
        out[k] = max(DENSE_MIN_ITEMS, math.floor(band[k] * count_scale))
    return out


def vwidth(s: str) -> float:
    return sum(1.0 if unicodedata.east_asian_width(c) in "WF" else 0.5 for c in s)


def budget_for(leaf: str, band: dict) -> float | None:
    """Character budget for a content leaf key; `p`/`points` follow the delivery band."""
    if leaf == "p":
        return band["p"]
    if leaf == "points":  # S04 col bare-string points (S03 point text is leaf `p`)
        return band["points_char"]
    return KEY_BUDGETS_FIXED.get(leaf)


def looks_like_assertion(t: str) -> bool:
    """O3 — real conclusion vs bare topic label. A digit, an assertion verb, or a
    compound pairing/contrast of enough length all read as conclusions."""
    if HAS_DIGIT.search(t):
        return True
    if ASSERTION_VERB.search(t):
        return True
    # "A 用 X，B 用 Y" / "X：Y" — a compound statement, not a one-word topic label
    if COMPOUND_SEP.search(t) and vwidth(t) >= 12:
        return True
    return False


def primary_count(lay: str, content) -> int | None:
    """O9 — the count of the page's primary information items, per layout. None = layout
    has no single 'main list' to measure thinness against."""
    if not isinstance(content, dict):
        return None
    if lay == "S03":
        pts = content.get("points")
        return len(pts) if isinstance(pts, list) else None
    if lay == "S04":
        return sum(len((content.get(c) or {}).get("points") or [])
                   for c in ("col_a", "col_b")
                   if isinstance(content.get(c), dict))
    if lay == "S05":
        st = content.get("stats")
        return len(st) if isinstance(st, list) else None
    if lay == "S06":
        nd = content.get("nodes")
        return len(nd) if isinstance(nd, list) else None
    if lay == "S09":
        it = content.get("items")
        return len(it) if isinstance(it, list) else None
    if lay == "S10":
        rw = content.get("rows")
        return len(rw) if isinstance(rw, list) else None
    # ADR-068 Phase D layouts — same contract: the field that carries the page's
    # primary list, so O9's thinness floor works on them without special-casing.
    for l, field in (("S11", "points"), ("S12", "cards"), ("S13", "quadrants"),
                     ("S14", "steps"), ("S15", "bars"), ("S16", "stats"),
                     ("S18", "levels"), ("S20", "notes")):
        if lay == l:
            v = content.get(field)
            return len(v) if isinstance(v, list) else None
    return None


def check_bar_values(bars) -> list[str]:
    """O11 — numeric safety for S15 (dashiAI chart-safety, applied at the IR).

    A bar chart is the only layout where the model turns DATA into GEOMETRY
    (width = value / max * 100%). Every classic way that arithmetic explodes has to
    die here, before it becomes a rendered box: a non-number, a negative, an
    infinity, or an all-zero series (division by zero → NaN width → a bar that
    silently does not paint). The physical probe cannot catch these — a zero-width
    div overflows nothing."""
    errs: list[str] = []
    if not isinstance(bars, list) or not bars:
        return ["O11 S15: content.bars must be a non-empty list"]
    vals = []
    for i, b in enumerate(bars):
        if not isinstance(b, dict) or "value" not in b:
            errs.append(f"O11 S15: bars[{i}] needs a numeric 'value'")
            continue
        v = b["value"]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            errs.append(f"O11 S15: bars[{i}].value {v!r} is not a number")
            continue
        if v != v or v in (float("inf"), float("-inf")):
            errs.append(f"O11 S15: bars[{i}].value is not finite")
            continue
        if v < 0:
            errs.append(f"O11 S15: bars[{i}].value {v} is negative — bar width would be undefined")
            continue
        vals.append(v)
    if vals and max(vals) == 0:
        errs.append("O11 S15: every bar value is 0 — width = value/max is a division by zero; "
                    "use a different layout when the data is all-zero")
    return errs


def iter_content_strings(obj, path=""):
    """Yield (dotted_path, leaf_key, string) for every string in a content tree."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from iter_content_strings(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for j, v in enumerate(obj):
            yield from iter_content_strings(v, f"{path}[{j}]")
    elif isinstance(obj, str):
        # leaf = last dotted segment with all list indices removed, so
        # points[0].h → h, items[0] → items, rows[0][1] → rows
        leaf = re.sub(r"\[\d+\]", "", path).rsplit(".", 1)[-1]
        yield path, leaf, obj


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    proj = Path(sys.argv[1])
    outline_f = proj / "outline.json"
    if not outline_f.is_file():
        print(f"ERROR: {outline_f} not found", file=sys.stderr)
        return 2
    try:
        data = json.loads(outline_f.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"ERROR: outline.json invalid JSON: {e}", file=sys.stderr)
        return 2

    fact_ids: set[str] = set()
    facts_f = proj / "research" / "facts.json"
    if facts_f.is_file():
        try:
            fact_ids = {f["fact_id"] for f in json.loads(facts_f.read_text(encoding="utf-8"))
                        if isinstance(f, dict) and "fact_id" in f}
        except (json.JSONDecodeError, TypeError):
            print("WARN: research/facts.json unreadable — fact_id references can't be verified")

    errors: list[str] = []
    warns: list[str] = []
    slides = data.get("slides", [])
    if not slides:
        print("ERROR: outline has no slides", file=sys.stderr)
        return 1

    mode = data.get("mode")
    if mode is not None and mode not in VALID_MODES:
        errors.append(f"O1 mode {mode!r} not in {sorted(VALID_MODES)}")

    delivery = data.get("delivery_purpose", DEFAULT_DELIVERY)
    if delivery not in VALID_DELIVERY:
        errors.append(f"O1 delivery_purpose {delivery!r} not in {sorted(VALID_DELIVERY)} "
                      f"— using {DEFAULT_DELIVERY!r} for budgets")
        delivery = DEFAULT_DELIVERY
    base_band = DELIVERY_BANDS[delivery]
    # ADR-068 D5 — fold the deck's skeleton geometry into the budgets. tokens.css is
    # absent on the Phase 2 run (written in Phase 3); base geometry is the answer then,
    # and SKILL.md re-runs this gate once tokens.css exists.
    tokens_f = proj / "tokens.css"
    css_tokens = read_css_tokens(tokens_f.read_text(encoding="utf-8")) if tokens_f.is_file() else {}
    char_scale, count_scale, geo, geo_errs = geometry_scale(css_tokens)
    errors.extend(geo_errs)
    band = scaled_band(base_band, char_scale, count_scale)

    # top-level "title" only feeds the HTML <title> tag (never rendered on the
    # 1280x720 canvas) — the visual cover-title budget applies to the S01 page title

    indexes = [s.get("index") for s in slides]
    if indexes != list(range(1, len(slides) + 1)):
        errors.append(f"O1 indexes not contiguous from 1: {indexes}")

    breathing = 0
    scenario_pages: list[int] = []
    low_conf: list[int] = []
    for s in slides:
        i = s.get("index", "?")
        if s.get("rhythm") not in VALID_RHYTHMS:
            errors.append(f"O1 p{i}: rhythm {s.get('rhythm')!r} invalid")
        if s.get("rhythm") == "breathing":
            breathing += 1

        # O8 — IR-level overflow gate: budgets & caps apply to ALL pages (covers too)
        lay = s.get("layout")
        title = str(s.get("title") or "")
        t_budget = COVER_TITLE_BUDGET if lay == "S01" else TITLE_BUDGET
        tw = vwidth(title)
        if title and tw > t_budget:
            errors.append(f"O8 p{i}: title 视觉宽度 {tw:g} > {t_budget}: {title!r}")
        content = s.get("content") or {}
        content_strings = list(iter_content_strings(content))  # walk once; O8 + O5 reuse
        for path, leaf, val in content_strings:
            vw = vwidth(val)
            bud = budget_for(leaf, band)
            if bud is not None and vw > bud:
                errors.append(f"O8 p{i}: content.{path} 视觉宽度 {vw:g} > "
                              f"{bud} — 改写压进预算，不是缩字号: {val!r}")
        if lay in STRUCT_CAPS and isinstance(content, dict):
            fld, lo, hi = STRUCT_CAPS[lay]
            if hi is None:
                hi = band["s03_points"] if lay == "S03" else lo
            items = content.get(fld)
            if isinstance(items, list) and not lo <= len(items) <= hi:
                errors.append(f"O8 p{i}: {lay} {fld} 条目数 {len(items)} 超出 [{lo},{hi}]")
        if lay == "S15" and isinstance(content, dict):
            errors.extend(f"p{i}: {e}" for e in check_bar_values(content.get("bars")))
        if lay == "S04" and isinstance(content, dict):
            cap = band["s04_col_points"]
            for col in ("col_a", "col_b"):
                pts = (content.get(col) or {}).get("points") if isinstance(content.get(col), dict) else None
                if isinstance(pts, list) and len(pts) > cap:
                    errors.append(f"O8 p{i}: S04 {col}.points 条目数 {len(pts)} > {cap}")
        if lay == "S10" and isinstance(content, dict):
            rows = content.get("rows")
            if isinstance(rows, list):
                if len(rows) > band["s10_rows"]:
                    errors.append(f"O8 p{i}: S10 rows {len(rows)} > {band['s10_rows']}")
                if any(isinstance(r, list) and len(r) > 4 for r in rows):
                    errors.append(f"O8 p{i}: S10 列数 > 4")

        if lay in CONTENT_EXEMPT_LAYOUTS:
            if not str(s.get("speaker_notes") or "").strip():
                errors.append(f"O2 p{i}: missing speaker_notes")  # schema: 全页必填
            continue

        # content page contract
        takeaway = str(s.get("takeaway") or "").strip()
        evidence = s.get("evidence") or []
        conf = s.get("confidence")
        if not takeaway:
            errors.append(f"O2 p{i}: content page missing takeaway")
        if not isinstance(evidence, list) or len(evidence) < 2:
            errors.append(f"O2 p{i}: evidence needs >=2 entries, got {len(evidence) if isinstance(evidence, list) else evidence!r}")
        if conf not in VALID_CONFIDENCE:
            errors.append(f"O2 p{i}: confidence {conf!r} invalid")
        elif conf == "low":
            low_conf.append(i)
        if not str(s.get("speaker_notes") or "").strip():
            errors.append(f"O2 p{i}: missing speaker_notes")

        if takeaway and not looks_like_assertion(takeaway):
            errors.append(f"O3 p{i}: takeaway reads as a bare label, not an assertion: {takeaway!r}")

        # O9 — dense pages must not be near-empty (count-based, advisory)
        if s.get("rhythm") == "dense":
            pc = primary_count(lay, content)
            if pc is not None and pc < DENSE_MIN_ITEMS:
                warns.append(f"O9 p{i}: dense 页只有 {pc} 个要点 (<{DENSE_MIN_ITEMS}) — "
                             f"补点或换更密版式 (densify)，别让 dense 页留半空")
            if isinstance(evidence, list) and len(evidence) < DENSE_MIN_EVIDENCE:
                warns.append(f"O9 p{i}: dense 页只有 {len(evidence)} 条 evidence "
                             f"(<{DENSE_MIN_EVIDENCE}) — dense 页应有更实的支撑密度")

        page_has_scenario = False
        for ev in evidence if isinstance(evidence, list) else []:
            if not isinstance(ev, dict):
                errors.append(f"O4 p{i}: evidence entry must be an object: {ev!r}")
                continue
            if "fact_id" in ev:
                if fact_ids and ev["fact_id"] not in fact_ids:
                    errors.append(f"O4 p{i}: fact_id {ev['fact_id']!r} not in research/facts.json")
                elif not fact_ids:
                    warns.append(f"O4 p{i}: fact_id {ev['fact_id']!r} but no research/facts.json to verify against")
            elif ev.get("source") == "user-doc":
                pass
            elif ev.get("scenario") is True:
                page_has_scenario = True
            else:
                errors.append(f"O4 p{i}: evidence entry needs fact_id / source:user-doc / scenario:true: {ev!r}")
        if page_has_scenario:
            scenario_pages.append(i)

        # O5 — per FIELD: a digit elsewhere on the page must not excuse an empty
        # phrase in this field (page-blob checking neutralised the gate entirely)
        fields = [("takeaway", takeaway)]
        fields += [(f"content.{path}", v) for path, _leaf, v in content_strings]
        for ev in evidence if isinstance(evidence, list) else []:
            if isinstance(ev, dict):
                fields += [(f"evidence.{k}", v) for k, v in ev.items() if isinstance(v, str)]
        for fname, ftext in fields:
            for m in set(BUZZWORDS.findall(ftext)):
                if not HAS_DIGIT.search(ftext):
                    errors.append(f"O5 p{i}: buzzword {m!r} in {fname} without concrete "
                                  f"numbers in the same field — say something specific")

    if len(slides) >= 8:
        need = max(1, len(slides) // 8)
        if breathing < need:
            errors.append(f"O6 {len(slides)} pages with {breathing} breathing page(s) — "
                          f"need >= {need} (one per ~8 pages)")

    for w in warns:
        print("WARN ", w)
    for e in errors:
        print("ERROR", e)
    if scenario_pages:
        print(f"NOTE  scenario (fictional) data pages: {scenario_pages} — MUST render a visible 「示意数据」 footnote")
    if low_conf:
        print(f"NOTE  low-confidence pages to disclose in the delivery summary: {low_conf}")
    geo_note = (f"pad={geo['--sl-pad']:g}px lh={geo['--lh-body']:g} fw={geo['--fw-body']:g} "
                f"measure={geo['--measure']:g}em → char×{char_scale:.2f} count×{count_scale:.2f}"
                f"{'' if tokens_f.is_file() else '  (tokens.css absent → base geometry)'}")
    print(f"geometry: {geo_note} · p<={band['p']} points<={band['points_char']} "
          f"S03<={band['s03_points']} S04col<={band['s04_col_points']} S10rows<={band['s10_rows']}")
    print(f"validate-outline: {len(slides)} slides · delivery={delivery} · "
          f"{len(errors)} errors · {len(warns)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
