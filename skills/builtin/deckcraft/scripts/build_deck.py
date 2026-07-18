#!/usr/bin/env python3
"""Assemble a deckcraft project into a single self-contained deck.html.

    python3 build_deck.py <project_dir>

Project layout (created by the workflow):
    <project_dir>/outline.json      # IR (title used for <title>)
    <project_dir>/tokens.css        # :root token block derived from spec_lock.md
    <project_dir>/pages/page-NN.html# one <section class="slide"> fragment per page
Output:
    <project_dir>/deck.html
"""
from __future__ import annotations

import base64
import html
import json
import mimetypes
import re
import sys
from pathlib import Path

from console_encoding import configure_utf8_stdio

configure_utf8_stdio()

SKILL_DIR = Path(__file__).resolve().parent.parent

# deck.html must be truly single-file: derivatives (shots/probe/pptx) render
# split pages from a temp dir and --publish copies one file — any images/
# relative reference breaks in all of those, so local images get inlined here.
# Match src=/href=/xlink:href= and url(), with an optional ./ prefix.
_IMG_REF = re.compile(
    r'''((?:src|(?:xlink:)?href)\s*=\s*["']|url\(["']?)(?:\./)?(images/[^"')]+)''')
# any surviving local images/ reference after inlining (a spelling the regex
# above didn't catch) is a silent single-file breakage — caught as an error
_RESIDUAL_IMG = re.compile(r'''(?:src|href|url\(["']?)\s*=?\s*["']?[^"')]*?\bimages/''')


def inline_images(frag: str, proj: Path, errors: list[str]) -> str:
    cache: dict[str, str] = {}  # rel -> data URI: encode each file once, not per reference

    def repl(m: re.Match) -> str:
        prefix, rel = m.group(1), m.group(2)
        f = proj / rel
        if not f.is_file():
            errors.append(f"missing image file: {rel} (referenced but not in {proj}/images/)")
            return m.group(0)
        uri = cache.get(rel)
        if uri is None:
            mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            data = base64.b64encode(f.read_bytes()).decode("ascii")
            if len(data) > 2_500_000:  # ~1.9MB binary — likely an unresized original
                print(f"WARNING: {rel} inlines to {len(data)//1024}KB; consider downscaling",
                      file=sys.stderr)
            uri = cache[rel] = f"data:{mime};base64,{data}"
        return f"{prefix}{uri}"
    out = _IMG_REF.sub(repl, frag)
    # strip the inlined data: URIs before scanning — a base64 body could by
    # chance contain the literal "images/" and cause a false positive
    scan = re.sub(r"data:[^\"')]+", "", out)
    if _RESIDUAL_IMG.search(scan):
        errors.append("a local images/ reference survived inlining (unsupported "
                      "spelling e.g. absolute path) — deck.html would not be self-contained")
    return out


def page_no(p: Path) -> int | None:
    m = re.search(r"(\d+)", p.stem)
    return int(m.group(1)) if m else None


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    proj = Path(sys.argv[1])
    pages_dir = proj / "pages"
    tokens_f = proj / "tokens.css"
    outline_f = proj / "outline.json"
    shell_f = SKILL_DIR / "assets" / "templates" / "shell.html"

    for f, what in ((pages_dir, "pages/"), (tokens_f, "tokens.css"), (shell_f, "shell.html")):
        if not f.exists():
            print(f"ERROR: missing {what}: {f}", file=sys.stderr)
            return 1

    title = "deckcraft"
    if outline_f.exists():
        try:
            title = json.loads(outline_f.read_text(encoding="utf-8")).get("title", title)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            print(f"WARNING: outline.json unreadable ({e}); using default title", file=sys.stderr)

    # numeric sort — lexicographic order would silently put page-10 after
    # page-1 when the model skips zero-padding
    all_pages = list(pages_dir.glob("page-*.html"))
    unnumbered = [p.name for p in all_pages if page_no(p) is None]
    if unnumbered:
        print(f"ERROR: page files without a number (want page-NN.html): {unnumbered}",
              file=sys.stderr)
        return 1
    pages = sorted(all_pages, key=page_no)
    if not pages:
        print(f"ERROR: no page-*.html fragments in {pages_dir}", file=sys.stderr)
        return 1
    frags = []
    img_errors: list[str] = []
    for p in pages:
        t = p.read_text(encoding="utf-8").strip()
        if "<section" not in t:
            print(f"ERROR: {p.name} contains no <section> fragment", file=sys.stderr)
            return 1
        frags.append(inline_images(t, proj, img_errors))
    if img_errors:
        for e in img_errors:
            print(f"ERROR: {e}", file=sys.stderr)
        return 1

    shell = shell_f.read_text(encoding="utf-8")
    tokens = tokens_f.read_text(encoding="utf-8").strip()
    # Placeholder replacement without re.sub (fragment text may contain backslashes)
    doc = (
        shell.replace("{{TITLE}}", html.escape(title, quote=False))
        .replace("{{TOKENS}}", tokens)
        .replace("{{SLIDES}}", "\n".join(frags))
    )
    out = proj / "deck.html"
    out.write_text(doc, encoding="utf-8")
    print(f"OK: {out} ({len(pages)} pages, {len(doc)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
