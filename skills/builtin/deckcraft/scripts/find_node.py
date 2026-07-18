#!/usr/bin/env python3
"""Locate a Node.js runtime for the editable-pptx export (P2b), cross-platform.

Prefers the app's embedded Node (`~/.ultrawork/node/`, managed by the desktop
shell's Browser-MCP installer — see lib.rs `download_node`), which is the only
Node guaranteed modern enough. Falls back to a PATH `node` when it is recent
enough (some machines ship an ancient system Node — v14 on the author's box —
that cannot run the vendored bundle; those are rejected).

SYNC NOTE: the embedded location mirrors Rust `embedded_node_bin()`
(`~/.ultrawork/node/bin/node` on Unix, `~/.ultrawork/node/node.exe` on Windows).
The Settings badge (`node` dep) is computed by that same Rust probe, so
"badge green ⇒ this script finds Node" holds while both point at the same path.

Usage:  python3 find_node.py          # prints path, exit 0; exit 1 if none
Import: from find_node import find_node
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from console_encoding import configure_utf8_stdio

configure_utf8_stdio()

# Minimum acceptable major version for a PATH-fallback Node. The embedded Node
# (v22) is always accepted without a version gate; this only filters stale
# system installs that would choke on the vendored pptxgenjs bundle.
MIN_MAJOR = 18


def _embedded_node() -> Path:
    base = Path.home() / ".ultrawork" / "node"
    return base / "node.exe" if sys.platform.startswith("win") else base / "bin" / "node"


def _major(node: str) -> int | None:
    """Return the major version of `node`, or None if it won't run / is unparseable."""
    try:
        kwargs = {}
        if sys.platform.startswith("win"):
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW (ADR-054)
        out = subprocess.run([node, "--version"], capture_output=True, text=True,
                             timeout=10, **kwargs)
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"v(\d+)\.", (out.stdout or "").strip())
    return int(m.group(1)) if m else None


def find_node() -> str | None:
    """Path to a usable Node binary, or None. Embedded first (no version gate),
    then a sufficiently-recent PATH `node`."""
    emb = _embedded_node()
    if emb.is_file() and _major(str(emb)) is not None:
        return str(emb)
    path_node = shutil.which("node") or shutil.which("node.exe")
    if path_node:
        major = _major(path_node)
        if major is not None and major >= MIN_MAJOR:
            return path_node
    return None


if __name__ == "__main__":
    p = find_node()
    if p:
        print(p)
        sys.exit(0)
    print("no usable Node.js found — the editable-pptx export needs the app's "
          "embedded Node (Settings → Browser dependencies) or a PATH node "
          f">= v{MIN_MAJOR}", file=sys.stderr)
    sys.exit(1)
