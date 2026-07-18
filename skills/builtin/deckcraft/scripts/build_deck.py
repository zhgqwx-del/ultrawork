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

import html
import json
import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent


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
    pages = sorted(pages_dir.glob("page-*.html"),
                   key=lambda p: int(re.search(r"(\d+)", p.stem).group(1)))
    if not pages:
        print(f"ERROR: no page-*.html fragments in {pages_dir}", file=sys.stderr)
        return 1
    frags = []
    for p in pages:
        t = p.read_text(encoding="utf-8").strip()
        if "<section" not in t:
            print(f"ERROR: {p.name} contains no <section> fragment", file=sys.stderr)
            return 1
        frags.append(t)

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
