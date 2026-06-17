#!/usr/bin/env bun
// Generate a many-file working directory (a git repo) to stress opencode bootstrap.
// Usage: bun gen-tree.ts <root> <fileCount> [filesPerDir]
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"

const root = process.argv[2] ?? "/tmp/uw-perf-huge"
const total = Number(process.argv[3] ?? 100_000)
const perDir = Number(process.argv[4] ?? 200)

if (existsSync(root)) rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const t0 = Date.now()
let made = 0
let dirIdx = 0
const dirCount = Math.ceil(total / perDir)
for (dirIdx = 0; dirIdx < dirCount; dirIdx++) {
  // two-level fanout so no single dir is huge: src/dNNN/
  const dir = join(root, "src", "d" + String(dirIdx).padStart(5, "0"))
  mkdirSync(dir, { recursive: true })
  for (let f = 0; f < perDir && made < total; f++, made++) {
    // small but non-empty content so ripgrep/stat have real work
    writeFileSync(join(dir, `file_${f}.ts`), `export const v${f} = ${made}\n`)
  }
}
// git init + commit so files are TRACKED (snapshot diff-files path) — and leave
// a few untracked too (snapshot ls-files --others path). Most stress is rg.files()
// in File.scan which lists tracked+untracked regardless.
execSync("git init -q", { cwd: root })
execSync("git config user.email e@e.e && git config user.name e", { cwd: root, shell: "/bin/bash" })
execSync("git add -A && git commit -q -m init", { cwd: root, shell: "/bin/bash", maxBuffer: 1 << 30 })
// add some untracked churn
for (let i = 0; i < 200; i++) writeFileSync(join(root, "src", "d00000", `untracked_${i}.ts`), "x\n")

console.log(`generated ${made} files in ${dirCount} dirs at ${root} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
