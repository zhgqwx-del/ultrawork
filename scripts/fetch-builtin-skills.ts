#!/usr/bin/env bun
/**
 * fetch-builtin-skills.ts
 *
 * 下载内置技能源码到 `skills/builtin/<name>/`，应用 ultrawork 适配补丁，写 NOTICE/sentinel。
 * 结果**提交入库**（Tauri `bundle.resources` 从仓库打包它们），本脚本仅用于可复现与升级。
 *
 * 全部源技能均为 **Apache-2.0**（已逐个核对 LICENSE）。Anthropic 的 docx/pdf/pptx/xlsx 是
 * 专有许可、禁止再分发，**不在此列**（详见 docs/gotchas.md、ADR）。
 *
 * 用法：bun run --bun scripts/fetch-builtin-skills.ts
 * 依赖：`gh`（已认证）、`tar`。
 */
import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BUILTIN_DIR = join(ROOT, "skills", "builtin")

interface Source {
  /** 落地目录名（= 内置技能名） */
  dest: string
  repo: string
  ref: string
  /** 仓库内技能子目录 */
  subdir: string
  /** 取后删除的子路径（Codex 专属等无关文件） */
  drop?: string[]
  /** 若设置，只保留这些顶层文件/目录（优先于 drop） */
  keepOnly?: string[]
  notice: string
}

const SOURCES: Source[] = [
  {
    dest: "skill-creator",
    repo: "anthropics/skills",
    ref: "main",
    subdir: "skills/skill-creator",
    notice:
      "Derived from anthropics/skills `skills/skill-creator` (Apache-2.0). Claude-flavored skill authoring/eval helper. Unmodified except this NOTICE.",
  },
  {
    dest: "skill-installer",
    repo: "openai/skills",
    ref: "main",
    subdir: "skills/.system/skill-installer",
    drop: ["agents"],
    notice:
      "Derived from openai/skills `skills/.system/skill-installer` (Apache-2.0). Modified for ultrawork: install target repointed from $CODEX_HOME/skills to ~/.config/ultrawork/skills (see applyInstallerPatches in scripts/fetch-builtin-skills.ts); Codex `agents/` dropped.",
  },
  {
    dest: "pdf",
    repo: "openai/skills",
    ref: "main",
    subdir: "skills/.curated/pdf",
    drop: ["agents"],
    notice:
      "Derived from openai/skills `skills/.curated/pdf` (Apache-2.0). Read/create/review PDF via reportlab/pdfplumber/pypdf + Poppler. Codex `agents/` dropped.",
  },
  {
    // 上游 frontmatter name 即 "markdown-exporter"；按 pip 模式分发：只内置 SKILL.md（指导
    // `pip install md-exporter` + `markdown-exporter` CLI），不 vendor 整个 Python 包（用户安装
    // md-exporter 时其依赖会一并装上，与「检测+引导」策略一致）。
    dest: "markdown-exporter",
    repo: "bowenliang123/md_exporter",
    ref: "main",
    subdir: ".",
    keepOnly: ["SKILL.md", "LICENSE.txt"],
    notice:
      "Derived from bowenliang123/md_exporter (Apache-2.0). Markdown -> DOCX/PPTX/XLSX/PDF/etc. " +
      "Distributed as the PyPI package `md-exporter` (CLI `markdown-exporter`); only SKILL.md + LICENSE are " +
      "bundled — the tool itself is installed on demand via `pip install md-exporter` (see SKILL.md / dependency badges).",
  },
]

/** x-requires frontmatter 注入（人读文档用；与前端 BUILTIN_DEP_MAP 保持一致） */
const X_REQUIRES: Record<string, string[]> = {
  "skill-creator": ["python3"],
  "skill-installer": ["python3", "git"],
  pdf: ["python3", "pdftoppm"],
  "markdown-exporter": ["python3", "pandoc"],
}

