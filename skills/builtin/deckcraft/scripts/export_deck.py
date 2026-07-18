#!/usr/bin/env python3
"""Export a built deck.html to PDF / per-page PNGs / image-type PPTX via headless Chrome/Edge.

    python3 export_deck.py <project_dir> [--pdf] [--shots] [--pptx] [--out <dir>]

  --pdf    write <out>/deck.pdf  (default action if no flag given)
  --shots  write <out>/shots/pNN.png per page (used by the visual-QA step)
  --pptx   write <out>/deck.pptx — image-type: each slide is a full-bleed
           screenshot (text NOT editable in PowerPoint; state this when
           delivering). Implies --shots. Needs the python-pptx pip library.
  --out    output dir, default <project_dir>/export
  --publish <dir>  copy the final deliverables (deck.html + produced pdf/pptx)
           into <dir> named <project-name>.html/.pdf/.pptx — the workspace-visible
           delivery step. The project dir itself should be a dot-directory
           (.deckcraft/<name>) so intermediates stay out of the artifacts panel.

Requires deck.html built by build_deck.py. Stdlib + a Chromium browser
(located by find_chrome.py); python-pptx only for --pptx. Cross-platform:
no shell, no hardcoded /tmp.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from find_chrome import find_browser

CHROME_BASE = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check"]
TIMEOUT_S = 120


def run_chrome(browser: str, args: list[str]) -> None:
    kwargs = {}
    if sys.platform.startswith("win"):
        # GUI-subsystem parents must not flash console windows (app convention, ADR-054)
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    subprocess.run([browser, *CHROME_BASE, *args], check=True, timeout=TIMEOUT_S,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)


def split_pages(deck_html: str) -> tuple[str, list[str]]:
    """Return (head_html, [section_html...]) — head is everything before the first slide.

    HTML comments are stripped first so documentation comments can never
    contribute phantom sections or corrupt the head slice. Sections are matched
    on the bare <section tag (not an exact attribute order) — validate_deck
    guarantees one non-nested <section per page, so any attribute layout the
    model produced splits correctly.
    """
    deck_html = re.sub(r"<!--.*?-->", "", deck_html, flags=re.S)
    sections = re.findall(r"<section\b.*?</section>", deck_html, re.S)
    head = re.split(r"<section\b", deck_html, 1)[0]
    # head still contains the opening <div class="stage">; close it per single page
    return head, sections


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir")
    ap.add_argument("--pdf", action="store_true")
    ap.add_argument("--shots", action="store_true")
    ap.add_argument("--pptx", action="store_true")
    ap.add_argument("--out", default=None)
    ap.add_argument("--publish", default=None)
    a = ap.parse_args()
    if a.pptx:
        a.shots = True  # pptx is assembled from the per-page screenshots

    proj = Path(a.project_dir)
    deck = proj / "deck.html"
    if not deck.is_file():
        print(f"ERROR: {deck} not found — run build_deck.py first", file=sys.stderr)
        return 1
    browser = find_browser()
    if not browser:
        print("ERROR: no Chrome/Edge/Chromium found. Install Google Chrome or Microsoft Edge.", file=sys.stderr)
        return 1

    out_dir = Path(a.out) if a.out else proj / "export"
    out_dir.mkdir(parents=True, exist_ok=True)
    # explicit --pdf, or no action flag at all → default to PDF
    do_pdf = a.pdf or not a.shots

    if a.pptx:  # fail fast BEFORE spending ~1s/page on screenshots
        try:
            import pptx  # noqa: F401
        except ImportError:
            print("ERROR: --pptx needs the python-pptx library (pip install python-pptx)",
                  file=sys.stderr)
            return 1

    if do_pdf:
        pdf = out_dir / "deck.pdf"
        run_chrome(browser, [f"--print-to-pdf={pdf}", "--no-pdf-header-footer", deck.resolve().as_uri()])
        print(f"OK: {pdf}")

    if a.shots:
        shots = out_dir / "shots"
        shots.mkdir(exist_ok=True)
        html = deck.read_text(encoding="utf-8")
        head, sections = split_pages(html)
        if not sections:
            print("ERROR: no slides found in deck.html", file=sys.stderr)
            return 1
        # flatten margins via a style override (attribute-order independent) so
        # each page renders at exactly 1280x720
        flat = "<style>.stage{margin:0}.slide{margin:0}</style>"
        # 2x device pixels for the pptx path — projector/zoom sharpness
        scale = ["--force-device-scale-factor=2"] if a.pptx else []
        with tempfile.TemporaryDirectory() as td:
            for i, sec in enumerate(sections, 1):
                page = Path(td) / f"p{i:02d}.html"
                page.write_text(head + flat + sec + "</div></body></html>", encoding="utf-8")
                run_chrome(browser, ["--window-size=1280,720", *scale,
                                     f"--screenshot={shots / f'p{i:02d}.png'}", page.resolve().as_uri()])
        print(f"OK: {shots} ({len(sections)} pages)")

    if a.pptx:
        pptx_out = build_image_pptx(out_dir / "shots", out_dir / "deck.pptx",
                                    speaker_notes(proj))
        print(f"OK: {pptx_out} (image-type — text not editable in PowerPoint)")

    if a.publish:
        import shutil
        dest = Path(a.publish)
        dest.mkdir(parents=True, exist_ok=True)
        # visible name = project dir name, minus a leading dot if present
        name = proj.resolve().name.lstrip(".") or "deck"
        published = []
        for src, ext in ((deck, ".html"), (out_dir / "deck.pdf", ".pdf"), (out_dir / "deck.pptx", ".pptx")):
            if src.is_file():
                target = dest / f"{name}{ext}"
                shutil.copyfile(src, target)
                published.append(str(target))
        for t in published:
            print(f"PUBLISHED: {t}")
    return 0


def speaker_notes(proj: Path) -> dict[int, str]:
    """Per-page speaker notes from outline.json (empty dict when absent)."""
    outline_f = proj / "outline.json"
    if not outline_f.is_file():
        return {}
    try:
        data = json.loads(outline_f.read_text(encoding="utf-8"))
        return {s["index"]: str(s.get("speaker_notes") or "")
                for s in data.get("slides", []) if "index" in s}
    except (json.JSONDecodeError, TypeError, KeyError):
        return {}


def build_image_pptx(shots_dir: Path, out_path: Path, notes: dict[int, str]) -> Path:
    """Assemble a 16:9 image-type .pptx: one full-bleed screenshot per slide,
    speaker notes attached — presenter view stays fully usable even though
    the slide surface itself is an image."""
    from pptx import Presentation
    from pptx.util import Inches

    shots = sorted(shots_dir.glob("p*.png"))
    if not shots:
        raise SystemExit(f"ERROR: no screenshots in {shots_dir}")
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]  # blank layout — no placeholders
    for i, shot in enumerate(shots, 1):
        slide = prs.slides.add_slide(blank)
        slide.shapes.add_picture(str(shot), 0, 0,
                                 width=prs.slide_width, height=prs.slide_height)
        note = notes.get(i, "")
        if note:
            slide.notes_slide.notes_text_frame.text = note
    prs.save(str(out_path))
    return out_path


if __name__ == "__main__":
    sys.exit(main())
