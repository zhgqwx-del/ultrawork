#!/usr/bin/env bun
/**
 * 文档漂移机械校验（Discussion 010）。
 *
 * 只做"可机检的事实"，不判断语义：
 *   1. ADR 计数一致性：decisions/ 下 ADR 文件数 vs README 索引 vs AGENTS/document-map 里的计数
 *   2. 引用路径存在性：docs/ + 根 *.md 里反引号包裹的 packages//scripts//src//docs/ 路径是否真实存在
 *   3. MEMORY.md 行数 < 200（best-effort 定位 auto-memory，找不到则告警不失败）
 *   4. Markdown 相对链接 `[x](./y.md)` 目标存在性（活文档；跳过 http/锚点/围栏代码块内示例）
 *   5. document-map 分层计数：功能/决策/讨论/归档层的数字 vs 实际文件数（锚点格式变化时告警而非静默失效）
 *   6. 章节号引用：`gotchas §N` / `conventions §N` 的 N 不超过对应文档实际最大章节号
 *      （不扫 CHANGELOG——只追加的历史记录，未来章节重编号不应让不可改的历史条目炸门禁）
 *   7. requirements.md 新鲜度（warning）：落后 decisions/ 最新提交超 45 天提示回填（git 时间，取不到则跳过）
 *   8. 版本一致性：root/desktop package.json、tauri.conf.json、Cargo.toml、app-version.ts 五处版本号相同
 *   9. 繁体中文生成产物新鲜度：i18n-zh-hant.generated.ts == gen-zh-hant.ts 从 zh-Hans 复算结果（ADR-058 D3）
 *
 * 用法：bun run --bun scripts/check-docs.ts
 * 退出码：0 = 通过；1 = 有硬性漂移（CI / pre-commit 可据此拦截；CI job 见 .github/workflows/ci.yml docs）。
 */
import { Glob } from "bun"
import path from "path"
import os from "os"
import { promises as fs } from "fs"

const rootDir = path.resolve(import.meta.dir, "..")
const errors: string[] = []
const warnings: string[] = []

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** 去掉围栏代码块（``` / ~~~），供链接/章节号检查用——围栏里的是示例，不是真引用。 */
function stripFences(text: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      continue
    }
    if (m) {
      fence = m[1]
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

// ── 0. 活文档一次性读入（各检查共享，勿在检查块里重复读盘） ──────────
const mdFiles: string[] = []
for await (const f of new Glob("docs/*.md").scan({ cwd: rootDir })) mdFiles.push(f)
for (const f of ["README.md", "AGENTS.md", "CLAUDE.md"]) mdFiles.push(f)
const mdTexts = new Map<string, string>()
for (const rel of mdFiles) mdTexts.set(rel, await Bun.file(path.join(rootDir, rel)).text())

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
  const text = mdTexts.get(rel) ?? (await Bun.file(path.join(rootDir, rel)).text())
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

const missing = new Map<string, Set<string>>() // ref -> 出现的文档集合
for (const [rel, text] of mdTexts) {
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
// 校验活文档里 [text](target) 的本地相对目标；跳过 http(s)/mailto/纯锚点/含空格与 <> 的伪链接、
// 围栏代码块内的示例链接。目标里 `#锚点`/`?query` 剥掉；`%` 解码失败按原文处理（不崩）。
for (const [rel, rawText] of mdTexts) {
  const text = stripFences(rawText)
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s<>]+)\)/g)) {
    let target = m[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    target = target.split("#")[0].split("?")[0]
    if (!target) continue
    let decoded = target
    try {
      decoded = decodeURIComponent(target)
    } catch {
      /* 含裸 %，按原文检查 */
    }
    const abs = path.resolve(rootDir, path.dirname(rel), decoded)
    if (!(abs === rootDir || abs.startsWith(rootDir + path.sep))) continue // 仓库外引用不管
    const exists = (await Bun.file(abs).exists()) || (await isDir(abs))
    if (!exists) errors.push(`Markdown 链接目标不存在：\`${m[1]}\`（${rel}）`)
  }
}

