#!/usr/bin/env python3
"""Locate a headless-capable Chromium browser (Chrome / Edge / Chromium) cross-platform.

SYNC OBLIGATION: this candidate set MUST stay a superset of the Rust probe
(`detect_chrome` + `detect_export_browser` in desktop lib.rs) — the Settings
badge is computed by Rust, so "badge green ⇒ this script succeeds" only holds
while every Rust path also appears here. The reverse (this script finding a
PATH-installed browser the badge misses) is acceptable: worst case the badge
under-reports while the skill still works.

Usage:  python3 find_chrome.py          # prints path, exit 0; exit 1 if none
Import: from find_chrome import find_browser
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from console_encoding import configure_utf8_stdio

configure_utf8_stdio()


def _candidates() -> list[str]:
    if sys.platform == "darwin":
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    if sys.platform.startswith("win"):
        # ProgramW6432: 32-bit python on 64-bit Windows sees ProgramFiles = x86 dir,
        # which would hide 64-bit Chrome/Edge from us (Rust probe checks both roots).
        pf = os.environ.get("ProgramW6432") or os.environ.get("ProgramFiles", r"C:\Program Files")
        pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        cands: list[str] = []
        local = os.environ.get("LOCALAPPDATA", "")
        if local:
            cands.append(str(Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe"))
        cands.extend([
            str(Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe"),
            str(Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe"),
            str(Path(pf) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
            str(Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
            str(Path(pf) / "Chromium" / "Application" / "chrome.exe"),
        ])
        return cands
    # linux
    return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/opt/google/chrome/chrome",
        "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
        str(Path.home() / ".local/share/flatpak/exports/bin/org.chromium.Chromium"),
    ]


def find_browser() -> str | None:
    for c in _candidates():
        if Path(c).is_file():
            return c
    # PATH fallback (works on all three platforms)
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "msedge", "chrome"):
        p = shutil.which(name)
        if p:
            return p
    return None


if __name__ == "__main__":
    p = find_browser()
    if p:
        print(p)
        sys.exit(0)
    print("no Chromium-based browser found (install Google Chrome or Microsoft Edge)", file=sys.stderr)
    sys.exit(1)
