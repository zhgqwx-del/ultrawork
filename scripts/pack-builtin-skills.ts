#!/usr/bin/env bun
/**
 * pack-builtin-skills.ts
 *
 * 把 git 里的内置技能松散树（skills/builtin/，1.2 万文件）打成单个构建期产物
 * skills-builtin.zip，供 Tauri bundle.resources 携带、Rust 首启/遮蔽 restore 解压
 * （见 lib.rs ensure_builtin_skills / reconcile_builtin_shadowing）。
 *
 * 产物目录（gitignore，仅 .gitkeep 入 git —— tauri::generate_context! 编译期要求
 * bundle.resources 源路径存在，CI 的 cargo test 不跑本脚本）：
 *   packages/client/desktop/src-tauri/resources/builtin-skills/
 *     ├── skills-builtin.zip   全部技能内容（不含 .builtin-version）
 *     └── .builtin-version     外置 sentinel = 内容 hash（find_builtin_source 锚点）
 *
 * 惰性：hash（与 fetch-builtin-skills.ts 同算法）没变且 zip 存在时直接跳过，
 * beforeDevCommand/beforeBuildCommand 每次调用都便宜。改技能 → hash 变 → 重打，
 * 且运行时 sentinel 跟着变 → 桌面端自动重装（zip 内刻意不含 sentinel，Rust 解压
 * 完成后才把外置 sentinel 写进树再 rename——保持「sentinel 可见即整树完整」不变式）。
 *
 * 跨平台：纯 fflate（无 zip/tar shell-out）；unix 可执行位经 zip 外部属性保留
 * （os=3 + mode<<16），Windows 上打的包给 Windows 用户装，无可执行位概念，自洽。
 */
import { zipSync, type Zippable } from "fflate"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BUILTIN_DIR = join(ROOT, "skills", "builtin")
const OUT_DIR = join(ROOT, "packages/client/desktop/src-tauri/resources/builtin-skills")
const ZIP_PATH = join(OUT_DIR, "skills-builtin.zip")
const SENTINEL_PATH = join(OUT_DIR, ".builtin-version")

if (!existsSync(join(BUILTIN_DIR, "README.md"))) {
  throw new Error(`skills/builtin 不存在或不完整: ${BUILTIN_DIR}（先跑 fetch-builtin-skills.ts）`)
}

// ── 内容 hash：与 fetch-builtin-skills.ts 的 sentinel 算法逐字节一致 ──
// （树未被手改时 == 提交在 git 的 skills/builtin/.builtin-version，便于对账）
const hash = createHash("sha256")
const files: string[] = [] // 相对路径，zip 统一 '/' 分隔
// 本地垃圾（Finder/资源管理器浏览产生）不进 hash 也不进 zip——否则会解压进用户 config 目录，
// 且本机 hash 偏离 git 提交的 sentinel。刻意与 fetch 脚本略有分歧（fetch 在干净 CI/审查后提交）。
const JUNK = new Set([".DS_Store", "Thumbs.db"])
const walk = (dir: string, rel: string) => {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".builtin-version" || JUNK.has(name)) continue
    const fp = join(dir, name)
    const st = lstatSync(fp)
    if (st.isSymbolicLink()) {
      // zip 侧不支持 symlink（Rust 解压也会拒绝）；技能树不应出现——fetch 脚本产物全是实体文件
      throw new Error(`skills/builtin 里发现 symlink，拒绝打包: ${fp}`)
    }
    if (name.includes(":") || name.includes("\\")) {
      // Rust extract_builtin_zip 对这类名字整体硬 Err（篡改即拒 + Windows 语义），
      // 漏进 zip 会让所有用户「零内置技能」。在打包期 fail-fast，把失败拉回构建面。
      throw new Error(`文件名含 ':' 或 '\\'，Rust 解压会整体拒绝，请改名: ${fp}`)
    }
    const relPath = rel ? `${rel}/${name}` : name
    if (st.isDirectory()) walk(fp, relPath)
    else {
      // 喂相对路径 + \0 分隔而非裸 basename：目录改名/同名跨目录移动也改变 hash
      // （裸 basename 对纯结构调整失明 → 可能发布陈旧 zip / 存量用户永不重装）。
      // 与 fetch-builtin-skills.ts 的 sentinel 算法保持逐字节一致（同步修改）。
      hash.update(relPath + "\0")
      hash.update(readFileSync(fp))
      hash.update("\0")
      files.push(relPath)
    }
  }
}
walk(BUILTIN_DIR, "")
const version = hash.digest("hex").slice(0, 16)

const fresh =
  existsSync(ZIP_PATH) &&
  existsSync(SENTINEL_PATH) &&
  readFileSync(SENTINEL_PATH, "utf8").trim() === version
if (fresh) {
  console.log(`[pack-builtin-skills] up to date (${version}), skip`)
  process.exit(0)
}

// ── 打 zip：保留 unix mode（可执行位），固定 mtime 保证可复现 ──
const t0 = Date.now()
const zippable: Zippable = {}
const MTIME = new Date("2000-01-01T00:00:00Z")
for (const rel of files) {
  const abs = join(BUILTIN_DIR, ...rel.split("/"))
  const mode = lstatSync(abs).mode & 0o777
  zippable[rel] = [readFileSync(abs), { mtime: MTIME, os: 3, attrs: (0o100000 | mode) << 16 }]
}
const zipped = zipSync(zippable, { level: 6, mtime: MTIME })
mkdirSync(OUT_DIR, { recursive: true })
// temp+rename 原子落位：tauri dev 的 beforeDevCommand 不等待（wait:false），孤儿 vite 占着
// devUrl 端口时 cargo build 可能与本脚本并发——绝不能让 tauri-build 拷走写了一半的 zip。
// tmp 名带 pid：并发的两个 pack（并行 e2e / dev+release 同跑）各写各的 tmp，rename 后到先赢，
// 共享固定 tmp 名会互相截断甚至写坏已 rename 上线的 zip（同一打开 fd 续写）。
const suffix = `.tmp-${process.pid}`
writeFileSync(ZIP_PATH + suffix, zipped)
renameSync(ZIP_PATH + suffix, ZIP_PATH)
writeFileSync(SENTINEL_PATH + suffix, version + "\n")
renameSync(SENTINEL_PATH + suffix, SENTINEL_PATH)
console.log(
  `[pack-builtin-skills] ${files.length} files -> ${(zipped.length / 1024 / 1024).toFixed(1)}MB zip in ${Date.now() - t0}ms (version ${version})`,
)