// ── 2c. document-map 分层计数（功能 / 决策 / 讨论 / 归档层） ─────────
{
  const mapText = mdTexts.get("docs/document-map.md")!
  // 注意：决策/讨论层比对的是目录下**全部** *.md（含 README 与非编号文件），
  // 与检查 1 的 adrFiles（仅 ^\d{3}- 编号文件）语义不同，勿合并。
  // 计数口径 = git 追踪文件（gitignored 的本地私密文档如 discussions/002 不
  // 计入——否则本机与 CI checkout 计数不一致，CI docs job 必挂；2026-07-07
  // 实证）。git 不可用时回退 fs 扫描（行为同旧版）。
  const globCount = async (pattern: string, cwd: string) => {
    const rel = path.relative(rootDir, cwd).replaceAll(path.sep, "/")
    try {
      const proc = Bun.spawnSync(["git", "ls-files", `:(glob)${rel}/${pattern}`], { cwd: rootDir })
      if (proc.success) {
        const n = proc.stdout.toString().split("\n").filter(Boolean).length
        if (n > 0) return n
      }
    } catch {
      // fall through to fs scan
    }
    let n = 0
    for await (const _ of new Glob(pattern).scan({ cwd })) n++
    return n
  }
  for (const [label, dir] of [
    ["决策层", "docs/decisions"],
    ["讨论层", "docs/discussions"],
  ] as const) {
    const m = mapText.match(new RegExp(`\\*\\*${label}\\*\\*[^\\n]*?(\\d+)\\s*\\(README \\+ (\\d+)`))
    if (!m) {
      warnings.push(`document-map ${label}行未匹配 "N (README + M)" 格式 → 计数检查未生效，请恢复格式或更新 check-docs。`)
      continue
    }
    const total = await globCount("*.md", path.join(rootDir, dir))
    if (Number(m[1]) !== total || Number(m[2]) !== total - 1) {
      errors.push(
        `document-map ${label}计数漂移：写 "${m[1]} (README + ${m[2]})"，实际 ${dir}/ 有 ${total} 个文件（README + ${total - 1}）。`,
      )
    }
  }
  // 功能层 = docs/*.md 顶层；归档层 = docs/archive/** 全部文件（含子目录）
  const funcM = mapText.match(/\*\*功能层\*\*[^\n]*?`docs\/\*\.md`\s*\|\s*(\d+)/)
  if (!funcM) warnings.push(`document-map 功能层行未匹配预期格式 → 计数检查未生效。`)
  else {
    const actual = await globCount("*.md", path.join(rootDir, "docs"))
    if (Number(funcM[1]) !== actual)
      errors.push(`document-map 功能层计数漂移：写 ${funcM[1]}，实际 docs/*.md 有 ${actual} 个。`)
  }
  const archM = mapText.match(/\*\*归档层\*\*[^\n]*?\|\s*(\d+)/)
  if (!archM) warnings.push(`document-map 归档层行未匹配预期格式 → 计数检查未生效。`)
  else {
    const actual = await globCount("**/*", path.join(rootDir, "docs/archive"))
    if (Number(archM[1]) !== actual)
      errors.push(`document-map 归档层计数漂移：写 ${archM[1]}，实际 docs/archive/ 有 ${actual} 个文件。`)
  }
}

