#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"
import { needsRebuild, saveHash } from "./build-hash"

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

// Apply vendor patches if not already applied.
// The patch file contains all Ultrawork-specific modifications to vendor/opencode:
//   - OPENCODE_APP_NAME config isolation (global/index.ts, config.ts, paths.ts)
//   - PINNED_PLUGIN_VERSION + config.json→opencode.json fix (config.ts)
// See docs/decisions/020-config-isolation.md for details.
const vendorDir = path.join(rootDir, "vendor/opencode")
const patchFile = path.join(rootDir, "patches/vendor-opencode-config-fix.patch")
const patchSentinel = path.join(opencodeDir, "src/global/index.ts")
const sentinelContent = await Bun.file(patchSentinel).text()
if (!sentinelContent.includes("OPENCODE_APP_NAME")) {
  console.log("Applying vendor patches...")
  const applyResult = await $`cd ${vendorDir} && git apply ${patchFile}`.nothrow()
  if (applyResult.exitCode !== 0) {
    console.error("⚠️  Patch apply failed (may have conflicts after submodule update)")
    console.error("   Fix conflicts manually, then run: bun run scripts/sync-plugin-version.ts")
    process.exit(1)
  }
  console.log("✅ Vendor patches applied")
} else {
  console.log("Vendor patches already applied, skipping")
}

const binaryName = `opencode-${targetInfo.bunTarget}`
const binarySuffix = targetInfo.exe ? ".exe" : ""
const binaryPath = path.join(opencodeDir, `dist/${binaryName}/bin/opencode${binarySuffix}`)

const force = process.argv.includes("--force")

// Incremental build: hash submodule commit + patch file to detect changes.
// This avoids re-hashing the entire vendor source tree (which is large).
const targetName = `opencode-server-${tauriTarget}${binarySuffix}`
const targetPath = path.join(tauriBinDir, targetName)
const hashFilePath = path.join(tauriBinDir, `.opencode-server-${tauriTarget}.hash`)

const computeOpencodeHash = async () => {
  const hasher = new Bun.CryptoHasher("sha256")
  // Include submodule HEAD commit
  const submoduleHead = await $`cd ${vendorDir} && git rev-parse HEAD`.text()
  hasher.update(submoduleHead.trim())
  // Include patch file content
  const patchContent = await Bun.file(patchFile).arrayBuffer().catch(() => new ArrayBuffer(0))
  hasher.update(patchContent)
  // Include build script itself (in case build logic changes)
  hasher.update(await Bun.file(import.meta.path).arrayBuffer())
  return hasher.digest("hex")
}

const currentHash = await computeOpencodeHash()

if (!force && !await needsRebuild(hashFilePath, currentHash, targetPath)) {
  const size = Bun.file(targetPath).size / 1024 / 1024
  console.log(`OpenCode sidecar up-to-date, skipping build (${size.toFixed(1)} MB)`)
  process.exit(0)
}

// Build the sidecar binary.
// When cross-compiling (target != current platform), we need to build without --single
// and the build script will produce binaries for all platforms.
//
// bun ≥1.3.12 on macOS produces binaries with an unfilled LC_CODE_SIGNATURE slot.
// The vendor smoke test runs the binary before we can sign it, so it gets SIGKILL'd.
// We record mtime before the build and use it to verify the binary is freshly produced
// even when the vendor script exits non-zero due to the smoke test failure.
const isNative = tauriTarget === getCurrentTauriTarget()
const buildStart = Date.now()

if (isNative) {
  const result = await $`cd ${opencodeDir} && bun run build --single`.nothrow()
  if (result.exitCode !== 0) {
    // Acceptable if the binary was freshly produced (smoke test failure).
    // A real compilation error would not produce the binary at all.
    const stat = await Bun.file(binaryPath).stat().catch(() => null)
    if (!stat || stat.mtimeMs < buildStart) {
      console.error(`❌ Build failed (no fresh binary produced)`)
      process.exit(1)
    }
    console.warn(`⚠️  vendor build exited ${result.exitCode} — binary is fresh, continuing (smoke test / signing issue)`)
  }
} else {
  // Cross-compile a single target via the vendor patch's --target flag.
  // This avoids building (and smoke-testing) every other target — which would
  // fail on Apple Silicon for the native arm64 binary that needs re-signing.
  console.log(`Cross-compiling target ${targetInfo.bunTarget}...`)
  const result = await $`cd ${opencodeDir} && bun run build --target=${targetInfo.bunTarget}`.nothrow()
  if (result.exitCode !== 0) {
    const stat = await Bun.file(binaryPath).stat().catch(() => null)
    if (!stat || stat.mtimeMs < buildStart) {
      console.error(`❌ Build failed (no fresh binary produced)`)
      process.exit(1)
    }
    console.warn(`⚠️  vendor build exited ${result.exitCode} — binary is fresh, continuing`)
  }
}

// Verify binary exists
const binaryFile = Bun.file(binaryPath)
if (!await binaryFile.exists()) {
  console.error(`❌ Binary not found: ${binaryPath}`)
  console.error(`   Check vendor/opencode build output in dist/`)
  process.exit(1)
}

// On macOS, bun ≥1.3.12 compiles binaries with a pre-allocated but unfilled
// LC_CODE_SIGNATURE slot. Apple Silicon requires a valid ad-hoc signature to
// run, so we strip the placeholder and re-sign before the smoke test.
if (process.platform === "darwin") {
  const resign = await $`codesign --remove-signature ${binaryPath} 2>/dev/null; codesign -s - ${binaryPath}`.nothrow()
  if (resign.exitCode !== 0) {
    console.error(`❌ Failed to ad-hoc sign binary (exit ${resign.exitCode})`)
    console.error(`   Apple Silicon requires a valid signature to run the binary`)
    process.exit(1)
  }
  console.log(`🔏 Ad-hoc signed: ${binaryPath}`)
}

console.log(`Binary built at: ${binaryPath}`)

await $`mkdir -p ${tauriBinDir}`

await $`cp ${binaryPath} ${targetPath}`
await $`chmod +x ${targetPath}`

// Save hash after successful build
await saveHash(hashFilePath, currentHash)

const size = binaryFile.size / 1024 / 1024
console.log(`✅ OpenCode sidecar ready: ${targetName} (${size.toFixed(1)} MB)`)
