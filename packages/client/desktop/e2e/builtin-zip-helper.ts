// builtin-zip-helper.ts — shared by the builtin-* e2e harnesses: install skills
// from the REAL bundled artifact (skills-builtin.zip, built by
// scripts/pack-builtin-skills.ts) the way the Rust installer does — full
// extraction for first-boot, prefix-selective extraction for the shadowing
// restore path — instead of cpSync-ing the loose git tree. This keeps the
// harness "first-boot" segments on the exact artifact the shipped app consumes.
import { unzipSync } from "fflate"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const DESKTOP = join(import.meta.dir, "..")
const REPO = join(DESKTOP, "../../..")
export const BUILTIN_ZIP = join(DESKTOP, "src-tauri/resources/builtin-skills/skills-builtin.zip")

/** 保证 zip 相对松散树新鲜（pack 脚本 hash 惰性：已新鲜时瞬时跳过）。 */
export function ensureBuiltinZip(): string {
  const r = Bun.spawnSync([process.execPath, "run", "--bun", join(REPO, "scripts/pack-builtin-skills.ts")], {
    cwd: REPO,
  })
  if (r.exitCode !== 0) {
    throw new Error(`pack-builtin-skills.ts failed: ${r.stderr.toString().slice(0, 400)}`)
  }
  if (!existsSync(BUILTIN_ZIP)) throw new Error(`missing ${BUILTIN_ZIP}`)
  return BUILTIN_ZIP
}

/**
 * 解压 zip 到 dest（等价 Rust extract_builtin_zip 的路径/前缀语义）。prefix
 * 给定时只解该技能子树且剥掉前缀（= 遮蔽 restore 的按前缀选择性解压语义）。
 * 已知分叉：不恢复 unix 可执行位（fflate unzipSync 不暴露 attrs；Rust 侧会恢复）——
 * harness 全部经 `python3 <path>` 调脚本、opencode 发现不看 mode，如需直接 `./script`
 * 断言请自行 chmod。返回写入文件数。
 */
export function extractBuiltinZip(dest: string, prefix?: string): number {
  const data = readFileSync(ensureBuiltinZip())
  const want = prefix ? `${prefix}/` : ""
  const files = unzipSync(new Uint8Array(data), {
    filter: (f) => (want ? f.name.startsWith(want) : true),
  })
  let n = 0
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith("/")) continue
    const rel = want ? name.slice(want.length) : name
    if (!rel) continue
    const out = join(dest, ...rel.split("/"))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, bytes)
    n++
  }
  if (n === 0) throw new Error(`no zip entries matched${prefix ? ` prefix '${prefix}'` : ""} in ${BUILTIN_ZIP}`)
  return n
}
