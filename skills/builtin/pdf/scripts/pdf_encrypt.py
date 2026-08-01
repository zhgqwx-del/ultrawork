#!/usr/bin/env python3
"""P12 — set, change or remove a PDF password, and set the permission bits.

    # protect
    python3 pdf_encrypt.py --in report.pdf --out locked.pdf \
            --set-password s3cret --owner-password admin --allow print,copy

    # unlock (the password you already hold)
    python3 pdf_encrypt.py --in locked.pdf --out plain.pdf \
            --password s3cret --remove-password

Encryption is AES-256. `--allow` names what a reader may do; anything not named is
denied. The permission bits are advisory in the sense that a reader chooses to obey
them — this tool sets them, it does not pretend they are enforcement.

The result is re-opened and inspected before this reports success. That is not
ceremony: `save(encryption=...)` silently produces an unprotected file if the
arguments do not line up, and a file everyone believes is protected and is not is
the worst outcome this script can have.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import ensure_distinct, fail, open_pdf, run, write_json  # noqa: E402

PERMISSIONS = ("print", "modify", "copy", "annotate", "form", "accessibility",
               "assemble", "print_hq")
ALL_BITS = 0   # filled in at startup; fitz cannot be imported at module level here


def all_bits() -> int:
    import fitz

    total = 0
    for name in PERMISSIONS:
        total |= getattr(fitz, f"PDF_PERM_{name.upper()}")
    return total


def permission_bits(names: list[str]) -> int:
    import fitz

    bits = 0
    for name in names:
        key = name.strip().lower()
        if not key:
            continue
        if key not in PERMISSIONS:
            fail(f"unknown permission {name!r}; known: {', '.join(PERMISSIONS)}")
        bits |= getattr(fitz, f"PDF_PERM_{key.upper()}")
    return bits


def granted(bits: int) -> list[str]:
    import fitz

    return [n for n in PERMISSIONS if bits & getattr(fitz, f"PDF_PERM_{n.upper()}")]


def verify(out: Path, expect_encrypted: bool, password: str | None,
           requested: int | None) -> dict:
    """Re-open the result and report what it actually is.

    Authenticates as the USER, never the owner. An owner is by definition not
    restricted — opening with the owner password reports every permission granted
    and would confirm a restriction that is not there. Measured: the same file reads
    as PRINT+COPY for the user and as everything for the owner.
    """
    import fitz

    with fitz.open(out) as doc:
        locked = bool(doc.needs_pass)
        if expect_encrypted and not locked:
            fail(f"{out.name} was written without encryption even though a password "
                 f"was requested — do not ship this file believing it is protected")
        if not expect_encrypted and locked:
            fail(f"{out.name} still asks for a password after --remove-password")
        if locked and not doc.authenticate(password or ""):
            fail(f"{out.name} was encrypted but the password just written does "
                 f"not open it")
        meta = dict(doc.metadata or {})
        bits = int(doc.permissions)
        if requested is not None and (bits & ALL_BITS) != requested:
            fail(f"{out.name} grants {granted(bits)} but {granted(requested)} was "
                 f"requested — the permission bits did not land")
        return {"encrypted": locked, "algorithm": meta.get("encryption"),
                "pages": doc.page_count, "granted": granted(bits)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--password", default=None,
                    help="the CURRENT password, when the input is encrypted")
    ap.add_argument("--set-password", default=None, help="user password to write")
    ap.add_argument("--owner-password", default=None)
    ap.add_argument("--allow", default="print,accessibility",
                    help=f"comma-separated: {', '.join(PERMISSIONS)}")
    ap.add_argument("--remove-password", action="store_true")
    ap.add_argument("--report", type=Path, default=None)
    args = ap.parse_args()

    ensure_distinct(args.src, args.out)
    if args.remove_password and args.set_password:
        fail("--remove-password and --set-password ask for opposite things")
    if not args.remove_password and not args.set_password:
        fail("nothing to do: pass --set-password or --remove-password")

    import fitz

    global ALL_BITS
    ALL_BITS = all_bits()
    requested = None
    if args.set_password:
        requested = permission_bits(args.allow.split(","))
        owner = args.owner_password
        # An owner password equal to the user password makes the permission bits
        # decoration: everyone holding the password to open the file is the owner,
        # and owners are unrestricted. Refusing is the point — a file whose
        # restrictions quietly do not apply is worse than one with none.
        if requested != ALL_BITS and (owner is None or owner == args.set_password):
            fail(f"--allow grants only {granted(requested)}, but the owner password "
                 f"{'was not given' if owner is None else 'is the same as the user password'}"
                 f" — anyone who can open the file would then be the owner and get "
                 f"every permission anyway. Pass a different --owner-password, or "
                 f"--allow {','.join(PERMISSIONS)} to say the restriction is not wanted.")

    # Opening with the current password is what proves the caller may do this at
    # all; there is no path here that strips protection without it.
    doc = open_pdf(args.src, args.password)
    with doc:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        if args.remove_password:
            doc.save(str(args.out), encryption=fitz.PDF_ENCRYPT_NONE,
                     garbage=4, deflate=True, no_new_id=True)
            action = "removed"
        else:
            doc.save(str(args.out), encryption=fitz.PDF_ENCRYPT_AES_256,
                     user_pw=args.set_password,
                     owner_pw=args.owner_password or args.set_password,
                     permissions=permission_bits(args.allow.split(",")),
                     garbage=4, deflate=True, no_new_id=True)
            action = "set"

    state = verify(args.out, action == "set", args.set_password, requested)
    report = {"source": str(args.src), "out": str(args.out), "action": action,
              "allowed": [p for p in args.allow.split(",") if p.strip()]
              if action == "set" else None, **state}
    if args.report:
        write_json(args.report, report)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(run(main))
