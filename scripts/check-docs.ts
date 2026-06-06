#!/usr/bin/env bun
/**
 * 文档漂移机械校验（Discussion 010）。
 *
 * 只做"可机检的事实"，不判断语义：
 *   1. ADR 计数一致性：decisions/ 下 ADR 文件数 vs README 索引 vs AGENTS/document-map 里的计数
 *   2. 引用路径存在性：docs/ + 根 *.md 里反引号包裹的 packages//scripts//src/ 路径是否真实存在
 *   3. MEMORY.md 行数 < 200（best-effort 定位 auto-memory，找不到则告警不失败）
 *
 * 用法：bun run --bun scripts/check-docs.ts
 * 退出码：0 = 通过；1 = 有硬性漂移（CI / pre-commit 可据此拦截）。
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
const PATH_RE = /^(?:packages|scripts|src)\/[\w./@-]+\.(ts|tsx|rs|json|md|css|js)$/

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
