#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"

const rootDir = path.resolve(import.meta.dir, "..")
const opencodeDir = path.join(rootDir, "vendor/opencode/packages/opencode")
const tauriDir = path.join(rootDir, "packages/client/desktop/src-tauri")

console.log("Building OpenCode for current platform...")

await $`cd ${opencodeDir} && bun run build --single`

const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"
const arch = process.arch
const binaryName = `opencode-${platform}-${arch}`
const binaryPath = path.join(opencodeDir, `dist/${binaryName}/bin/opencode`)

console.log(`Binary built at: ${binaryPath}`)

const tauriBinDir = path.join(tauriDir, "binaries")
await $`mkdir -p ${tauriBinDir}`

// Tauri expects platform-specific binary names
const getTauriTarget = () => {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  } else if (process.platform === "win32") {
    return "x86_64-pc-windows-msvc"
  } else {
    return "x86_64-unknown-linux-gnu"
  }
}

const tauriTarget = getTauriTarget()
const targetName = process.platform === "win32" ? `opencode-server-${tauriTarget}.exe` : `opencode-server-${tauriTarget}`
const targetPath = path.join(tauriBinDir, targetName)

await $`cp ${binaryPath} ${targetPath}`
await $`chmod +x ${targetPath}`

console.log(`✅ OpenCode binary copied to: ${targetPath}`)
