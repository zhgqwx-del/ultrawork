#!/usr/bin/env bun
/**
 * fetch-builtin-skills.ts
 *
 * 下载内置技能源码到 `skills/builtin/<name>/`，应用 ultrawork 适配补丁，写 NOTICE/sentinel。
 * 结果**提交入库**（Tauri `bundle.resources` 从仓库打包它们），本脚本仅用于可复现与升级。
 *
 * 全部源技能均为可再分发许可（Apache-2.0 / MIT，已逐个核对 LICENSE）。Anthropic 的
 * docx/pdf/pptx/xlsx 是专有许可、禁止再分发，**不在此列**（详见 docs/gotchas.md、ADR）。
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
  /** 用 git sparse checkout 只拉 subdir（整仓 tarball 过大的仓库用，如 ppt-master 含 581M examples） */
  sparse?: boolean
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
  {
    // pin release tag（非 main）：上游约周更，bump 时改 ref 重跑本脚本即可（复核项见 discussions/025 §9）。
    // sparse 必开：整仓 tarball ≈ 700MB（examples/ 占 581M），sparse checkout 只拉 skill 子目录。
    dest: "ppt-master",
    repo: "hugohe3/ppt-master",
    ref: "v2.12.0",
    subdir: "skills/ppt-master",
    sparse: true,
    drop: ["references/ai-image-comparison"],
    notice:
      "Derived from hugohe3/ppt-master `skills/ppt-master` (MIT). AI-driven presentation generation: " +
      "source docs -> Strategist design spec -> per-page hand-written SVG -> editable PPTX export. " +
      "Trimmed for bundling: references/ai-image-comparison (43MB of AI-image-provider comparison PNGs, " +
      "documentation-only) is dropped. Requires python3 (>=3.10); per-feature pip deps in requirements.txt " +
      "(python-pptx needed for PPTX export). See docs/discussions/025-builtin-ppt-master-skill.md.",
  },
]

/** x-requires frontmatter 注入（人读文档用；与前端 BUILTIN_DEP_MAP 保持一致） */
const X_REQUIRES: Record<string, string[]> = {
  "skill-creator": ["python3"],
  "skill-installer": ["python3", "git"],
  pdf: ["python3", "pdftoppm"],
  "markdown-exporter": ["python3", "pandoc"],
  "ppt-master": ["python3.10+", "python-pptx"],
}

/** 把取到的源目录整理进落地目录（keepOnly/drop 共用逻辑）。 */
function placeInto(from: string, src: Source, into: string) {
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
}