// ── 2d. 章节号引用（gotchas §N / conventions §N 不得超出实际章节） ───
// 不扫 CHANGELOG（只追加历史，未来重编号不应让历史条目炸门禁）。
{
  const maxSection = new Map<string, number>()
  for (const doc of ["gotchas", "conventions"]) {
    let max = 0
    for (const m of mdTexts.get(`docs/${doc}.md`)!.matchAll(/^## (\d+)[.、]/gm)) max = Math.max(max, Number(m[1]))
    if (max > 0) maxSection.set(doc, max)
    else warnings.push(`docs/${doc}.md 未识别出 "## N." 章节标题 → §N 引用检查未生效。`)
  }
  // 归属：对每个 §N 向前看 30 字符，取**最近的文档指称**（gotchas/conventions/ADR/discussions/其它 docs 名）；
  // 只有最近指称是 gotchas/conventions 时才检查——避免「gotchas §12 见 ADR-030 §14」把 §14 误归给 gotchas。
  const DOC_TOKEN = /(gotchas|conventions|adr[-\s]?\d|discussions?\/?\d*|quality-gates|architecture|testing|build-and-deploy|api-reference|document-map|requirements)/gi
  for (const [rel, rawText] of mdTexts) {
    const text = stripFences(rawText)
    for (const m of text.matchAll(/§\s?(\d+)/g)) {
      const ctx = text.slice(Math.max(0, m.index! - 30), m.index!)
      let last: string | null = null
      for (const t of ctx.matchAll(DOC_TOKEN)) last = t[1].toLowerCase()
      const doc = last === "gotchas" || last === "conventions" ? last : null
      if (!doc || !maxSection.has(doc)) continue
      const n = Number(m[1])
      if (n > maxSection.get(doc)!) {
        errors.push(`${rel} 引用 ${doc} §${n}，但 docs/${doc}.md 实际最大章节是 §${maxSection.get(doc)}。`)
      }
    }
  }
}

// ── 2e. requirements.md 新鲜度（warning，不阻断；git 取不到则跳过） ──
{
  const gitTime = (p: string): number => {
    try {
      const r = Bun.spawnSync(["git", "log", "-1", "--format=%ct", "--", p], { cwd: rootDir })
      const t = Number(r.stdout.toString().trim())
      return Number.isFinite(t) && t > 0 ? t : 0
    } catch {
      return 0 // git 不在 PATH / 非 git 环境
    }
  }
  const reqT = gitTime("docs/requirements.md")
  const newestAdrT = gitTime("docs/decisions") // 目录级一条命令，勿逐 ADR spawn
  if (reqT > 0 && newestAdrT > 0) {
    const lagDays = Math.floor((newestAdrT - reqT) / 86400)
    if (lagDays > 45) {
      warnings.push(
        `requirements.md 已 ${lagDays} 天未随 ADR 更新（decisions/ 最新提交 vs requirements 的 git 提交时间）→ 建议回填功能状态。`,
      )
    }
  }
}

// ── 2f. 版本一致性（root/desktop package.json、tauri.conf、Cargo.toml、app-version.ts） ──
{
  const read = async (rel: string) => await Bun.file(path.join(rootDir, rel)).text()
  const versions = new Map<string, string>()
  for (const rel of ["package.json", "packages/client/desktop/package.json", "packages/client/desktop/src-tauri/tauri.conf.json"]) {
    const m = (await read(rel)).match(/"version"\s*:\s*"([^"]+)"/)
    if (m) versions.set(rel, m[1])
  }
  const cargo = (await read("packages/client/desktop/src-tauri/Cargo.toml")).match(/^version\s*=\s*"([^"]+)"/m)
  if (cargo) versions.set("Cargo.toml", cargo[1])
  const appVer = (await read("packages/client/desktop/src/lib/app-version.ts").catch(() => "")).match(/APP_VERSION\s*=\s*"([^"]+)"/)
  if (appVer) versions.set("app-version.ts", appVer[1])
  const uniq = new Set(versions.values())
  if (uniq.size > 1) {
    errors.push(
      `版本号不一致：${[...versions.entries()].map(([f, v]) => `${f}=${v}`).join("，")} → 发布版本需五处同步。`,
    )
  }
}

// ── 3. MEMORY.md 行数 < 200（best-effort） ─────────────────────────
const projectsDir = path.join(os.homedir(), ".claude/projects")
const repoSlug = rootDir.replace(/[\\/]/g, "-") // /Users/x/y → -Users-x-y（win 反斜杠同样折叠）
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

