#!/usr/bin/env python3
"""Behaviour tests for the `pptx-edit` skill (discussions/059 §六·补八).

    python3 scripts/test-pptx-edit-skill.py
    python3 scripts/test-pptx-edit-skill.py --json

WHY THIS EXISTS
---------------
Two of these scripts' properties are LIMITS, not features — table/group text is
invisible to both of them, and a phrase PowerPoint split across runs will not
match. S6 wrote those limits into SKILL.md as measured facts. A claim in a
SKILL.md that nothing checks is a claim that rots: the day someone teaches
pptx_read.py to walk tables, SKILL.md starts lying in the other direction.
So the limits are asserted here, in both directions.

The other half is a regression guard. The S6 wrap-up review fed the scripts a
.pptx built by a minimal OOXML generator rather than by PowerPoint — no
slideLayout relationship, no slideMaster — and BOTH scripts died with a bare
traceback (KeyError in pptx_read, IndexError in pptx_edit's own bounds check).
That is the failure mode the whole family is held to: adversarial input must
exit non-zero with one sentence, never a traceback.

Every assertion runs twice: once against the real scripts (must stay silent) and
once against a state carrying exactly the defect it hunts (must fire). The four
LIVE controls do not fabricate output — they re-run the REAL scripts with the
real fix reverted, i.e. they replicate the implementation that actually shipped
until 2026-08-04. A control that cannot tell the two implementations apart is
not a control.

Lives outside skills/builtin/ so it is not packed into skills-builtin.zip.
Exit 0 = every assertion behaved, 1 = something did not.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

# stdout must be UTF-8 on every platform, and on Windows a captured stdout is not
# (same defect the other gates in this directory were fixed for).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass

REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / "skills" / "builtin" / "pptx-edit"
SCRIPTS = SKILL / "scripts"
PY = sys.executable

# The probe appears TWICE in the fixture: once in a plain textbox and once in a
# table cell. That is what makes the silent-miss assertion possible — the tool
# replaces one, leaves the other, and reports a count that mentions neither fact.
PROBE = "营业收入同比增长"
TABLE_ONLY = "表内独有文字"
GROUP_ONLY = "组合内独有文字"
SPLIT_HEAD, SPLIT_TAIL = "毛利", "率保持稳定"   # one phrase, two runs
SINGLE_RUN = "费用率同比下降"


# ── fixtures ──────────────────────────────────────────────────────────────────
def build_deck(path: Path, *, with_table=True, split_phrase=True, with_group=True) -> None:
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "季度经营分析"

    tb = s.shapes.add_textbox(Inches(0.4), Inches(1.6), Inches(4), Inches(0.8))
    tb.text_frame.text = PROBE

    tb2 = s.shapes.add_textbox(Inches(0.4), Inches(2.6), Inches(4), Inches(0.8))
    p = tb2.text_frame.paragraphs[0]
    if split_phrase:
        for chunk in (SPLIT_HEAD, SPLIT_TAIL):
            p.add_run().text = chunk
    else:
        p.add_run().text = SPLIT_HEAD + SPLIT_TAIL        # one run: control arm

    tb3 = s.shapes.add_textbox(Inches(0.4), Inches(3.6), Inches(4), Inches(0.8))
    tb3.text_frame.text = SINGLE_RUN + " 1.2 个百分点"

    if with_table:
        t = s.shapes.add_table(2, 2, Inches(5), Inches(1.6), Inches(4), Inches(1.2)).table
        t.cell(0, 0).text = TABLE_ONLY
        t.cell(1, 1).text = PROBE                          # the second copy

    if with_group:
        g = s.shapes.add_group_shape()
        gb = g.shapes.add_textbox(Inches(5), Inches(3.6), Inches(3), Inches(0.8))
        gb.text_frame.text = GROUP_ONLY

    prs.save(str(path))


def build_layoutless(src: Path, dst: Path) -> None:
    """A .pptx that opens but carries no slideLayout/slideMaster.

    Minimal OOXML generators produce these; PowerPoint does not. Both crashes the
    S6 review found were on a file shaped exactly like this.
    """
    drop = re.compile(r"^ppt/(slideLayouts|slideMasters|theme)/")
    strip_rel = re.compile(r"<Relationship[^>]*(?:slideLayout|slideMaster|theme)[^>]*/>")
    strip_ovr = re.compile(r"<Override[^>]*(?:slideLayout|slideMaster|theme)[^>]*/>")
    strip_lst = re.compile(r"<p:sldMasterIdLst>.*?</p:sldMasterIdLst>", re.S)
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            if drop.match(item.filename):
                continue
            data = zin.read(item.filename)
            if item.filename.endswith(".rels") or item.filename == "[Content_Types].xml":
                text = strip_ovr.sub("", strip_rel.sub("", data.decode("utf-8")))
                data = text.encode("utf-8")
            if item.filename == "ppt/presentation.xml":
                data = strip_lst.sub("", data.decode("utf-8")).encode("utf-8")
            zo.writestr(item, data)


def build_adversarial(work: Path) -> dict[str, Path]:
    out = {}
    (work / "empty.pptx").write_bytes(b"")
    out["0 字节"] = work / "empty.pptx"
    (work / "notzip.pptx").write_bytes(b"this is plainly not a zip")
    out["非 zip"] = work / "notzip.pptx"
    (work / "adir.pptx").mkdir()
    out["目录"] = work / "adir.pptx"
    with zipfile.ZipFile(work / "emptyzip.pptx", "w") as z:
        z.writestr("hello.txt", "hi")
    out["zip 但不是 pptx"] = work / "emptyzip.pptx"
    out["不存在"] = work / "missing.pptx"
    return out


# ── running the scripts ───────────────────────────────────────────────────────
def run(script_dir: Path, name: str, *args: str) -> dict:
    proc = subprocess.run([PY, str(script_dir / name), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8")
    return {"exit": proc.returncode, "out": proc.stdout or "", "err": proc.stderr or ""}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def collect(work: Path, script_dir: Path, *, with_table=True, split_phrase=True,
            with_group=True, layoutless_has_layouts=False) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    deck = work / "deck.pptx"
    build_deck(deck, with_table=with_table, split_phrase=split_phrase, with_group=with_group)

    nolayout = work / "nolayout.pptx"
    if layoutless_has_layouts:
        shutil.copyfile(deck, nolayout)      # control arm: it is NOT layout-less
    else:
        build_layoutless(deck, nolayout)

    ctx: dict = {"work": work, "script_dir": script_dir}
    ctx["read"] = run(script_dir, "pptx_read.py", deck)
    ctx["read_json"] = run(script_dir, "pptx_read.py", deck, "--json")
    ctx["read_nolayout"] = run(script_dir, "pptx_read.py", nolayout)

    # Every edit gets its OWN copy of the deck. Sharing one input makes the
    # assertions order-dependent: an implementation that ignores --out would edit
    # the shared file in place and every later measurement would be reading a
    # document the previous case already changed.
    def fresh(tag: str) -> Path:
        cp = work / f"in-{tag}.pptx"
        shutil.copyfile(deck, cp)
        return cp

    # replace the probe, which lives in a textbox AND in a table cell
    src1, out1 = fresh("replace"), work / "replaced.pptx"
    before = sha(src1)
    ctx["replace"] = run(script_dir, "pptx_edit.py", src1, "--replace", PROBE, "XX",
                         "--out", out1)
    ctx["input_untouched"] = sha(src1) == before
    ctx["surviving_probe"] = count_everywhere(out1, PROBE) if out1.exists() else None
    ctx["replaced_textbox"] = count_textframes(out1, "XX") if out1.exists() else None

    out2 = work / "split.pptx"
    ctx["replace_split"] = run(script_dir, "pptx_edit.py", fresh("split"), "--replace",
                               SPLIT_HEAD + SPLIT_TAIL, "YY", "--out", out2)
    out3 = work / "single.pptx"
    ctx["replace_single"] = run(script_dir, "pptx_edit.py", fresh("single"), "--replace",
                                SINGLE_RUN, "ZZ", "--out", out3)
    ctx["single_applied"] = count_textframes(out3, "ZZ") if out3.exists() else None

    ctx["add_nolayout"] = run(script_dir, "pptx_edit.py", nolayout, "--add-slide",
                              "--layout", "0", "--out", work / "added.pptx")
    ctx["layout_high"] = run(script_dir, "pptx_edit.py", fresh("hi"), "--add-slide",
                             "--layout", "99", "--out", work / "hi.pptx")
    ctx["layout_neg"] = run(script_dir, "pptx_edit.py", fresh("neg"), "--add-slide",
                            "--layout", "-1", "--out", work / "neg.pptx")

    adv = build_adversarial(work)
    ctx["adversarial"] = {}
    for label, path in adv.items():
        ctx["adversarial"][label] = {
            "read": run(script_dir, "pptx_read.py", path),
            "edit": run(script_dir, "pptx_edit.py", path, "--replace", "a", "b",
                        "--out", work / "adv-out.pptx"),
        }

    # what the fixture actually contains, read back with the library directly —
    # never trust the tool under test to describe its own input
    ctx["fixture"] = describe(deck)
    ctx["nolayout_really_raises"] = layoutless_raises(nolayout)
    return ctx


def describe(path: Path) -> dict:
    from pptx import Presentation
    prs = Presentation(str(path))
    tf_texts, cell_texts, runs, group_texts = [], [], [], []
    for slide in prs.slides:
        for sh in slide.shapes:
            if sh.has_text_frame:
                tf_texts.append(sh.text_frame.text)
                for para in sh.text_frame.paragraphs:
                    if len(para.runs) > 1:
                        runs.append([r.text for r in para.runs])
            if getattr(sh, "has_table", False) and sh.has_table:
                for row in sh.table.rows:
                    for cell in row.cells:
                        cell_texts.append(cell.text)
            # A group is neither a text frame nor a table; reaching inside it is
            # the only way to prove the fixture really carries group text.
            if getattr(sh, "shapes", None) is not None and not sh.has_text_frame:
                for inner in sh.shapes:
                    if inner.has_text_frame and inner.text_frame.text.strip():
                        group_texts.append(inner.text_frame.text)
    return {"textframes": tf_texts, "cells": cell_texts, "multirun": runs,
            "group_texts": group_texts}


def count_everywhere(path: Path, needle: str) -> int:
    """Occurrences across text frames AND table cells — the full truth."""
    d = describe(path)
    return sum(t.count(needle) for t in d["textframes"] + d["cells"])


def count_textframes(path: Path, needle: str) -> int:
    return sum(t.count(needle) for t in describe(path)["textframes"])


def layoutless_raises(path: Path) -> bool:
    from pptx import Presentation
    prs = Presentation(str(path))
    try:
        _ = prs.slides[0].slide_layout.name
        return False
    except Exception:  # noqa: BLE001
        return True


def reported_count(res: dict) -> int | None:
    m = re.search(r"replacements:\s*(\d+)", res["out"])
    return int(m.group(1)) if m else None


# ── the assertions ────────────────────────────────────────────────────────────
CHECKS: dict[str, dict] = {}


def check(cid: str, title: str):
    def deco(fn):
        CHECKS[cid] = {"id": cid, "title": title, "fn": fn}
        return fn
    return deco


@check("V0", "the fixture actually gives every assertion something to look at")
def v0(ctx: dict) -> list[str]:
    """A silent check and a check with no subject look identical from outside."""
    out = []
    f = ctx["fixture"]
    if PROBE not in f["cells"]:
        out.append("no table cell carries the probe — L1/L4 have no subject")
    if TABLE_ONLY not in f["cells"]:
        out.append("the table-only string is missing — L1 has no subject")
    if f["group_texts"] != [GROUP_ONLY]:
        out.append(f"the group shape does not carry its probe ({f['group_texts']}) "
                   f"— the group half of L1 has no subject")
    if not any(r == [SPLIT_HEAD, SPLIT_TAIL] for r in f["multirun"]):
        out.append("the probe phrase is not split across two runs — L3 has no subject")
    if sum(t.count(PROBE) for t in f["textframes"]) != 1:
        out.append("the probe does not appear exactly once in a text frame — L4 is ambiguous")
    if not ctx["nolayout_really_raises"]:
        out.append("the layout-less fixture still resolves a layout — X1/X2 have no subject")
    if ctx["read"]["exit"] != 0 or not ctx["read"]["out"].strip():
        out.append("reading the normal deck produced nothing")
    return out


@check("L1", "table and group text are invisible to pptx_read (a documented LIMIT)")
def l1(ctx: dict) -> list[str]:
    """SKILL.md 「限制」 says so in words; this is the same claim as an assertion.
    It fires in BOTH directions — if someone teaches the script to walk tables,
    this goes red and SKILL.md has to be corrected rather than silently rot."""
    out = []
    if TABLE_ONLY in ctx["read"]["out"]:
        out.append("table text now IS reported — SKILL.md 「限制」 is out of date")
    if GROUP_ONLY in ctx["read"]["out"]:
        out.append("group text now IS reported — SKILL.md 「限制」 is out of date")
    return out


@check("L3", "a phrase split across runs does not match (a documented LIMIT)")
def l3(ctx: dict) -> list[str]:
    n = reported_count(ctx["replace_split"])
    if n != 0:
        return [f"cross-run replacement reported {n}, expected 0 "
                f"(SKILL.md says it cannot match)"]
    return []


@check("L4", "a missed replacement is silent — and the count does not admit it")
def l4(ctx: dict) -> list[str]:
    """The probe is in a textbox AND in a table cell. The tool changes one, leaves
    the other, and prints `replacements: 1` — which names neither fact. This is the
    defect SKILL.md warns about; it is asserted so the warning stays true, and so
    that fixing it becomes a deliberate, visible change."""
    out = []
    if ctx["replaced_textbox"] != 1:
        out.append(f"the text-frame copy was not replaced ({ctx['replaced_textbox']})")
    if ctx["surviving_probe"] != 1:
        out.append(f"expected exactly 1 surviving copy in the table, got "
                   f"{ctx['surviving_probe']}")
    if reported_count(ctx["replace"]) != 1:
        out.append(f"reported count was {reported_count(ctx['replace'])}, expected 1")
    return out


@check("W1", "it does replace what it CAN see")
def w1(ctx: dict) -> list[str]:
    """Without this, every limit assertion above is also satisfied by a tool that
    replaces nothing at all — and a tool that finds nothing gets reported as broken
    within a minute, while one that finds some things gets trusted forever."""
    out = []
    if ctx["single_applied"] != 1:
        out.append(f"a single-run phrase was not replaced ({ctx['single_applied']})")
    if reported_count(ctx["replace_single"]) != 1:
        out.append(f"reported {reported_count(ctx['replace_single'])}, expected 1")
    return out


@check("X1", "reading a .pptx with no slideLayout survives with one sentence")
def x1(ctx: dict) -> list[str]:
    r = ctx["read_nolayout"]
    out = []
    if "Traceback" in r["err"]:
        out.append("bare traceback on a layout-less .pptx")
    if r["exit"] != 0:
        out.append(f"exit {r['exit']} — the text is still readable, "
                   f"a decorative layout name must not cost the whole document")
    if "(no layout)" not in r["out"]:
        out.append("the missing layout is not reported as such")
    if PROBE not in r["out"]:
        out.append("the slide text was lost along with the layout")
    return out


@check("X2", "adding a slide to a master-less .pptx fails with one sentence")
def x2(ctx: dict) -> list[str]:
    r = ctx["add_nolayout"]
    out = []
    if "Traceback" in r["err"]:
        out.append("bare traceback — the bounds check itself crashed")
    if r["exit"] == 0:
        out.append("reported success on a file that has no slide master")
    if "no slide master" not in r["err"]:
        out.append("the reason is not stated")
    return out


@check("X3", "adversarial input never produces a traceback")
def x3(ctx: dict) -> list[str]:
    out = []
    for label, res in ctx["adversarial"].items():
        for name, r in res.items():
            if "Traceback" in r["err"]:
                out.append(f"{name} on 「{label}」: bare traceback")
            if r["exit"] == 0:
                out.append(f"{name} on 「{label}」: exit 0")
    return out


@check("A1", "--layout out of range is refused and the valid range is named")
def a1(ctx: dict) -> list[str]:
    out = []
    for label, r in (("99", ctx["layout_high"]), ("-1", ctx["layout_neg"])):
        if r["exit"] == 0:
            out.append(f"--layout {label} was accepted")
        if "have 0.." not in r["err"]:
            out.append(f"--layout {label}: the valid range is not named")
    return out


@check("E1", "--out leaves the input byte-identical")
def e1(ctx: dict) -> list[str]:
    return [] if ctx["input_untouched"] else ["--out still modified the input file"]


# ── negative controls ─────────────────────────────────────────────────────────
def patched(work: Path, old: str, new: str, name: str) -> Path:
    """A copy of the skill's scripts with one edit applied.

    Raises if the anchor is not found exactly once — a control arm that silently
    fails to apply looks identical to one that applied and did nothing.
    """
    dest = work / f"patched-{name}"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(SCRIPTS, dest)
    hits = 0
    for py in dest.glob("*.py"):
        text = py.read_text(encoding="utf-8")
        if old in text:
            hits += text.count(old)
            py.write_text(text.replace(old, new), encoding="utf-8")
    if hits != 1:
        raise SystemExit(f"control {name!r}: anchor matched {hits} times, expected 1 "
                         f"— the control did not replicate the defect")
    return dest


def live_read_crashes(work: Path):
    """Restore the implementation that shipped until 2026-08-04, verbatim."""
    d = patched(work, """        try:
            layout = slide.slide_layout.name
        except Exception:  # noqa: BLE001
            layout = "(no layout)"
        slides.append({"index": idx, "layout": layout, "texts": texts})""",
        """        slides.append({"index": idx, "layout": slide.slide_layout.name, "texts": texts})""",
        "read-crash")
    return collect(work / "c1", d)


def live_bounds_crashes(work: Path):
    d = patched(work, """        try:
            n_layouts = len(prs.slide_layouts)
        except Exception as exc:  # noqa: BLE001
            print(f"Cannot add a slide to {args.file}: it has no slide master ({exc})", file=sys.stderr)
            return 1
        if args.layout < 0 or args.layout >= n_layouts:
            print(f"Bad --layout {args.layout} (have 0..{n_layouts - 1})", file=sys.stderr)
            return 1""",
        """        if args.layout < 0 or args.layout >= len(prs.slide_layouts):
            print(f"Bad --layout {args.layout} (have 0..{len(prs.slide_layouts) - 1})", file=sys.stderr)
            return 1""",
        "bounds-crash")
    return collect(work / "c2", d)


def live_replaces_nothing(work: Path):
    d = patched(work, "            if old in run.text:", "            if False:", "no-op")
    return collect(work / "c3", d)


def live_out_ignored(work: Path):
    d = patched(work, "    out = args.out or args.file", "    out = args.file", "out-ignored")
    return collect(work / "c4", d)


def live_read_walks_tables(work: Path):
    d = patched(work,
        "        texts = [s.text for s in slide.shapes if s.has_text_frame and s.text.strip()]",
        "        texts = [s.text for s in slide.shapes if s.has_text_frame and s.text.strip()]\n"
        "        for _sh in slide.shapes:\n"
        "            if getattr(_sh, 'has_table', False) and _sh.has_table:\n"
        "                texts += [c.text for r in _sh.table.rows for c in r.cells if c.text.strip()]",
        "walks-tables")
    return collect(work / "c5", d)


def fixture_no_table(work: Path):
    return collect(work / "c6", SCRIPTS, with_table=False)


def fixture_one_run(work: Path):
    return collect(work / "c7", SCRIPTS, split_phrase=False)


def fixture_has_layouts(work: Path):
    return collect(work / "c8", SCRIPTS, layoutless_has_layouts=True)


FLAWS = [
    ("LIVE: pptx_read as it shipped until 2026-08-04 (unguarded slide_layout)",
     live_read_crashes, {"X1"}, ""),
    ("LIVE: pptx_edit as it shipped until 2026-08-04 (bounds check reaches the master)",
     live_bounds_crashes, {"X2"}, ""),
    ("LIVE: --replace matches nothing at all", live_replaces_nothing, {"W1", "L4"},
     "L4 also fires, and must: 'the text-frame copy was replaced' is the half of "
     "L4 that a do-nothing implementation breaks"),
    ("LIVE: --out is ignored and it writes in place", live_out_ignored,
     {"E1", "L4", "W1"},
     "L4/W1 also fire, and must: nothing is ever written to the --out path, so "
     "every assertion that reads that artifact has no artifact to read. Declared "
     "rather than explained away — a cascade note does not suppress anything here, "
     "an undeclared check that fires is still a failure"),
    ("LIVE: pptx_read learns to walk tables", live_read_walks_tables, {"L1"},
     "L4 does NOT fire: reading tables changes nothing about what --replace does"),
    ("CONTROL: fixture loses the table", fixture_no_table, {"V0", "L4"},
     "L4 also fires: with no second copy there is nothing for it to count"),
    ("CONTROL: fixture phrase is no longer split across runs", fixture_one_run,
     {"V0", "L3"}, "L3 also fires: a single-run phrase DOES match, which is the "
                   "very thing L3 asserts cannot happen"),
    ("CONTROL: the layout-less fixture actually has layouts", fixture_has_layouts,
     {"V0", "X1", "X2"},
     "X1 and X2 both fire, and must: with a real master present there is no "
     "'(no layout)' for X1 to find, and --add-slide legitimately SUCCEEDS, which "
     "is exactly the 'reported success' branch X2 watches"),
]


def fired(ctx: dict) -> dict[str, list[str]]:
    return {cid: f for cid, c in CHECKS.items() if (f := c["fn"](ctx))}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    try:
        import pptx  # noqa: F401
    except ImportError:
        print("python-pptx is not installed — this gate cannot run "
              "(it is a required dependency of the skill under test)", file=sys.stderr)
        return 1

    results, passed, failed = [], 0, 0
    with tempfile.TemporaryDirectory(prefix="pptx-edit-gate-") as td:
        work = Path(td)
        (work / "base").mkdir()
        base = collect(work / "base", SCRIPTS)

        clean = fired(base)
        ok = not clean
        results.append({"case": "real output of the real scripts", "expect": "silence",
                        "ok": ok, "detail": [f"{k}: {v[0]}" for k, v in clean.items()]})
        passed, failed = (1, 0) if ok else (0, 1)

        for name, mutate, expected, cascade in FLAWS:
            sub = work / f"flaw-{len(results)}"
            sub.mkdir()
            ctx = mutate(sub)
            got = fired(ctx)
            unexpected, missing = set(got) - expected, expected - set(got)
            ok = not unexpected and not missing
            detail = []
            if missing:
                detail.append(f"did NOT fire: {sorted(missing)}")
            if unexpected:
                detail.append(f"unexpectedly fired: {sorted(unexpected)}")
            results.append({"case": name, "expect": sorted(expected),
                            "fired": sorted(got), "ok": ok, "detail": detail,
                            "cascade_note": cascade})
            passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)

    if args.json:
        print(json.dumps({"results": results, "assertions": len(CHECKS),
                          "passed": passed, "failed": failed}, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['case']}")
            if r.get("cascade_note"):
                print(f"        note: {r['cascade_note']}")
            for d in r["detail"]:
                print(f"        {d}")
        print(f"\n[pptx-edit-skill] {passed} passed, {failed} failed, "
              f"{len(CHECKS)} assertions")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