async function fetchSubdir(src: Source, into: string) {
  const tmp = mkdtempSync(join(tmpdir(), "uw-skill-"))
  try {
    if (src.sparse) {
      // 大仓库：blobless sparse clone 只取 subdir。注意 --branch 只接受 tag/branch，
      // 不接受 commit SHA（tarball 路径可以）。
      if (src.subdir === ".") throw new Error(`sparse + subdir="." 会把 .git 拷进落地目录: ${src.dest}`)
      const repoDir = join(tmp, "repo")
      await $`git clone --depth 1 --filter=blob:none --sparse --branch ${src.ref} https://github.com/${src.repo}.git ${repoDir}`.quiet()
      // --cone 显式指定：老 git 默认非 cone 时根顶层文件（LICENSE）不会检出
      await $`git -C ${repoDir} sparse-checkout set --cone ${src.subdir}`.quiet()
      placeInto(join(repoDir, src.subdir), src, into)
      // 许可合规：子目录本身无 LICENSE 时从仓库根补拷（cone mode 顶层文件默认已检出）
      const hasLicense = readdirSync(into).some((n) => n.toLowerCase().startsWith("license"))
      if (!hasLicense) {
        const rootLicense = readdirSync(repoDir).find((n) => n.toLowerCase().startsWith("license"))
        if (!rootLicense) throw new Error(`无 LICENSE 可落地（子目录与仓库根均未找到）: ${src.repo}`)
        cpSync(join(repoDir, rootLicense), join(into, rootLicense))
      }
      return
    }
    const tgz = join(tmp, "src.tgz")
    // gh api tarball -> gzip 二进制；--cache 0 避免陈旧
    await $`gh api repos/${src.repo}/tarball/${src.ref} > ${tgz}`.quiet()
    await $`tar xzf ${tgz} -C ${tmp}`.quiet()
    const top = readdirSync(tmp).find((n) => statSync(join(tmp, n)).isDirectory() && n !== "src.tgz")
    if (!top) throw new Error(`tarball 无顶层目录: ${src.repo}`)
    placeInto(src.subdir === "." ? join(tmp, top) : join(tmp, top, src.subdir), src, into)
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

/** ppt-master 落地补丁：.env 存放引导 + 被裁目录的悬空引用清理 */
function applyPptMasterPatches(dir: string) {
  // ① builtin 目录会在 app 升级时被 sentinel 刷新整体重建（ADR-032）——用户把真实
  //    API key 放这里会被静默清掉。上游 image_gen.py 原生支持 ~/.ppt-master/.env
  //    （user-level）与 CWD ./.env，引导用户放那里。
  const envExample = join(dir, ".env.example")
  if (existsSync(envExample)) {
    const warn = [
      "# ⚠️ ultrawork 用户注意 / NOTE FOR ULTRAWORK USERS:",
      "# 本目录（skills/builtin/）会在 app 升级时被整体重建，放在这里的 .env 会被清掉。",
      "# 请把真实配置放到 `~/.ppt-master/.env`（用户级，upstream 原生支持）或工作区的 `./.env`。",
      "# This directory is rebuilt on app upgrades — a real .env placed here WILL be wiped.",
      "# Put your config in `~/.ppt-master/.env` (user-level) or the workspace `./.env` instead.",
      "#",
      "",
    ].join("\n")
    writeFileSync(envExample, warn + readFileSync(envExample, "utf8"))
  }
  // ② references/ai-image-comparison 已被 drop（43M 纯说明图）——清掉指向它的两处
  //    "see ... for matching PNGs" 指引，避免模型按图索骥吃 ENOENT。
  const strategist = join(dir, "references", "strategist.md")
  if (existsSync(strategist)) {
    const s = readFileSync(strategist, "utf8").replaceAll(
      "> Reference images: see references/ai-image-comparison/ for matching PNGs by name.",
      "> (Reference image gallery not bundled in ultrawork — rely on the textual descriptors above.)",
    )
    writeFileSync(strategist, s)
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
  // 可选按名过滤：`bun run scripts/fetch-builtin-skills.ts ppt-master` 只刷新指定技能，
  // 避免顺带把 pin 在 main 的其它技能拉到未审内容。缺省全量。sentinel 始终全目录重算。
  const only = process.argv.slice(2)
  const unknown = only.filter((n) => !SOURCES.some((s) => s.dest === n))
  if (unknown.length) throw new Error(`未知技能名: ${unknown.join(", ")}（可选: ${SOURCES.map((s) => s.dest).join(", ")}）`)
  const selected = only.length ? SOURCES.filter((s) => only.includes(s.dest)) : SOURCES
  for (const src of selected) {
    const into = join(BUILTIN_DIR, src.dest)
    process.stdout.write(`• ${src.dest} <- ${src.repo}/${src.subdir} ... `)
    await fetchSubdir(src, into)
    if (src.dest === "skill-installer") applyInstallerPatches(into)
    if (src.dest === "ppt-master") applyPptMasterPatches(into)
    injectXRequires(into, X_REQUIRES[src.dest])
    writeFileSync(join(into, "NOTICE"), src.notice + "\n")
    console.log("ok")
  }

  // sentinel：基于全部内置内容（含自写 doc-edit）的哈希，内容变即触发桌面端刷新。
  // 喂相对路径 + \0 分隔（非裸 basename）：目录改名/文件搬家也改变 hash。
  // ⚠️ 与 scripts/pack-builtin-skills.ts 的 hash 算法必须逐字节一致（对账不变式），改一处必须同步另一处。
  const hash = createHash("sha256")
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === ".builtin-version") continue
      const fp = join(d, name)
      const st = statSync(fp)
      const relPath = rel ? `${rel}/${name}` : name
      if (st.isDirectory()) walk(fp, relPath)
      else {
        hash.update(relPath + "\0")
        hash.update(readFileSync(fp))
        hash.update("\0")
      }
    }
  }
  walk(BUILTIN_DIR, "")
  const version = hash.digest("hex").slice(0, 16)
  writeFileSync(join(BUILTIN_DIR, ".builtin-version"), version + "\n")
  console.log(`\n.builtin-version = ${version}`)
  console.log("完成。请 git add skills/builtin 并提交。")
}

await main()
