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

const targetName = process.platform === "win32" ? "opencode-server.exe" : "opencode-server"
const targetPath = path.join(tauriBinDir, targetName)

await $`cp ${binaryPath} ${targetPath}`
await $`chmod +x ${targetPath}`

console.log(`✅ OpenCode binary copied to: ${targetPath}`)
