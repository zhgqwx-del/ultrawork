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
ceremony: an encryption call whose arguments do not line up can produce an
unprotected file, and a file everyone believes is protected and is not is the worst
outcome this script can have.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdfcommon import ensure_distinct, fail, open_reader, run, write_json  # noqa: E402

# Name -> the pypdf flag for the same bit of the standard security handler.
PERMISSIONS = {"print": "PRINT", "modify": "MODIFY", "copy": "EXTRACT",
               "annotate": "ADD_OR_MODIFY", "form": "FILL_FORM_FIELDS",
               "accessibility": "EXTRACT_TEXT_AND_GRAPHICS",
               "assemble": "ASSEMBLE_DOC", "print_hq": "PRINT_TO_REPRESENTATION"}


def _perm():
    from pypdf.constants import UserAccessPermissions
    return UserAccessPermissions


def all_bits() -> int:
    P = _perm()
    total = 0
    for flag in PERMISSIONS.values():
        total |= int(getattr(P, flag))
    return total


def permission_bits(names: list[str]) -> int:
    P = _perm()
    bits = 0
    for name in names:
        key = name.strip().lower()
        if not key:
            continue
        if key not in PERMISSIONS:
            fail(f"unknown permission {name!r}; known: {', '.join(PERMISSIONS)}")
        bits |= int(getattr(P, PERMISSIONS[key]))
    return bits


def granted(bits: int) -> list[str]:
    P = _perm()
    return [n for n, flag in PERMISSIONS.items() if bits & int(getattr(P, flag))]


def verify(out: Path, expect_encrypted: bool, password: str | None,
           requested: int | None) -> dict:
    """Re-open the result and report what it actually is.

    Authenticates as the USER. ⚠️ Note what this does and does not prove with this
    library: pypdf reports the STORED /P bits whichever password opened the file
    (measured — user and owner both read 20 for print+copy), whereas the PyMuPDF
    build this replaces applied owner semantics and reported every permission for an
    owner. So this check confirms the bits landed in the file; it does NOT
    demonstrate that an owner is unrestricted.

    That property is still real, and it is why the owner-password trap in main()
    refuses BEFORE writing rather than trying to detect the problem afterwards: a
    reader honouring /P grants the owner everything regardless of what is stored.
    """
    from pypdf import PdfReader

    reader = PdfReader(str(out))
    locked = bool(reader.is_encrypted)
    if expect_encrypted and not locked:
        fail(f"{out.name} was written without encryption even though a password "
             f"was requested — do not ship this file believing it is protected")
    if not expect_encrypted and locked:
        fail(f"{out.name} still asks for a password after --remove-password")
    if locked and not reader.decrypt(password or ""):
        fail(f"{out.name} was encrypted but the password just written does not open it")
    bits = int(reader.user_access_permissions or 0) if locked else all_bits()
    if requested is not None and (bits & all_bits()) != requested:
        fail(f"{out.name} grants {granted(bits)} but {granted(requested)} was "
             f"requested — the permission bits did not land")
    enc = getattr(reader, "_encryption", None)
    algorithm = None
    if enc is not None:
        algorithm = {(5, 6): "AES-256", (5, 5): "AES-256 (revision 5)",
                     (4, 4): "AES-128"}.get((getattr(enc, "V", None),
                                             getattr(enc, "R", None)))
    return {"encrypted": locked, "algorithm": algorithm,
            "pages": len(reader.pages), "granted": granted(bits)}


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

    from pypdf import PdfWriter

    requested = None
    if args.set_password:
        requested = permission_bits(args.allow.split(","))
        owner = args.owner_password
        # An owner password equal to the user password makes the permission bits
        # decoration: everyone holding the password to open the file is the owner,
        # and owners are unrestricted. Refusing is the point — a file whose
        # restrictions quietly do not apply is worse than one with none.
        if requested != all_bits() and (owner is None or owner == args.set_password):
            fail(f"--allow grants only {granted(requested)}, but the owner password "
                 f"{'was not given' if owner is None else 'is the same as the user password'}"
                 f" — anyone who can open the file would then be the owner and get "
                 f"every permission anyway. Pass a different --owner-password, or "
                 f"--allow {','.join(PERMISSIONS)} to say the restriction is not wanted.")

    # Opening with the current password is what proves the caller may do this at
    # all; there is no path here that strips protection without it.
    reader = open_reader(args.src, args.password)
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    if reader.metadata:
        writer.add_metadata(reader.metadata)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.remove_password:
        action = "removed"
    else:
        writer.encrypt(user_password=args.set_password,
                       owner_password=args.owner_password or args.set_password,
                       permissions_flag=_perm()(requested),
                       algorithm="AES-256")
        action = "set"
    with args.out.open("wb") as fh:
        writer.write(fh)

    state = verify(args.out, action == "set", args.set_password, requested)
    report = {"source": str(args.src), "out": str(args.out), "action": action,
              "allowed": [p for p in args.allow.split(",") if p.strip()]
              if action == "set" else None, **state}
    if args.report:
        write_json(args.report, report)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(run(main))
