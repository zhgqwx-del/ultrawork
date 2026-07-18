#!/usr/bin/env python3
"""deckcraft asset fetcher — real images from Wikimedia Commons + brand logos.

    python3 fetch_assets.py logo <name> [--out <dir>]
    python3 fetch_assets.py image <query> [--count N] [--out <dir>]

logo  — brand logo by slug (e.g. "github", "openai"). Chain, in success order:
        ① simpleicons CDN (SVG silhouette, color via CSS)
        ② Google favicon service (PNG 128px, almost never fails)
image — Wikimedia Commons search: downloads top N (default 3) candidates and
        writes license/author/source into <out>/assets-manifest.json — pages
        using a fetched image MUST show the credit when the license requires it.

Output dir defaults to <cwd>/images. Pure stdlib (urllib). Network required;
failures print a clear message and exit 1 — the caller falls back to the
honest-placeholder block (content-engineering.md), never a fake image.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

UA = "deckcraft/0.1 (+ultrawork desktop app; asset fetch for slide decks)"
WIKI_API = "https://commons.wikimedia.org/w/api.php"


def http_get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9-]", "", s.lower().replace(" ", "-"))


def manifest_add(out_dir: Path, entry: dict) -> None:
    mf = out_dir / "assets-manifest.json"
    items = []
    if mf.is_file():
        try:
            items = json.loads(mf.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            items = []
    items.append(entry)
    mf.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")


def fetch_logo(name: str, out_dir: Path) -> int:
    slug = slugify(name)
    # ① simpleicons CDN — single-color SVG, recolorable via fill
    try:
        data = http_get(f"https://cdn.simpleicons.org/{urllib.parse.quote(slug)}")
        if data.strip().startswith(b"<svg"):
            f = out_dir / f"logo-{slug}.svg"
            f.write_bytes(data)
            manifest_add(out_dir, {"file": f.name, "kind": "logo", "source": "simpleicons",
                                   "license": "brand mark — nominative use only"})
            print(f"OK: {f} (simpleicons SVG — recolor via fill/currentColor)")
            return 0
    except Exception as e:  # noqa: BLE001 — fall through the chain by design
        print(f"simpleicons miss ({e}); trying favicon…", file=sys.stderr)
    # ② Google favicon service
    try:
        domain = slug if "." in name else f"{slug}.com"
        data = http_get(f"https://www.google.com/s2/favicons?domain={domain}&sz=128")
        if len(data) > 100:
            f = out_dir / f"logo-{slug}.png"
            f.write_bytes(data)
            manifest_add(out_dir, {"file": f.name, "kind": "logo", "source": f"favicon:{domain}",
                                   "license": "brand mark — nominative use only"})
            print(f"OK: {f} (favicon 128px)")
            return 0
    except Exception as e:  # noqa: BLE001
        print(f"favicon miss ({e})", file=sys.stderr)
    print(f"ERROR: no logo found for {name!r} — use the honest placeholder block", file=sys.stderr)
    return 1


def fetch_images(query: str, count: int, out_dir: Path) -> int:
    params = urllib.parse.urlencode({
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": f"filetype:bitmap {query}", "gsrnamespace": 6, "gsrlimit": count * 2,
        "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": 1600,
    })
    try:
        data = json.loads(http_get(f"{WIKI_API}?{params}", timeout=30))
        pages = list((data.get("query") or {}).get("pages", {}).values())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: Wikimedia search failed ({e}) — use the honest placeholder block",
              file=sys.stderr)
        return 1
    got = 0
    for p in pages:
        if got >= count:
            break
        info = (p.get("imageinfo") or [{}])[0]
        url = info.get("thumburl") or info.get("url")
        if not url:
            continue
        meta = info.get("extmetadata") or {}
        lic = (meta.get("LicenseShortName") or {}).get("value", "unknown")
        artist = re.sub(r"<[^>]+>", "", (meta.get("Artist") or {}).get("value", "")).strip()
        try:
            img = http_get(url, timeout=60)
        except Exception:  # noqa: BLE001
            continue
        ext = Path(urllib.parse.urlparse(url).path).suffix or ".jpg"
        f = out_dir / f"wiki-{slugify(query)[:24]}-{got + 1}{ext}"
        f.write_bytes(img)
        manifest_add(out_dir, {"file": f.name, "kind": "photo", "source": info.get("descriptionurl") or url,
                               "license": lic, "author": artist})
        print(f"OK: {f} · {lic} · {artist or 'unknown author'}")
        got += 1
    if got == 0:
        print(f"ERROR: no usable images for {query!r} — use the honest placeholder block",
              file=sys.stderr)
        return 1
    print(f"fetched {got} image(s); credits in assets-manifest.json — show them when the license requires")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["logo", "image"])
    ap.add_argument("query")
    ap.add_argument("--count", type=int, default=3)
    ap.add_argument("--out", default="images")
    a = ap.parse_args()
    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    return fetch_logo(a.query, out_dir) if a.kind == "logo" else fetch_images(a.query, a.count, out_dir)


if __name__ == "__main__":
    sys.exit(main())
