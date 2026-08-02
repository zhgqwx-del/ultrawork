#!/usr/bin/env python3
"""Finding and driving LibreOffice.

LibreOffice is a REQUIRED dependency of this skill (discussions/059 §7): it is the
only route from .docx to a PDF the app can actually preview (the artifact panel
renders PDF and shows a binary info card for everything else), and the only thing
on the machine that will lay a document out — pagination, headers, footers, real
line breaking — rather than merely read its XML.

⚠️ Converting a .docx needs LibreOffice **Writer**, not just the shared core. A
host with only `libreoffice-calc` installed has a working `soffice` binary that
exits 0 on a .docx and writes no PDF, which is the exact failure mode the second
rule below exists for.

Two rules learned the hard way:

  * `-env:UserInstallation` is not optional. Without it soffice writes into the
    user's real profile, so running this skill mutates the machine — and two
    concurrent conversions fight over the same profile lock and one of them fails
    with an error that has nothing to do with the document.
  * A conversion that "succeeded" with no output file is a failure. soffice exits
    0 on inputs it silently declined, and treating exit 0 as proof produces an
    empty result reported as a win.
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
from pathlib import Path

DEFAULT_TIMEOUT = 180


def find_soffice() -> str | None:
    """LibreOffice, wherever this platform hides it.

    PATH first (a user-managed install wins), then the per-platform default
    locations — on macOS and Windows the installer does not put soffice on PATH at
    all, so a PATH-only probe reports "not installed" on a machine that has it.
    """
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    system = platform.system()
    if system == "Darwin":
        candidates = [Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
                      Path.home() / "Applications/LibreOffice.app/Contents/MacOS/soffice"]
    elif system == "Windows":
        candidates = [Path(p) / "LibreOffice" / "program" / "soffice.exe"
                      for p in (os.environ.get("ProgramFiles", ""),
                                os.environ.get("ProgramFiles(x86)", "")) if p]
    else:
        candidates = [Path("/usr/bin/soffice"), Path("/usr/bin/libreoffice"),
                      Path("/usr/lib/libreoffice/program/soffice"),
                      Path("/snap/bin/libreoffice")]
    return next((str(p) for p in candidates if p.is_file()), None)


def convert(src: Path, fmt: str, outdir: Path, timeout: int = DEFAULT_TIMEOUT,
            soffice: str | None = None) -> tuple[Path | None, str]:
    """Convert `src` to `fmt` inside `outdir`. Returns (path, error-message).

    `fmt` is a LibreOffice filter spec: "pdf", "html", or "txt:Text (encoded):UTF8"
    to pin the encoding of a text export.
    """
    exe = soffice or find_soffice()
    if not exe:
        return None, ("LibreOffice not found. This skill requires it — install from "
                      "libreoffice.org, or check that soffice is on PATH")
    outdir.mkdir(parents=True, exist_ok=True)
    profile = outdir / "lo-profile"
    cmd = [exe, f"-env:UserInstallation={profile.as_uri()}", "--headless",
           "--norestore", "--convert-to", fmt, "--outdir", str(outdir), str(src)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"LibreOffice did not finish converting {src.name} within {timeout}s"
    except OSError as e:
        return None, f"could not run LibreOffice at {exe}: {e}"
    out = outdir / (src.stem + "." + fmt.split(":")[0])
    if not out.is_file():
        detail = (r.stdout + r.stderr).strip().replace("\n", " ")[:300]
        return None, (f"LibreOffice exited {r.returncode} but produced no {fmt} for "
                      f"{src.name}" + (f": {detail}" if detail else ""))
    return out, ""