async function fetchSubdir(src: Source, into: string) {
  const tmp = mkdtempSync(join(tmpdir(), "uw-skill-"))
  try {
    const tgz = join(tmp, "src.tgz")
    // gh api tarball -> gzip 二进制；--cache 0 避免陈旧
    await $`gh api repos/${src.repo}/tarball/${src.ref} > ${tgz}`.quiet()
    await $`tar xzf ${tgz} -C ${tmp}`.quiet()
    const top = readdirSync(tmp).find((n) => statSync(join(tmp, n)).isDirectory() && n !== "src.tgz")
    if (!top) throw new Error(`tarball 无顶层目录: ${src.repo}`)
    const from = src.subdir === "." ? join(tmp, top) : join(tmp, top, src.subdir)
    if (!existsSync(from)) throw new Error(`子目录不存在: ${src.repo}/${src.subdir}`)
    rmSync(into, { recursive: true, force: true })
    cpSync(from, into, { recursive: true })
    if (src.keepOnly) {
      const keep = new Set(src.keepOnly)
      for (const name of readdirSync(into)) {
        if (!keep.has(name)) rmSync(join(into, name), { recursive: true, force: true })
      }
    }
    for (const d of src.drop ?? []) rmSync(join(into, d), { recursive: true, force: true })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 把 skill-installer 的安装目标从 $CODEX_HOME 重定向到 ultrawork config 目录 */
function applyInstallerPatches(dir: string) {
  const CODEX_BODY = `    return os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))`
  const UW_BODY = [
    `    # ultrawork: 解析 config 目录（与 src-tauri global_config_dir 对齐）`,
    `    base = os.environ.get("ULTRAWORK_SKILLS_DIR")`,
    `    if base:`,
    `        return os.path.dirname(base.rstrip("/"))`,
    `    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")`,
    `    return os.path.join(xdg, "ultrawork")`,
  ].join("\n")

  for (const f of ["scripts/install-skill-from-github.py", "scripts/list-skills.py"]) {
    const p = join(dir, f)
    if (!existsSync(p)) continue
    let s = readFileSync(p, "utf8")
    s = s.replace(CODEX_BODY, UW_BODY)
    s = s.replace(/codex-skill-(install|list)/g, "ultrawork-skill-$1")
    s = s.replace(/\$CODEX_HOME\/skills/g, "~/.config/ultrawork/skills")
    s = s.replace(/~\/\.codex\/skills/g, "~/.config/ultrawork/skills")
    // list-skills: 不把内置目录 builtin 当作"已安装技能"
    s = s.replace(
      `        if os.path.isdir(path):\n            entries.add(name)`,
      `        if os.path.isdir(path) and name != "builtin":\n            entries.add(name)`,
    )
    writeFileSync(p, s)
  }

  // SKILL.md 文案去 Codex 化
  const skillMd = join(dir, "SKILL.md")
  if (existsSync(skillMd)) {
    let s = readFileSync(skillMd, "utf8")
    s = s
      .replace(/\$CODEX_HOME\/skills/g, "~/.config/ultrawork/skills")
      .replace(/~\/\.codex\/skills/g, "~/.config/ultrawork/skills")
      .replace(/Restart Codex to pick up new skills\./g, "Refresh the Skills page (settings) to pick up new skills.")
      .replace(/Codex skills/g, "skills")
      .replace(/into Codex/g, "into ultrawork")
    writeFileSync(skillMd, s)
  }
}

/** 给 SKILL.md frontmatter 注入 x-requires（若缺） */
function injectXRequires(dir: string, deps: string[]) {
  const p = join(dir, "SKILL.md")
  if (!existsSync(p) || !deps?.length) return
  let s = readFileSync(p, "utf8")
  const m = s.match(/^---\n([\s\S]*?)\n---/)
  if (!m || /^x-requires:/m.test(m[1])) return
  const block = `x-requires: [${deps.join(", ")}]`
  s = s.replace(/^---\n([\s\S]*?)\n---/, `---\n$1\n${block}\n---`)
  writeFileSync(p, s)
}

async function main() {
  console.log(`内置技能目录: ${BUILTIN_DIR}`)
  for (const src of SOURCES) {
    const into = join(BUILTIN_DIR, src.dest)
    process.stdout.write(`• ${src.dest} <- ${src.repo}/${src.subdir} ... `)
    await fetchSubdir(src, into)
    if (src.dest === "skill-installer") applyInstallerPatches(into)
    injectXRequires(into, X_REQUIRES[src.dest])
    writeFileSync(join(into, "NOTICE"), src.notice + "\n")
    console.log("ok")
  }

  // sentinel：基于全部内置内容（含自写 doc-edit）的哈希，内容变即触发桌面端刷新
  const hash = createHash("sha256")
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === ".builtin-version") continue
      const fp = join(d, name)
      const st = statSync(fp)
      if (st.isDirectory()) walk(fp)
      else {
        hash.update(name)
        hash.update(readFileSync(fp))
      }
    }
  }
  walk(BUILTIN_DIR)
  const version = hash.digest("hex").slice(0, 16)
  writeFileSync(join(BUILTIN_DIR, ".builtin-version"), version + "\n")
  console.log(`\n.builtin-version = ${version}`)
  console.log("完成。请 git add skills/builtin 并提交。")
}

await main()
