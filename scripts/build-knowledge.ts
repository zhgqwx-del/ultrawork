#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"

const rootDir = path.resolve(import.meta.dir, "..")
const knowledgeDir = path.join(rootDir, "packages/knowledge/sidecar")
const tauriDir = path.join(rootDir, "packages/client/desktop/src-tauri")
const tauriBinDir = path.join(tauriDir, "binaries")

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

const tauriTarget = getCurrentTauriTarget()
const isWindows = process.platform === "win32"
const suffix = isWindows ? ".exe" : ""

console.log(`Building Knowledge Sidecar for target: ${tauriTarget}`)

await $`mkdir -p ${tauriBinDir}`

const outFile = path.join(tauriBinDir, `knowledge-sidecar-${tauriTarget}${suffix}`)

await $`cd ${knowledgeDir} && bun build --compile src/index.ts --outfile ${outFile}`

// Apple Silicon requires a valid ad-hoc signature to run bun-compiled binaries.
if (process.platform === "darwin") {
  const resign = await $`codesign --remove-signature ${outFile} 2>/dev/null; codesign -s - ${outFile}`.nothrow()
  if (resign.exitCode !== 0) {
    console.error(`Failed to ad-hoc sign binary (exit ${resign.exitCode})`)
    console.error(`Apple Silicon requires a valid signature to run the binary`)
    process.exit(1)
  }
  console.log(`Ad-hoc signed: ${outFile}`)
}

const size = Bun.file(outFile).size / 1024 / 1024
console.log(`Knowledge Sidecar ready: knowledge-sidecar-${tauriTarget}${suffix} (${size.toFixed(1)} MB)`)
