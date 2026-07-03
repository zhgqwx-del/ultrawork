#!/usr/bin/env bun
/**
 * 文档漂移机械校验（Discussion 010）。
 *
 * 只做"可机检的事实"，不判断语义：
 *   1. ADR 计数一致性：decisions/ 下 ADR 文件数 vs README 索引 vs AGENTS/document-map 里的计数
 *   2. 引用路径存在性：docs/ + 根 *.md 里反引号包裹的 packages//scripts//src//docs/ 路径是否真实存在
 *   3. MEMORY.md 行数 < 200（best-effort 定位 auto-memory，找不到则告警不失败）
 *   4. Markdown 相对链接 `[x](./y.md)` 目标存在性（活文档；跳过 http/锚点）
 *   5. document-map 分层计数：决策层/讨论层的 "N (README + M)" vs 实际文件数
 *   6. 章节号引用：`gotchas §N` / `conventions §N` 的 N 不超过对应文档实际最大章节号
 *   7. requirements.md 新鲜度（warning）：落后最新 ADR 超 45 天提示回填（git 时间，取不到则跳过）
 *
 * 用法：bun run --bun scripts/check-docs.ts
 * 退出码：0 = 通过；1 = 有硬性漂移（CI / pre-commit 可据此拦截；CI job 见 .github/workflows/ci.yml docs）。
 */
import { Glob } from "bun"
import path from "path"
import os from "os"

const rootDir = path.resolve(import.meta.dir, "..")
const errors: string[] = []
const warnings: string[] = []

// ── 1. ADR 计数一致性 ───────────────────────────────────────────────
const decisionsDir = path.join(rootDir, "docs/decisions")
const adrFiles: string[] = []
for await (const f of new Glob("*.md").scan({ cwd: decisionsDir })) {
  if (/^\d{3}-.*\.md$/.test(f)) adrFiles.push(f)
}
const adrCount = adrFiles.length

// README 索引表里的 ADR 行数（形如 "| [001](./001-...) |"）
const readmeText = await Bun.file(path.join(decisionsDir, "README.md")).text()
const readmeRows = (readmeText.match(/^\|\s*\[\d{3}\]\(/gm) ?? []).length
if (readmeRows !== adrCount) {
  errors.push(
    `ADR 计数不一致：decisions/ 实际 ${adrCount} 个 ADR 文件，但 README 索引表有 ${readmeRows} 行。`,
  )
}

// AGENTS.md / document-map.md 里写死的 "N ADR" 数字
for (const rel of ["AGENTS.md", "docs/document-map.md"]) {
  const text = await Bun.file(path.join(rootDir, rel)).text()
  const m = text.match(/(\d+)\s*(?:个\s*)?ADRs?/i)
  if (m && Number(m[1]) !== adrCount) {
    errors.push(`${rel} 写 "${m[0]}"，但实际有 ${adrCount} 个 ADR 文件 → 已漂移。`)
  }
}

// ── 2. 引用路径存在性 ───────────────────────────────────────────────
// 只查"活文档"（开发中常读、漂移会真伤人的）。刻意排除：
//   - docs/archive/**、CHANGELOG.md：历史/只追加记录，引用的是当时的状态
//   - docs/discussions/**、docs/decisions/**：调研/决策常引用上游或假设路径
// 跳过前缀：acp-branch 独有 + OpenCode submodule 内部路径
const SKIP_PREFIX = ["packages/agent/", "packages/opencode/"]
function resolveRef(p: string): string {
  if (p.startsWith("src/")) return path.join(rootDir, "packages/client/desktop", p)
  return path.join(rootDir, p)
}
const PATH_RE = /^(?:packages|scripts|src|docs)\/[\w./@-]+\.(ts|tsx|rs|json|md|css|js)$/

const mdFiles: string[] = [] // ADR 计数仍单独扫 decisions/，这里只列活文档
for await (const f of new Glob("docs/*.md").scan({ cwd: rootDir })) mdFiles.push(f)
for (const f of ["README.md", "AGENTS.md", "CLAUDE.md"]) mdFiles.push(f)

const missing = new Map<string, Set<string>>() // ref -> 出现的文档集合
for (const rel of mdFiles) {
  const text = await Bun.file(path.join(rootDir, rel)).text()
  for (const m of text.matchAll(/`([^`\s{}*,()]+)`/g)) {
    const ref = m[1]
    if (!PATH_RE.test(ref)) continue
    if (SKIP_PREFIX.some((p) => ref.startsWith(p))) continue
    if (!(await Bun.file(resolveRef(ref)).exists())) {
      if (!missing.has(ref)) missing.set(ref, new Set())
      missing.get(ref)!.add(rel)
    }
  }
}
for (const [ref, docs] of missing) {
  errors.push(`引用的文件不存在：\`${ref}\`（出现在 ${[...docs].join(", ")}）`)
}

