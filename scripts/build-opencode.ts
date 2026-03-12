#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"

const rootDir = path.resolve(import.meta.dir, "..")
const opencodeDir = path.join(rootDir, "vendor/opencode/packages/opencode")
const tauriDir = path.join(rootDir, "packages/client/desktop/src-tauri")
const tauriBinDir = path.join(tauriDir, "binaries")

// Parse --target flag: aarch64-apple-darwin | x86_64-apple-darwin | x86_64-pc-windows-msvc | x86_64-unknown-linux-gnu
const targetFlag = (() => {
  const idx = process.argv.indexOf("--target")
  return idx !== -1 ? process.argv[idx + 1] : undefined
})()

// Map Tauri target triple → build parameters
const TARGET_MAP: Record<string, { os: string; arch: string; bunTarget: string; exe: boolean }> = {
  "aarch64-apple-darwin":      { os: "darwin",  arch: "arm64", bunTarget: "darwin-arm64",  exe: false },
  "x86_64-apple-darwin":       { os: "darwin",  arch: "x64",   bunTarget: "darwin-x64",   exe: false },
  "x86_64-pc-windows-msvc":    { os: "windows", arch: "x64",   bunTarget: "windows-x64",  exe: true  },
  "x86_64-unknown-linux-gnu":  { os: "linux",   arch: "x64",   bunTarget: "linux-x64",    exe: false },
  "aarch64-unknown-linux-gnu": { os: "linux",   arch: "arm64", bunTarget: "linux-arm64",   exe: false },
}

// Resolve current platform's Tauri target
const getCurrentTauriTarget = () => {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  } else if (process.platform === "win32") {
    return "x86_64-pc-windows-msvc"
  } else {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  }
}

const tauriTarget = targetFlag || getCurrentTauriTarget()
const targetInfo = TARGET_MAP[tauriTarget]

if (!targetInfo) {
  console.error(`❌ Unknown target: ${tauriTarget}`)
  console.error(`   Supported targets: ${Object.keys(TARGET_MAP).join(", ")}`)
  process.exit(1)
}

console.log(`Building OpenCode sidecar for target: ${tauriTarget}`)

// Build the sidecar binary
// When cross-compiling (target != current platform), we need to build without --single
// and the build script will produce binaries for all platforms
const isNative = tauriTarget === getCurrentTauriTarget()

if (isNative) {
  // Native build: fast, single target
  await $`cd ${opencodeDir} && bun run build --single`
} else {
  // Cross build: build all targets, then pick the one we need
  console.log(`Cross-compiling: building all targets to extract ${targetInfo.bunTarget}...`)
  await $`cd ${opencodeDir} && bun run build`
}

const binaryName = `opencode-${targetInfo.bunTarget}`
const binarySuffix = targetInfo.exe ? ".exe" : ""
const binaryPath = path.join(opencodeDir, `dist/${binaryName}/bin/opencode${binarySuffix}`)

// Verify binary exists
const binaryFile = Bun.file(binaryPath)
if (!await binaryFile.exists()) {
  console.error(`❌ Binary not found: ${binaryPath}`)
  console.error(`   Check vendor/opencode build output in dist/`)
  process.exit(1)
}

console.log(`Binary built at: ${binaryPath}`)

await $`mkdir -p ${tauriBinDir}`

const targetName = `opencode-server-${tauriTarget}${binarySuffix}`
const targetPath = path.join(tauriBinDir, targetName)

await $`cp ${binaryPath} ${targetPath}`
await $`chmod +x ${targetPath}`

const size = binaryFile.size / 1024 / 1024
console.log(`✅ OpenCode sidecar ready: ${targetName} (${size.toFixed(1)} MB)`)
