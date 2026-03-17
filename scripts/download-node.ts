#!/usr/bin/env bun
/**
 * Download Node.js LTS binary for embedding into Tauri resources.
 *
 * Downloads the official Node.js tarball, extracts `node` and `npm` binaries,
 * and places them in `packages/client/desktop/src-tauri/resources/node/bin/`.
 *
 * Usage:
 *   bun run scripts/download-node.ts [--force]
 *
 * The script skips download if binaries already exist (use --force to re-download).
 */
import { $ } from "bun"
import path from "path"
import fs from "fs/promises"

const NODE_VERSION = "v22.16.0" // LTS
const rootDir = path.resolve(import.meta.dir, "..")
const tauriDir = path.join(rootDir, "packages/client/desktop/src-tauri")
const resourceDir = path.join(tauriDir, "resources/node")
const binDir = path.join(resourceDir, "bin")

const force = process.argv.includes("--force")

// Determine platform + arch
const platformMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "win" }
const archMap: Record<string, string> = { arm64: "arm64", x64: "x64" }
const platform = platformMap[process.platform]
const arch = archMap[process.arch]

if (!platform || !arch) {
  console.error(`Unsupported platform: ${process.platform}-${process.arch}`)
  process.exit(1)
}

const nodeBin = path.join(binDir, "node")

// Skip if already downloaded
if (!force && await Bun.file(nodeBin).exists()) {
  console.log(`Node.js ${NODE_VERSION} already exists at ${binDir}, skipping (use --force to re-download)`)
  process.exit(0)
}

const tarballName = `node-${NODE_VERSION}-${platform}-${arch}.tar.gz`
const url = `https://nodejs.org/dist/${NODE_VERSION}/${tarballName}`
const tmpDir = path.join(tauriDir, "resources/.node-tmp")

console.log(`Downloading Node.js ${NODE_VERSION} (${platform}-${arch})...`)
console.log(`  URL: ${url}`)

// Clean up and create directories
await fs.rm(tmpDir, { recursive: true, force: true })
await fs.mkdir(tmpDir, { recursive: true })
await fs.mkdir(binDir, { recursive: true })

// Download
const tarball = path.join(tmpDir, tarballName)
await $`curl -fSL -o ${tarball} ${url}`

// Extract only what we need: node binary + npm
const extractedDir = `node-${NODE_VERSION}-${platform}-${arch}`
console.log("Extracting node and npm binaries...")

// Extract node binary
await $`tar -xzf ${tarball} -C ${tmpDir} ${extractedDir}/bin/node`

// Extract npm and its libs
await $`tar -xzf ${tarball} -C ${tmpDir} ${extractedDir}/bin/npm ${extractedDir}/lib/node_modules/npm`

// Copy node binary
await fs.copyFile(path.join(tmpDir, extractedDir, "bin/node"), nodeBin)
await fs.chmod(nodeBin, 0o755)

// Copy npm script
const npmSrc = path.join(tmpDir, extractedDir, "bin/npm")
const npmDst = path.join(binDir, "npm")
await fs.copyFile(npmSrc, npmDst)
await fs.chmod(npmDst, 0o755)

// Copy npm's node_modules
const libDir = path.join(resourceDir, "lib/node_modules")
await fs.rm(libDir, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
await $`cp -R ${path.join(tmpDir, extractedDir, "lib/node_modules/npm")} ${libDir}/npm`

// Clean up temp
await fs.rm(tmpDir, { recursive: true, force: true })

// Verify
const result = await $`${nodeBin} --version`.text()
console.log(`\nNode.js ${result.trim()} installed to ${resourceDir}`)

// Print size
const stat = await fs.stat(nodeBin)
const npmStat = await fs.stat(npmDst)
const npmLibSize = await $`du -sh ${libDir}`.text()
console.log(`  node binary: ${(stat.size / 1024 / 1024).toFixed(1)} MB`)
console.log(`  npm script: ${(npmStat.size / 1024).toFixed(0)} KB`)
console.log(`  npm lib: ${npmLibSize.trim().split("\t")[0]}`)
