#!/usr/bin/env python3
"""L3 真实语料回归（discussions/059 §5 L3）的语料获取器。

设计约束（用户 2026-08-04 拍板）：**清单进 git，字节不进 git。**

- `scripts/l3-corpus-manifest.json` 记录 repo + 钉死的 commit + 相对路径 + sha256 + 许可。
- 字节落到缓存目录（默认 `~/.cache/ultrawork/l3-corpus/`，`ULTRAWORK_L3_CORPUS` 可覆盖），
  永不入 git。理由：① 用户手上真实的中文办公文档多半是业务文件，机制必须**从第一天**
  就支持「本地语料，永不入 git」—— 这棵树会被构建、签名、分发出去，而 git 历史是永久的；
  ② 第三方 PDF 的单件出处不因仓库 LICENSE 是 MIT 就自动干净，不进源码树 = 这个问题不存在；
  ③ 20MB 与构建无关的二进制测试数据不该进版本库。
  ⚠️ 记一笔：我最初写的第一条理由是「本仓库是 public」，写的时候**实测是 private**
  （2026-08-04 用户随后把它改成了 public）。所以这条理由**现在成立、当时不成立** ——
  决定从头到尾不变，因为它站在上面那三条上，不站在可见性上。
- 代价是网络依赖 ⇒ 语料缺失时 `test-office-l3-corpus.py` 打印大字 SKIP + 缺哪几个 sha，
  CI 传 `--require-corpus` 把 SKIP 变红（「沉默与通过长得一样」）。

用法：
    python3 scripts/fetch-l3-corpus.py                 # 按清单取（默认，可重入）
    python3 scripts/fetch-l3-corpus.py --verify-only   # 只离线校验缓存，不联网
    python3 scripts/fetch-l3-corpus.py --rebuild-manifest [--pin <ref>]

本地私有语料（用户丢过来的真实文档）不进清单，直接放：
    <缓存根>/local/{docx,xlsx,pdf}/
门禁会单列统计并在结果里标明「这一部分没进 CI」。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# S6 血泪：脚本要打中文，Windows 在 stdout 被捕获时按 ANSI 代码页编码 ⇒ 第一个中文字
# 就 UnicodeEncodeError 退出 1，而 agent 总是捕获 stdout。抄 docxcommon.py 顶部。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass

REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST = REPO_ROOT / "scripts" / "l3-corpus-manifest.json"

# ---------------------------------------------------------------------------
# 源定义。许可是**读 LICENSE 正文核过的**，不是靠 gotchas §10 的字节数捷径
# （XlsxWriter 的 LICENSE.txt 1349B，离「1467B ≈ Anthropic 专有」很近，只看大小会误判）。
# ---------------------------------------------------------------------------
SOURCES: list[dict] = [
    {
        "id": "python-docx",
        "repo": "python-openxml/python-docx",
        "license": "MIT",
        "license_path": "LICENSE",
        "paths": ["tests/test_files", "features/steps/test_files"],
        "kind": "docx",
        "include": r"\.docx$",
        "why": "python-docx 自己的测试夹具，绝大多数由 Word 保存 —— 正是 059 §5「D4/D5 从未跑过"
               "真正由 Word 保存的文档」点名的空白",
    },
    {
        "id": "calamine",
        "repo": "tafia/calamine",
        "license": "MIT",
        "license_path": "LICENSE-MIT.md",
        "paths": ["tests"],
        "kind": "xlsx",
        "include": r"\.xlsx$",
        "why": "用户报 bug 时贴上来的野生 xlsx，边界最脏",
    },
    {
        "id": "xlsxwriter",
        "repo": "jmcnamara/XlsxWriter",
        "license": "BSD-2-Clause",
        "license_path": "LICENSE.txt",
        "paths": ["xlsxwriter/test/comparison/xlsx_files"],
        "kind": "xlsx",
        "include": r"\.xlsx$",
        # 1000 份太多，跑不进 CI ⇒ 取确定性子集：按文件名排序后按 stride 抽。
        # 规则写在这里、结果逐条钉在清单里，不是随机也不会漂。
        "stride": 25,
        "why": "Excel 亲手存的对照件（不是 XlsxWriter 产的），补「真正由 Excel 保存的文档」这一格",
    },
    {
        "id": "pdfplumber",
        "repo": "jsvine/pdfplumber",
        "license": "MIT",
        "license_path": "LICENSE.txt",
        "paths": ["tests/pdfs"],
        "kind": "pdf",
        "include": r"\.pdf$",
        "why": "真实世界抓来的 PDF（政府报告 / 扫描件 / 表格），手编夹具产不出这种版面",
    },
]

# 明确**不收**的源，连同理由 —— 写下来免得下次又去查一遍。
REJECTED = [
    ("py-pdf/sample-files", "CC-BY-SA-4.0",
     "share-alike，与「签名分发的商业软件」这个前提不该沾"),
    ("py-pdf/pypdf resources/", "仓库 NOASSERTION，目录内无 LICENSE",
     "单件出处不明，逐个核不动"),
    ("openpyxl", "MIT 但不在 GitHub（heptapod）",
     "sdist 186KB 不含测试数据；calamine + XlsxWriter 已超量覆盖 xlsx"),
]

KINDS = ("docx", "xlsx", "pdf")


def corpus_root() -> Path:
    env = os.environ.get("ULTRAWORK_L3_CORPUS")
    if env:
        return Path(env).expanduser()
    # Windows 上 Path.home() 是 C:\Users\<x>，建 .cache 子目录一样成立；不硬编码分隔符。
    return Path.home() / ".cache" / "ultrawork" / "l3-corpus"


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(cmd: list[str], cwd: Path | None = None) -> None:
    r = subprocess.run(cmd, cwd=str(cwd) if cwd else None,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.returncode != 0:
        raise SystemExit(f"命令失败（rc={r.returncode}）：{' '.join(cmd)}\n{r.stdout}")


def sparse_fetch(src: dict, ref: str, dest: Path) -> None:
    """blobless sparse checkout 到指定 commit。

    抄 fetch-builtin-skills.ts:103-110，但那边用 `--branch`，只吃 tag/branch；
    这里要钉到任意 sha ⇒ init + fetch --depth 1 <sha> + checkout FETCH_HEAD。
    """
    dest.mkdir(parents=True, exist_ok=True)
    # `url` 只有门禁的控制臂会传（指向一个本地仓库），好让「Windows 换行」那条
    # 回归控制**不联网**也能复现 git 的真实行为。生产路径永远走 GitHub。
    url = src.get("url") or f"https://github.com/{src['repo']}.git"
    run(["git", "init", "-q"], cwd=dest)
    run(["git", "remote", "add", "origin", url], cwd=dest)
    run(["git", "config", "core.sparseCheckout", "true"], cwd=dest)
    # ⚠️ Windows 的 git 默认 core.autocrlf=true，检出文本文件时把 LF 换成 CRLF ——
    # 于是 LICENSE 的 sha256 与在 macOS 上建清单时记的值对不上，脚本报「许可变了」。
    # 这是新门禁上 CI 第一跑就被抓到的、只在 Windows 上犯的错（059 §六·补九）。
    # 修法不是把比较放宽（那会把「许可真的改了」一起藏掉），是让检出**逐字节等于上游**。
    # 顺带也保住语料本身：.docx/.xlsx/.pdf 虽然会被 git 判为二进制而不动，
    # 但那是启发式判断，不是保证。
    run(["git", "config", "core.autocrlf", "false"], cwd=dest)
    run(["git", "config", "core.eol", "lf"], cwd=dest)
    run(["git", "sparse-checkout", "init", "--cone"], cwd=dest)
    # 顶层 LICENSE 也要检出 —— cone 模式下顶层文件默认就在。
    run(["git", "sparse-checkout", "set", "--cone", *src["paths"]], cwd=dest)
    run(["git", "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", ref], cwd=dest)
    run(["git", "checkout", "-q", "FETCH_HEAD"], cwd=dest)


def select_files(src: dict, tree: Path) -> list[Path]:
    pat = re.compile(src["include"])
    out: list[Path] = []
    for rel in src["paths"]:
        base = tree / rel
        if not base.is_dir():
            raise SystemExit(f"{src['id']}: 路径不存在 {rel} —— 上游改结构了，清单要重建")
        for p in sorted(base.rglob("*")):
            if p.is_file() and pat.search(p.name):
                out.append(p)
    stride = src.get("stride")
    if stride:
        out = out[::stride]
    if not out:
        raise SystemExit(f"{src['id']}: 一个文件都没选中 —— 空遍历长得和通过一样，直接判红")
    return out


# gotchas §10 红线：Anthropic 四件套的专有许可绝不能进任何语料链路。
# 判定不靠字节数（那只是捷径），靠特征条款。
FORBIDDEN_LICENSE_PHRASES = (
    "may not extract",
    "no derivative",
    "not create derivative works",
    "Anthropic PBC. All rights reserved",
)


def check_license_text(src: dict, tree: Path) -> str:
    lp = tree / src["license_path"]
    if not lp.is_file():
        raise SystemExit(f"{src['id']}: 找不到 {src['license_path']} —— 不核许可就不收")
    text = lp.read_text(encoding="utf-8", errors="replace")
    low = text.lower()
    for phrase in FORBIDDEN_LICENSE_PHRASES:
        if phrase.lower() in low:
            raise SystemExit(
                f"{src['id']}: LICENSE 命中专有特征条款 {phrase!r} —— gotchas §10 红线，拒绝")
    spdx = src["license"]
    expect = {
        "MIT": "mit license",
        "BSD-2-Clause": "bsd 2-clause",
        "Apache-2.0": "apache license",
    }[spdx]
    if expect not in low:
        raise SystemExit(
            f"{src['id']}: 声明 {spdx} 但 LICENSE 正文里找不到 {expect!r} —— 声明与正文不符")
    return hashlib.sha256(lp.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------


def rebuild(pin: str | None) -> int:
    entries: list[dict] = []
    srcmeta: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="l3-corpus-build-",
                                     ignore_cleanup_errors=True) as td:
        # ignore_cleanup_errors：临时目录里是 git 克隆，而 .git/objects 下的文件是
        # **只读**的 —— Windows 上 shutil.rmtree 会 PermissionError，把一次成功的
        # 取语料变成一个只在 Windows 上出现的失败。这是本仓库反复付学费的形状。

        for src in SOURCES:
            ref = pin or subprocess.run(
                ["gh", "api", f"/repos/{src['repo']}/commits/HEAD", "--jq", ".sha"],
                stdout=subprocess.PIPE, text=True, check=True).stdout.strip()
            tree = Path(td) / src["id"]
            print(f"[{src['id']}] fetch {src['repo']}@{ref[:12]} …")
            sparse_fetch(src, ref, tree)
            lic_sha = check_license_text(src, tree)
            files = select_files(src, tree)
            for p in files:
                entries.append({
                    "source": src["id"],
                    "kind": src["kind"],
                    "path": p.relative_to(tree).as_posix(),
                    "bytes": p.stat().st_size,
                    "sha256": sha256_of(p),
                })
            srcmeta.append({
                "id": src["id"], "repo": src["repo"], "commit": ref,
                "license": src["license"], "license_path": src["license_path"],
                "license_sha256": lic_sha, "paths": src["paths"],
                "include": src["include"], "stride": src.get("stride"),
                "kind": src["kind"], "why": src["why"],
            })
            print(f"[{src['id']}] 选中 {len(files)} 份，"
                  f"{sum(p.stat().st_size for p in files) / 1e6:.1f} MB")

    doc = {
        "_": "L3 真实语料清单（discussions/059 §5）。字节不入 git，见 scripts/fetch-l3-corpus.py 顶部。",
        "rejected": [{"source": r[0], "license": r[1], "why": r[2]} for r in REJECTED],
        "sources": srcmeta,
        "files": sorted(entries, key=lambda e: (e["source"], e["path"])),
    }
    MANIFEST.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    by_kind: dict[str, int] = {}
    for e in entries:
        by_kind[e["kind"]] = by_kind.get(e["kind"], 0) + 1
    print(f"\n写入 {MANIFEST.relative_to(REPO_ROOT)}：{len(entries)} 份 "
          f"({', '.join(f'{k}={v}' for k, v in sorted(by_kind.items()))})")
    return 0


def load_manifest() -> dict:
    if not MANIFEST.is_file():
        raise SystemExit(f"清单不存在：{MANIFEST} —— 先跑 --rebuild-manifest")
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def verify_cache(doc: dict, root: Path, quiet: bool = False) -> tuple[int, list[str]]:
    """返回 (对上的份数, 问题列表)。不联网。"""
    problems: list[str] = []
    ok = 0
    for e in doc["files"]:
        p = root / "public" / e["source"] / e["path"]
        if not p.is_file():
            problems.append(f"缺失 {e['source']}/{e['path']}")
            continue
        got = sha256_of(p)
        if got != e["sha256"]:
            problems.append(f"sha256 不符 {e['source']}/{e['path']}: {got[:12]} != {e['sha256'][:12]}")
            continue
        ok += 1
    if not quiet:
        print(f"缓存校验：{ok}/{len(doc['files'])} 对上，{len(problems)} 个问题")
        for p in problems[:20]:
            print("  -", p)
        if len(problems) > 20:
            print(f"  … 另有 {len(problems) - 20} 条")
    return ok, problems


def fetch(doc: dict, root: Path) -> int:
    by_source: dict[str, list[dict]] = {}
    for e in doc["files"]:
        by_source.setdefault(e["source"], []).append(e)

    with tempfile.TemporaryDirectory(prefix="l3-corpus-fetch-",
                                     ignore_cleanup_errors=True) as td:
        # ignore_cleanup_errors：临时目录里是 git 克隆，而 .git/objects 下的文件是
        # **只读**的 —— Windows 上 shutil.rmtree 会 PermissionError，把一次成功的
        # 取语料变成一个只在 Windows 上出现的失败。这是本仓库反复付学费的形状。

        for src in doc["sources"]:
            want = by_source.get(src["id"], [])
            dest = root / "public" / src["id"]
            # 已经全对上就跳过这个源的网络往返（可重入）。
            if dest.is_dir() and all(
                    (dest / e["path"]).is_file() and sha256_of(dest / e["path"]) == e["sha256"]
                    for e in want):
                print(f"[{src['id']}] 缓存已是最新，跳过（{len(want)} 份）")
                continue
            print(f"[{src['id']}] fetch {src['repo']}@{src['commit'][:12]} …")
            tree = Path(td) / src["id"]
            spec = {**src, "paths": src["paths"], "license_path": src["license_path"]}
            sparse_fetch(spec, src["commit"], tree)
            lic_sha = check_license_text(spec, tree)
            if lic_sha != src["license_sha256"]:
                raise SystemExit(
                    f"{src['id']}: LICENSE 内容与清单记录不符 —— 许可变了，必须人工复核后重建清单")
            if dest.exists():
                shutil.rmtree(dest)
            for e in want:
                s = tree / e["path"]
                if not s.is_file():
                    raise SystemExit(f"{src['id']}: 清单里的 {e['path']} 在该 commit 上不存在")
                got = sha256_of(s)
                if got != e["sha256"]:
                    raise SystemExit(
                        f"{src['id']}/{e['path']}: sha256 与清单不符（{got[:12]} != {e['sha256'][:12]}）")
                d = dest / e["path"]
                d.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(s, d)
            shutil.copy2(tree / src["license_path"], dest / Path(src["license_path"]).name)
            (dest / "PROVENANCE.txt").write_text(
                f"repo: https://github.com/{src['repo']}\n"
                f"commit: {src['commit']}\n"
                f"license: {src['license']} ({src['license_path']})\n"
                f"取用理由: {src['why']}\n"
                f"⚠️ 这些字节不入 git，见 scripts/fetch-l3-corpus.py 顶部说明。\n",
                encoding="utf-8")
            print(f"[{src['id']}] 落地 {len(want)} 份 → {dest}")

    for k in KINDS:
        (root / "local" / k).mkdir(parents=True, exist_ok=True)
    (root / "local" / "README.txt").write_text(
        "本地私有语料放这里（<kind>/ 下），不进清单、不入 git、不进 CI。\n"
        "门禁 test-office-l3-corpus.py 会单列统计并标明「这一部分没进 CI」。\n",
        encoding="utf-8")
    ok, problems = verify_cache(doc, root)
    return 0 if not problems else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rebuild-manifest", action="store_true",
                    help="重新解析上游、重算 sha256、覆写清单（会联网）")
    ap.add_argument("--pin", help="配合 --rebuild-manifest：钉到指定 ref（默认取上游 HEAD）")
    ap.add_argument("--verify-only", action="store_true", help="只离线校验缓存")
    ap.add_argument("--print-root", action="store_true", help="打印缓存根目录后退出")
    a = ap.parse_args()

    root = corpus_root()
    if a.print_root:
        print(root)
        return 0
    if a.rebuild_manifest:
        return rebuild(a.pin)
    doc = load_manifest()
    print(f"缓存根：{root}")
    if a.verify_only:
        _, problems = verify_cache(doc, root)
        return 0 if not problems else 1
    root.mkdir(parents=True, exist_ok=True)
    return fetch(doc, root)


if __name__ == "__main__":
    sys.exit(main())
