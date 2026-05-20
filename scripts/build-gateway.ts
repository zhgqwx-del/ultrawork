#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"
import { computeSourceHash, needsRebuild, saveHash } from "./build-hash"

const rootDir = path.resolve(import.meta.dir, "..")
const gatewayDir = path.join(rootDir, "packages/channel/gateway")
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
const force = process.argv.includes("--force")

await $`mkdir -p ${tauriBinDir}`

const outFile = path.join(tauriBinDir, `channel-gateway-${tauriTarget}${suffix}`)
const hashFile = path.join(tauriBinDir, `.channel-gateway-${tauriTarget}.hash`)

// Check if rebuild is needed.
// Gateway depends on @agent/api-client (workspace:*), so include its source too.
const apiClientDir = path.join(rootDir, "packages/core/api-client")
const currentHash = await computeSourceHash(
  gatewayDir,
  ["src/**/*.ts"],
  [
    path.join(gatewayDir, "package.json"),
    path.join(apiClientDir, "package.json"),
    path.join(rootDir, "bun.lock"),
  ],
  [{ dir: apiClientDir, globs: ["src/**/*.ts"] }],
)

if (!force && !await needsRebuild(hashFile, currentHash, outFile)) {
  const size = Bun.file(outFile).size / 1024 / 1024
  console.log(`Channel Gateway up-to-date, skipping build (${size.toFixed(1)} MB)`)
  process.exit(0)
}

console.log(`Building Channel Gateway for target: ${tauriTarget}`)

await $`cd ${gatewayDir} && bun build --compile src/index.ts --outfile ${outFile}`

// Apple Silicon requires a valid ad-hoc signature to run bun-compiled binaries.
// Strip any placeholder signature and re-sign.
if (process.platform === "darwin") {
  const resign = await $`codesign --remove-signature ${outFile} 2>/dev/null; codesign -s - ${outFile}`.nothrow()
  if (resign.exitCode !== 0) {
    console.error(`❌ Failed to ad-hoc sign binary (exit ${resign.exitCode})`)
    console.error(`   Apple Silicon requires a valid signature to run the binary`)
    process.exit(1)
  }
  console.log(`🔏 Ad-hoc signed: ${outFile}`)
}

// Save hash after successful build
await saveHash(hashFile, currentHash)

const size = Bun.file(outFile).size / 1024 / 1024
console.log(`Channel Gateway ready: channel-gateway-${tauriTarget}${suffix} (${size.toFixed(1)} MB)`)
