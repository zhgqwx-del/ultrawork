#!/usr/bin/env python3
"""deckcraft variant picker — deterministic, reproducible candidate ordering.

    python3 pick_variants.py <project_dir> [--topic "<主题>"] [--seed <str>] [--n 3]

Why this is a script and not a line in a markdown file
------------------------------------------------------
"Present the candidates in random order, don't always pick the first one" written
into a reference doc is exactly the failure mode ADR-067 was built on: guidance in
prose is unreliable, so a remedy written in prose is unreliable too. discussions/053
§2.1 has the receipt — the SKILL.md-mandated second question round gets skipped
outright on real runs. And an LLM asked to "pick randomly" reliably picks whatever
it has seen most, which is the convergence this whole ADR exists to break.

So the shuffle happens here, in code. The model does not choose the ORDER; it only
answers the question that follows. dashiAI does the same thing for its 1020-layout
library (`layout:query` is a CLI that reshuffles per call and echoes the seed).

Determinism: the order is a pure function of (project name, topic). Same deck →
same candidates forever (reproducible, replayable, diffable); different topic →
different order. No clock, no RNG state, no platform-dependent Mersenne Twister —
candidates are ranked by sha256(seed + id), which is stable everywhere.

Temperature spread: the candidate set is forced to span at least two temperature
bands (安静/中性/大胆) whenever the registry offers them. huashu's finding is that
models have a determinate bias toward quiet minimalism, so a candidate set that
happens to be all-quiet re-creates the very default it was meant to break.

Registries are parsed from their SSOT markdown (same discipline as
validate_deck.valid_layouts() reading assets/templates/layouts/) so adding a style or a pairing
in one place can never desync this picker.

Output: <project_dir>/variants.json + a human-readable block on stdout.
Exit 0 = ok, 2 = usage/setup problem.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from console_encoding import configure_utf8_stdio

configure_utf8_stdio()

SKILL_DIR = Path(__file__).resolve().parent.parent
STYLE_INDEX = SKILL_DIR / "references" / "design-styles" / "_index.md"
TYPOGRAPHY = SKILL_DIR / "references" / "typography-cjk.md"

# `| `id` | … | 温度 |` — id in code ticks in column 1; temperature is whichever
# cell holds one of the three band words. Parsing by content rather than by column
# index keeps this working if the table gains or loses a column.
_ROW = re.compile(r"^\|\s*`([a-z0-9-]+)`\s*\|(.*)$")
TEMPERATURES = ("安静", "中性", "大胆")
FALLBACK_STYLES = [("swiss-minimal", "中性"), ("editorial-warm", "安静"),
                   ("tech-dark", "中性"), ("academic-calm", "安静")]
FALLBACK_PAIRINGS = [("sans-neutral", ""), ("serif-classic", ""), ("mono-technical", "")]


def parse_registry(md: Path, fallback: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """[(id, temperature)] from a markdown table; temperature '' when absent."""
    if not md.is_file():
        return list(fallback)
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for line in md.read_text(encoding="utf-8").splitlines():
        m = _ROW.match(line.strip())
        if not m:
            continue
        ident, rest = m.group(1), m.group(2)
        if ident in seen:
            continue
        seen.add(ident)
        temp = next((t for t in TEMPERATURES if t in rest), "")
        out.append((ident, temp))
    return out or list(fallback)


def rank(seed: str, ident: str) -> str:
    return hashlib.sha256(f"{seed}\x00{ident}".encode("utf-8")).hexdigest()


def shuffle(items: list[tuple[str, str]], seed: str) -> list[tuple[str, str]]:
    return sorted(items, key=lambda it: rank(seed, it[0]))


def pick_spread(items: list[tuple[str, str]], seed: str, n: int) -> list[tuple[str, str]]:
    """Top-n of the shuffled list, but force a second temperature band in if the
    straight top-n turned out monochrome and the registry could have done better."""
    order = shuffle(items, seed)
    chosen = order[:n]
    if n < 2:
        return chosen
    bands = {t for _, t in chosen if t}
    if len(bands) >= 2:
        return chosen
    alt = next((it for it in order[n:] if it[1] and it[1] not in bands), None)
    if alt is None:
        return chosen           # registry has no other band to offer — nothing to fix
    return chosen[:-1] + [alt]  # swap the last (lowest-ranked) slot, keep the winner


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True, description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--topic", default="", help="deck 主题；缺省时从 outline.json 的 title 取")
    ap.add_argument("--seed", default="", help="覆盖 seed（回放/复现用），缺省=项目名|主题")
    ap.add_argument("--n", type=int, default=3, help="每类候选个数（默认 3）")
    a = ap.parse_args()

    proj = Path(a.project)
    if not proj.is_dir():
        print(f"ERROR: not a directory: {proj}", file=sys.stderr)
        return 2
    if a.n < 1:
        print("ERROR: --n must be >= 1", file=sys.stderr)
        return 2

    topic = a.topic
    outline_f = proj / "outline.json"
    if not topic and outline_f.is_file():
        try:
            topic = json.loads(outline_f.read_text(encoding="utf-8")).get("title", "")
        except (json.JSONDecodeError, UnicodeDecodeError):
            topic = ""   # a malformed outline must not block variant picking

    seed = a.seed or f"{proj.resolve().name}|{topic}"

    styles = parse_registry(STYLE_INDEX, FALLBACK_STYLES)
    pairings = parse_registry(TYPOGRAPHY, FALLBACK_PAIRINGS)

    style_pick = pick_spread(styles, seed, min(a.n, len(styles)))
    pair_pick = shuffle(pairings, seed + "|font")[:min(a.n, len(pairings))]

    data = {
        "seed": seed,
        "seed_digest": hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16],
        "styles": [s for s, _ in style_pick],
        "style_temperatures": {s: t for s, t in style_pick if t},
        "font_pairings": [p for p, _ in pair_pick],
        "registry_sizes": {"styles": len(styles), "font_pairings": len(pairings)},
        "generated_by": "pick_variants.py",
    }
    (proj / "variants.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"variants: seed={seed!r} digest={data['seed_digest']} "
          f"(registry: {len(styles)} styles / {len(pairings)} pairings)")
    print("风格候选（按此顺序呈现给用户，不要固定选第一个——顺序已由脚本打乱）：")
    for i, (s, t) in enumerate(style_pick, 1):
        print(f"  {i}. {s}" + (f"  [{t}]" if t else ""))
    print("字体配对候选：")
    for i, (p, _) in enumerate(pair_pick, 1):
        print(f"  {i}. {p}")
    print(f"→ {proj / 'variants.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