// ── 2b. Markdown 相对链接目标存在性 ─────────────────────────────────
// 校验活文档里 [text](target) 的本地相对目标；跳过 http(s)/mailto/纯锚点/含空格与 <> 的伪链接。
for (const rel of mdFiles) {
  const text = await Bun.file(path.join(rootDir, rel)).text()
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s<>]+)\)/g)) {
    let target = m[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    target = target.split("#")[0]
    if (!target) continue
    const abs = path.resolve(rootDir, path.dirname(rel), decodeURIComponent(target))
    if (!abs.startsWith(rootDir)) continue // 仓库外引用不管
    const exists = (await Bun.file(abs).exists()) || (await isDir(abs))
    if (!exists) errors.push(`Markdown 链接目标不存在：\`${m[1]}\`（${rel}）`)
  }
}
async function isDir(p: string): Promise<boolean> {
  try {
    const { promises: fs } = await import("fs")
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

// ── 2c. document-map 分层计数（决策层 / 讨论层） ─────────────────────
{
  const mapText = await Bun.file(path.join(rootDir, "docs/document-map.md")).text()
  const layers: Array<[label: string, dir: string]> = [
    ["决策层", "docs/decisions"],
    ["讨论层", "docs/discussions"],
  ]
  for (const [label, dir] of layers) {
    const m = mapText.match(new RegExp(`\\*\\*${label}\\*\\*[^\\n]*?(\\d+)\\s*\\(README \\+ (\\d+)`))
    if (!m) continue
    const actual: string[] = []
    for await (const f of new Glob("*.md").scan({ cwd: path.join(rootDir, dir) })) actual.push(f)
    const total = actual.length
    if (Number(m[1]) !== total || Number(m[2]) !== total - 1) {
      errors.push(
        `document-map ${label}计数漂移：写 "${m[1]} (README + ${m[2]})"，实际 ${dir}/ 有 ${total} 个文件（README + ${total - 1}）。`,
      )
    }
  }
}

// ── 2d. 章节号引用（gotchas §N / conventions §N 不得超出实际章节） ───
{
  const maxSection = new Map<string, number>()
  for (const doc of ["gotchas", "conventions"]) {
    const text = await Bun.file(path.join(rootDir, `docs/${doc}.md`)).text()
    let max = 0
    for (const m of text.matchAll(/^## (\d+)[.、]/gm)) max = Math.max(max, Number(m[1]))
    if (max > 0) maxSection.set(doc, max)
  }
  // 附近归属：对每个 §N，向前看 30 字符内最近出现的文档名
  for (const rel of [...mdFiles, "CHANGELOG.md"]) {
    const text = await Bun.file(path.join(rootDir, rel)).text()
    for (const m of text.matchAll(/§\s?(\d+)/g)) {
      const ctx = text.slice(Math.max(0, m.index! - 30), m.index!).toLowerCase()
      const gi = ctx.lastIndexOf("gotchas")
      const ci = ctx.lastIndexOf("conventions")
      const doc = gi < 0 && ci < 0 ? null : gi > ci ? "gotchas" : "conventions"
      if (!doc || !maxSection.has(doc)) continue
      const n = Number(m[1])
      if (n > maxSection.get(doc)!) {
        errors.push(`${rel} 引用 ${doc} §${n}，但 docs/${doc}.md 实际最大章节是 §${maxSection.get(doc)}。`)
      }
    }
  }
}

// ── 2e. requirements.md 新鲜度（warning，不阻断） ────────────────────
{
  const gitTime = (p: string): number => {
    const r = Bun.spawnSync(["git", "log", "-1", "--format=%ct", "--", p], { cwd: rootDir })
    const t = Number(r.stdout.toString().trim())
    return Number.isFinite(t) && t > 0 ? t : 0
  }
  const reqT = gitTime("docs/requirements.md")
  const newestAdrT = Math.max(0, ...adrFiles.map((f) => gitTime(`docs/decisions/${f}`)))
  if (reqT > 0 && newestAdrT > 0) {
    const lagDays = Math.floor((newestAdrT - reqT) / 86400)
    if (lagDays > 45) {
      warnings.push(
        `requirements.md 已 ${lagDays} 天未随 ADR 更新（最新 ADR vs requirements 的 git 提交时间）→ 建议回填功能状态。`,
      )
    }
  } // git 不可用 / shallow clone 取不到时间 → 静默跳过
}

// ── 3. MEMORY.md 行数 < 200（best-effort） ─────────────────────────
const projectsDir = path.join(os.homedir(), ".claude/projects")
const repoSlug = rootDir.replace(/\//g, "-") // /Users/x/y → -Users-x-y
const memPath = path.join(projectsDir, repoSlug, "memory/MEMORY.md")
const memFile = Bun.file(memPath)
if (await memFile.exists()) {
  const lines = (await memFile.text()).split("\n").length
  if (lines >= 200) {
    errors.push(`MEMORY.md ${lines} 行 ≥ 200 上限 → 会被截断，需瘦身（detail 下沉到 git 文档或专题记忆）。`)
  }
} else {
  warnings.push(`未定位到 auto-memory MEMORY.md（${memPath}）；跳过行数检查。`)
}

// ── 报告 ────────────────────────────────────────────────────────────
console.log(`📄 check-docs：扫描 ${mdFiles.length} 个 md，${adrCount} 个 ADR`)
for (const w of warnings) console.log(`  ⚠️  ${w}`)
if (errors.length === 0) {
  console.log("✅ 未发现文档漂移。")
  process.exit(0)
}
console.log(`\n❌ 发现 ${errors.length} 处漂移：`)
for (const e of errors) console.log(`  • ${e}`)
process.exit(1)
