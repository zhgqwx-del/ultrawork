#!/usr/bin/env python3
"""deckcraft negative-sample selftest — proves the gates CATCH violations.

The bundled example (examples/ai-coding-pilot) is the positive control: it can
only prove compliant input passes. This script synthesizes violating projects
in a temp dir and asserts each gate rejects them with the expected error code.
Run after any change to skills/builtin/deckcraft/scripts/ or templates:

    python3 scripts/deckcraft-selftest.py            # full run (needs Chrome for probe cases)
    python3 scripts/deckcraft-selftest.py --no-chrome  # skip browser-dependent cases

Exit 0 = all cases behave, 1 = a gate failed to catch (or a positive case failed).
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "skills" / "builtin" / "deckcraft" / "scripts"
PY = sys.executable  # never hardcode python3 vs python (Windows)

TOKENS = (":root{--c-bg:#ffffff;--c-fg:#1a1a1a;--c-primary:#1a1a2e;--c-accent:#c8501e;"
          "--c-muted:#6a6a6a;--c-on-dark:#f5f5f5;--c-line:#dddddd;"
          "--fs-hero:64px;--fs-h1:40px;--fs-h3:22px;--fs-body:17px;--fs-caption:12px}")

PASS = 0
FAIL = 0


def run(script: str, *args: str) -> tuple[int, str]:
    r = subprocess.run([PY, str(SCRIPTS / script), *args],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=180)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def project(td: str, pages: dict[int, str], outline: dict | None = None) -> Path:
    proj = Path(td) / "proj"
    (proj / "pages").mkdir(parents=True)
    (proj / "tokens.css").write_text(TOKENS, encoding="utf-8")
    if outline is not None:
        (proj / "outline.json").write_text(
            json.dumps(outline, ensure_ascii=False), encoding="utf-8")
    for n, frag in pages.items():
        (proj / "pages" / f"page-{n:02d}.html").write_text(frag, encoding="utf-8")
    return proj


def page(inner: str, layout: str = "S03", rhythm: str = "dense") -> str:
    return (f'<section class="slide" data-layout="{layout}" data-rhythm="{rhythm}">'
            f'{inner}<div class="pagenum">1 / 1</div></section>')


def slide(idx: int, layout: str = "S03", rhythm: str = "dense", **kw) -> dict:
    s = {"index": idx, "layout": layout, "rhythm": rhythm, "title": f"页{idx}",
         "content": kw.pop("content", {"points": [{"h": "要点", "p": "说明"}]}),
         "speaker_notes": "讲稿。"}
    if layout not in {"S01", "S02", "S07", "S08"}:
        s.update({"takeaway": "指标下降了 3 成",
                  "evidence": [{"scenario": True}, {"scenario": True}],
                  "confidence": "medium"})
    s.update(kw)
    return s


def expect(name: str, code: int, out: str, marker: str, want_fail: bool = True) -> None:
    global PASS, FAIL
    caught = code != 0 and marker in out
    ok = caught if want_fail else (code == 0)
    if ok:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}: exit={code}, marker {marker!r} "
              f"{'missing' if marker not in out else 'present'}\n--- output ---\n{out}")


def deck_case(name: str, inner: str, marker: str, single: bool = True, **pagekw) -> None:
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {1: page(inner, **pagekw)})
        args = [str(proj)] + (["--single"] if single else [])
        code, out = run("validate_deck.py", *args)
        expect(name, code, out, marker)


def deck_nofire(name: str, inner: str, marker: str, **pagekw) -> None:
    """positive control: the given marker/gate must NOT fire on legit input."""
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {1: page(inner, **pagekw)})
        code, out = run("validate_deck.py", str(proj), "--single")
        expect(name, 1 if marker in out else 0, out, marker, want_fail=False)


def outline_case(name: str, outline: dict, marker: str, want_fail: bool = True) -> None:
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {}, outline)
        code, out = run("validate_outline.py", str(proj))
        expect(name, code, out, marker, want_fail)


def main() -> int:
    no_chrome = "--no-chrome" in sys.argv

    # ── validate_deck: every dodge the adversarial review found must now be caught
    deck_case("E1 hex color", '<div style="color:#ff0000">x</div>', "E1")
    deck_case("E1 named color", '<div style="background:crimson">x</div>', "E1")
    deck_case("E1 named color shorthand", '<div style="border:1px solid red">x</div>', "E1")
    deck_case("E1 SVG fill attr", '<svg><rect fill="#00ff00"/></svg>', "E1")
    deck_case("E1 SVG stop-color attr",
              '<svg><stop stop-color="gold"/></svg>', "E1")
    deck_case("E2 em font-size", '<div style="font-size:2.5em">x</div>', "E2")
    deck_case("E2 rem font-size", '<div style="font-size:1.2rem">x</div>', "E2")
    deck_case("E4 css gradient",
              '<div style="background:linear-gradient(#fff,#000)">x</div>', "E4")
    deck_case("E4 SVG gradient element",
              '<svg><linearGradient id="g"/></svg>', "E4")
    deck_case("E6 generator signature", '<div>Generated by deckcraft</div>', "E6")
    deck_case("E8 stray close tag", '<div>x</div></section><section class="slide">', "E8")
    deck_case("E9 display:none", '<div style="display:none">hidden</div>', "E9")
    deck_case("E9 opacity:0", '<div style="opacity:0">hidden</div>', "E9")

    # ── false-positive guards: legit input the gates must NOT flag
    deck_nofire("E9 opacity:0.5 allowed", '<div style="opacity:0.5">dim</div>', "E9")
    # E1 must not read a color word out of a token name or an image filename
    deck_nofire("E1 var token name allowed",
                '<div style="color:var(--c-gold);background:var(--c-navy-2)">x</div>', "E1")
    deck_nofire("E1 url filename allowed",
                '<div style="background:url(images/gold-bar.png) no-repeat">x</div>', "E1")
    deck_nofire("E1 data-fill attr allowed", '<svg><rect data-fill="red" fill="currentColor"/></svg>', "E1")
    # E6 must not flag legit prose that merely contains "generated by" / "自动生成"
    deck_nofire("E6 prose generated-by allowed", '<div>营收由 Q3 生成，revenue generated by growth</div>', "E6")
    deck_nofire("E6 prose auto-gen allowed", '<div>本页讲自动生成代码的工程实践</div>', "E6")

    # E10: scenario page whose visible text lacks the 示意/虚构 label
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {1: page("<h1>看似真实的数据页</h1>")},
                       {"title": "t", "slides": [slide(1)]})
        code, out = run("validate_deck.py", str(proj), "--single")
        expect("E10 scenario without label", code, out, "E10")
    # E10: an English deck may label in English (must NOT be forced to embed 示意)
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {1: page("<h1>Pilot metrics</h1><small>Illustrative — not real data</small>")},
                       {"title": "t", "language": "en", "slides": [slide(1)]})
        code, out = run("validate_deck.py", str(proj), "--single")
        expect("E10 english label allowed", 1 if "E10" in out else 0, out, "E10", want_fail=False)
    # E10: English scenario deck with NO label must still fail
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {1: page("<h1>Pilot metrics look real</h1>")},
                       {"title": "t", "language": "en", "slides": [slide(1)]})
        code, out = run("validate_deck.py", str(proj), "--single")
        expect("E10 english without label", code, out, "E10")

    # E5: page-number hole (page-1 + page-3 vs contiguous outline)
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {1: page("<h1>甲</h1>", layout="S03"),
                            3: page("<h1>乙</h1>", layout="S04")},
                       {"title": "t", "slides": [slide(1), slide(2, layout="S04")]})
        code, out = run("validate_deck.py", str(proj))
        expect("E5 page-number hole", code, out, "E5")

    # ── validate_outline
    outline_case("O5 buzzword same-field",
                 {"title": "t", "slides": [
                     slide(1, takeaway="全面提升研发效能，打造降本增效抓手",
                           content={"points": [{"h": "01", "p": "编号在别的字段"}]})]},
                 "O5")
    outline_case("O8 title over budget",
                 {"title": "t", "slides": [
                     slide(1, title="这是一个明显超过十八个全角字符预算的超长页标题啊")]},
                 "O8")
    outline_case("O8 S03 too many points",
                 {"title": "t", "slides": [
                     slide(1, content={"points": [{"h": f"点{i}", "p": "说明"}
                                                  for i in range(6)]})]},
                 "O8")
    outline_case("O6 breathing ratio",
                 {"title": "t", "slides":
                  [slide(i, layout="S03" if i % 2 else "S04") for i in range(1, 17)]},
                 "O6")
    # positive control: a compliant 2-page outline passes
    outline_case("outline positive control",
                 {"title": "t", "slides": [
                     slide(1, layout="S01", rhythm="anchor",
                           title="短标题", content={"kicker": "K", "subtitle": "副题"}),
                     slide(2, layout="S03")]},
                 "", want_fail=False)

    # ── build_deck: dangling image reference must fail the build
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {1: page('<img src="images/nope.png">')})
        code, out = run("build_deck.py", str(proj))
        expect("build missing image", code, out, "missing image")

    png_1x1 = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c626001000000ffff03000006000557bfabd4000000"
        "0049454e44ae426082")

    # build_deck must inline ./images/ and xlink:href spellings, not just src="images/"
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {1: page(
            '<img src="./images/a.png"><svg><image xlink:href="images/b.png"/></svg>')})
        img = proj / "images"; img.mkdir()
        (img / "a.png").write_bytes(png_1x1)
        (img / "b.png").write_bytes(png_1x1)
        code, out = run("build_deck.py", str(proj))
        deck = (proj / "deck.html").read_text(encoding="utf-8") if code == 0 else ""
        ok = code == 0 and deck.count("data:image/png;base64,") == 2 and "images/" not in deck
        expect("build inlines ./ and xlink:href", 0 if ok else 1, out if not ok else "",
               "", want_fail=False)

    # an unsupported spelling that leaves a live images/ ref must ERROR, not silently ship
    with tempfile.TemporaryDirectory() as td:
        proj = project(td, {1: page('<img data-src="/abs/path/images/x.png" src="images/x.png">')})
        img = proj / "images"; img.mkdir()
        (img / "x.png").write_bytes(png_1x1)
        code, out = run("build_deck.py", str(proj))
        expect("build residual images/ ref caught", code, out, "survived inlining")

    if not no_chrome:
        # probe: an oversized image must be caught AFTER the load event (H2)
        with tempfile.TemporaryDirectory() as td:
            proj = project(td, {1: page('<img src="images/tall.png">')})
            img = proj / "images"; img.mkdir()
            # tiny valid PNG scaled up via attributes is simpler than PIL: use
            # a 1x1 PNG + explicit width/height so layout overflows physically
            png_1x1 = bytes.fromhex(
                "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
                "890000000d49444154789c626001000000ffff03000006000557bfabd4000000"
                "0049454e44ae426082")
            (img / "tall.png").write_bytes(png_1x1)
            (proj / "pages" / "page-01.html").write_text(
                page('<img src="images/tall.png" width="200" height="1600">'),
                encoding="utf-8")
            code, out = run("build_deck.py", str(proj))
            if code != 0:
                expect("probe oversized image (build)", code, out, "", want_fail=False)
            else:
                code, out = run("probe_overflow.py", str(proj))
                expect("probe oversized image", code, out, "out-of-canvas")

    print(f"\ndeckcraft-selftest: {PASS} passed · {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