// ── 9. 繁体中文生成产物漂移（ADR-058 D3）────────────────────────────
// zh-Hant 词典由 scripts/gen-zh-hant.ts 从 zh-Hans 源构建期生成。若有人改了
// 简体源却忘了重新生成，committed 产物会 stale——用 --check 复算比对兜底。
// 生成器依赖 devDep opencc-js；本 job（CI docs）刻意不 `bun install`，所以
// opencc 不可解析时**跳过并告警**（不误判为漂移）。真正的 CI 强制在装了依赖的
// node job 里显式跑 `gen-zh-hant.ts --check`（三平台），本地 wrap-up 亦有依赖。
{
  const gen = path.join(rootDir, "scripts/gen-zh-hant.ts")
  const opencc = path.join(rootDir, "node_modules/opencc-js/package.json")
  if (!(await Bun.file(gen).exists())) {
    // generator absent → nothing to guard
  } else if (!(await Bun.file(opencc).exists())) {
    warnings.push("opencc-js 未安装（依赖未装环境）→ 跳过 zh-Hant 生成产物漂移检查（CI node job 会强制）。")
  } else {
    // Use the running bun binary (process.execPath), not a bare "bun" that
    // assumes PATH — check-docs may itself be launched via an absolute bun path.
    const proc = Bun.spawnSync([process.execPath, "run", "--bun", gen, "--check"], { cwd: rootDir })
    if (!proc.success) {
      const tail = (proc.stderr?.toString() || proc.stdout?.toString() || "").trim().split("\n").pop()
      errors.push(
        "i18n-zh-hant.generated.ts 与 zh-Hans 源漂移（改了简体词典未重新生成繁体）→ " +
          "运行 `bun run --bun scripts/gen-zh-hant.ts` 并提交。" +
          (tail ? ` (${tail})` : ""),
      )
    }
  }
}

// ── 10. 内置技能 SKILL.md 指向的技能内文件必须真的随包发布 ──────────
// 技能树是**发布产物**：SKILL.md 会跟着 zip 装到用户机器上，而仓库里的 scripts/
// 不会。指向一个不随包走的文件，用户（和 agent）按指引去找必然扑空——这正是
// discussions/059 §1 记的 `doc-export` 断链缺陷，2026-08-01 在 pdf 技能上又犯了一次
// （SKILL.md 让人跑仓库里的 scripts/test-pdf-skill.py）。
//
// 只校验**看起来像技能内相对路径**的引用（scripts/ fixtures/ references/ assets/
// examples/ agents/ eval-viewer/）。豁免见 RUNTIME_MATERIALIZED：连接器在运行时
// 落地的目录本来就不在发布树里。
{
  const SKILL_DIR_PREFIXES = ["scripts", "fixtures", "references", "assets", "examples", "agents", "eval-viewer"]
  // 运行时才落地的路径（设置 → 连接器 → 办公 CLI 安装官方技能包），不是断链。
  const RUNTIME_MATERIALIZED = new Set(["dingtalk-assistant:references/products/"])
  const builtinRoot = path.join(rootDir, "skills/builtin")
  const refRe = new RegExp(
    String.raw`(?<![\w/.-])((?:${SKILL_DIR_PREFIXES.join("|")})/[A-Za-z0-9_.*/-]+)`,
    "g",
  )
  if (await isDir(builtinRoot)) {
    for (const name of (await fs.readdir(builtinRoot, { withFileTypes: true })).filter((d) => d.isDirectory())) {
      const md = path.join(builtinRoot, name.name, "SKILL.md")
      if (!(await Bun.file(md).exists())) continue
      const text = await Bun.file(md).text()
      const seen = new Set<string>()
      for (const m of text.matchAll(refRe)) {
        const ref = m[1].replace(/[.,;:)）】]+$/, "")
        if (ref.includes("*") || seen.has(ref)) continue
        seen.add(ref)
        if (RUNTIME_MATERIALIZED.has(`${name.name}:${ref}`) || RUNTIME_MATERIALIZED.has(`${name.name}:${ref}/`)) continue
        const target = path.join(builtinRoot, name.name, ref)
        if (!(await Bun.file(target).exists()) && !(await isDir(target))) {
          errors.push(
            `skills/builtin/${name.name}/SKILL.md 指向 \`${ref}\`，但它不在该技能的发布树里 → ` +
              `用户装完照着做会扑空；改成不随包发布的说明，或把文件放进技能目录。`,
          )
        }
      }
    }
  }
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
