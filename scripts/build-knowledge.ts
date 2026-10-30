#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"
import { verifySidecarFreshness, writeSidecarMetadata } from "./sidecar-metadata"
import { computeSourceHash, saveHash, workspaceDepDirs } from "./build-hash"

const rootDir = path.resolve(import.meta.dir, "..")
const knowledgeDir = path.join(rootDir, "packages/knowledge/sidecar")
const tauriDir = path.join(rootDir, "packages/client/desktop/src-tauri")
const tauriBinDir = path.join(tauriDir, "binaries")

// Map Tauri target triple → bun --target value
const BUN_TARGET_MAP: Record<string, { bunTarget: string; exe: boolean }> = {
  "aarch64-apple-darwin":      { bunTarget: "bun-darwin-arm64",  exe: false },
  "x86_64-apple-darwin":       { bunTarget: "bun-darwin-x64",    exe: false },
  "x86_64-pc-windows-msvc":    { bunTarget: "bun-windows-x64",   exe: true  },
  "x86_64-unknown-linux-gnu":  { bunTarget: "bun-linux-x64",     exe: false },
  "aarch64-unknown-linux-gnu": { bunTarget: "bun-linux-arm64",   exe: false },
}

// Resolve current platform's Tauri target triple
const getCurrentTauriTarget = () => {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  } else if (process.platform === "win32") {
    return "x86_64-pc-windows-msvc"
  } else {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  }
}

// Parse --target flag (optional; defaults to current platform)
const targetFlag = (() => {
  const idx = process.argv.indexOf("--target")
  return idx !== -1 ? process.argv[idx + 1] : undefined
})()

const tauriTarget = targetFlag || getCurrentTauriTarget()
const targetInfo = BUN_TARGET_MAP[tauriTarget]
if (!targetInfo) {
  console.error(`❌ Unknown target: ${tauriTarget}`)
  console.error(`   Supported: ${Object.keys(BUN_TARGET_MAP).join(", ")}`)
  process.exit(1)
}

const suffix = targetInfo.exe ? ".exe" : ""
const force = process.argv.includes("--force")
const check = process.argv.includes("--check")
if (check && force) throw new Error("--check cannot be combined with --force")

const outFile = path.join(tauriBinDir, `knowledge-sidecar-${tauriTarget}${suffix}`)
const hashFile = path.join(tauriBinDir, `.knowledge-sidecar-${tauriTarget}.hash`)

// Check if rebuild is needed
const currentHash = await computeSourceHash(
  knowledgeDir,
  ["src/**/*.ts"],
  [
    path.join(knowledgeDir, "package.json"),
    path.join(rootDir, "bun.lock"),
    import.meta.path,
    path.join(rootDir, "scripts/sidecar-metadata.ts"),
  ],
  await workspaceDepDirs(knowledgeDir, rootDir),
)

let validCache = false
try {
  verifySidecarFreshness(outFile, tauriTarget, currentHash, hashFile)
  validCache = true
} catch (error) {
  if (check) throw error
}
if (check || (!force && validCache)) {
  const size = Bun.file(outFile).size / 1024 / 1024
  console.log(`Knowledge Sidecar ${check ? "freshness verified" : "up-to-date, skipping build"} (${size.toFixed(1)} MB)`)
  process.exit(0)
}

await $`mkdir -p ${tauriBinDir}`

console.log(`Building Knowledge Sidecar for target: ${tauriTarget}`)

await $`cd ${knowledgeDir} && bun build --compile --target=${targetInfo.bunTarget} src/index.ts --outfile ${outFile}`

// Apple Silicon requires a valid ad-hoc signature to run bun-compiled macOS binaries.
// Only applies when output is a macOS binary AND we're running on macOS (codesign unavailable on linux/windows).
const isMacOSTarget = tauriTarget.endsWith("-apple-darwin")
if (process.platform === "darwin" && isMacOSTarget) {
  const resign = await $`codesign --remove-signature ${outFile} 2>/dev/null; codesign -s - ${outFile}`.nothrow()
  if (resign.exitCode !== 0) {
    console.error(`Failed to ad-hoc sign binary (exit ${resign.exitCode})`)
    console.error(`Apple Silicon requires a valid signature to run the binary`)
    process.exit(1)
  }
  console.log(`Ad-hoc signed: ${outFile}`)
}

// Save hash after successful build
await saveHash(hashFile, currentHash)
writeSidecarMetadata(outFile, tauriTarget, currentHash)

const size = Bun.file(outFile).size / 1024 / 1024
console.log(`Knowledge Sidecar ready: knowledge-sidecar-${tauriTarget}${suffix} (${size.toFixed(1)} MB)`)
