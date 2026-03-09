#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"

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

console.log(`Building Channel Gateway for target: ${tauriTarget}`)

await $`mkdir -p ${tauriBinDir}`

const outFile = path.join(tauriBinDir, `channel-gateway-${tauriTarget}${suffix}`)

await $`cd ${gatewayDir} && bun build --compile src/index.ts --outfile ${outFile}`

const size = Bun.file(outFile).size / 1024 / 1024
console.log(`Channel Gateway ready: channel-gateway-${tauriTarget}${suffix} (${size.toFixed(1)} MB)`)
