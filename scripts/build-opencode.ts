#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"
import { verifySidecarFreshness, writeSidecarMetadata } from "./sidecar-metadata"
import { saveHash } from "./build-hash"
import { readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createBuildProbeEnvironment } from "./build-probe-env"
import { captureVendorDependencies, installVendorDependencies } from "./vendor-dependencies"
import { ensureVendorPatches } from "./vendor-patches"

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

const force = process.argv.includes("--force")
const check = process.argv.includes("--check")
if (check && force) throw new Error("--check cannot be combined with --force")
console.log(`${check ? "Checking" : "Building"} OpenCode sidecar for target: ${tauriTarget}`)

// Check the complete cumulative patch, including dependency pins added after
// an earlier source patch was applied. A single source sentinel cannot do this.
const vendorDir = path.join(rootDir, "vendor/opencode")
const patchFile = path.join(rootDir, "patches/vendor-opencode-config-fix.patch")
if (check) {
  // Unlike a build, --check must not apply patches or install dependencies.
  // A clean/uninitialized checkout needs the normal build path first.
  const patchDir = path.join(rootDir, "patches")
  const patches = readdirSync(patchDir).filter((file) => /^vendor-opencode-.*\.patch$/.test(file)).sort()
  if (!patches.includes("vendor-opencode-config-fix.patch")) throw new Error("Missing canonical vendor patch; rebuild sidecars after restoring it")
  const location = spawnSync("git", ["rev-parse", "--is-inside-work-tree", "--show-prefix"], { cwd: vendorDir, encoding: "utf8", windowsHide: true })
  const [inside, prefix] = location.stdout?.split(/\r?\n/) ?? []
  if (location.status !== 0 || inside !== "true" || prefix !== "") throw new Error("vendor/opencode must be an initialized Git working tree before checking sidecar freshness")
  for (const patch of patches) {
    const result = spawnSync("git", ["apply", "--reverse", "--check", "--", path.join(patchDir, patch)], { cwd: vendorDir, encoding: "utf8", windowsHide: true })
    if (result.status !== 0) throw new Error(`Vendor patch is not fully applied: ${patch}. Run the normal sidecar build before packaging.`)
  }
} else ensureVendorPatches(rootDir)

const binaryName = `opencode-${targetInfo.bunTarget}`
const binarySuffix = targetInfo.exe ? ".exe" : ""
const binaryPath = path.join(opencodeDir, `dist/${binaryName}/bin/opencode${binarySuffix}`)

// Incremental build: hash submodule commit + patch file to detect changes.
// This avoids re-hashing the entire vendor source tree (which is large).
const targetName = `opencode-server-${tauriTarget}${binarySuffix}`
const targetPath = path.join(tauriBinDir, targetName)
const hashFilePath = path.join(tauriBinDir, `.opencode-server-${tauriTarget}.hash`)
const dependencyState = captureVendorDependencies(vendorDir)

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
  hasher.update(await Bun.file(path.join(rootDir, "scripts/build-probe-env.ts")).arrayBuffer())
  hasher.update(await Bun.file(path.join(rootDir, "scripts/vendor-dependencies.ts")).arrayBuffer())
  hasher.update(await Bun.file(path.join(rootDir, "scripts/vendor-patches.ts")).arrayBuffer())
  hasher.update(dependencyState.digest)
  return hasher.digest("hex")
}

const currentHash = await computeOpencodeHash()

let validCache = false
try {
  verifySidecarFreshness(targetPath, tauriTarget, currentHash, hashFilePath)
  validCache = true
} catch (error) {
  if (check) throw error
}
if (check || (!force && validCache)) {
  dependencyState.assertUnchanged("incremental build validation")
  const size = Bun.file(targetPath).size / 1024 / 1024
  console.log(`OpenCode sidecar ${check ? "freshness verified" : "up-to-date, skipping build"} (${size.toFixed(1)} MB)`)
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

const probe = createBuildProbeEnvironment()
try {
  // Install every target's optional native package from the tracked lock once.
  // Upstream's default install commands add packages and can advance git refs.
  await installVendorDependencies(vendorDir, { env: probe.env })
  dependencyState.assertUnchanged("dependency preparation")
  const buildStart = Date.now()
  if (isNative) {
    const result = await $`cd ${opencodeDir} && bun run build --single --skip-install`.env(probe.env).nothrow()
    if (result.exitCode !== 0) {
      // Acceptable if the binary was freshly produced (smoke test failure).
      // A real compilation error would not produce the binary at all.
      const stat = await Bun.file(binaryPath).stat().catch(() => null)
      if (!stat || stat.mtimeMs < buildStart) {
        console.error(`❌ Build failed (no fresh binary produced)`)
        throw new Error("OpenCode native build failed without producing a fresh binary")
      }
      console.warn(`⚠️  vendor build exited ${result.exitCode} — binary is fresh, continuing (smoke test / signing issue)`)
    }
  } else {
    // Cross-compile a single target via the vendor patch's --target flag.
    // This avoids building (and smoke-testing) every other target — which would
    // fail on Apple Silicon for the native arm64 binary that needs re-signing.
    console.log(`Cross-compiling target ${targetInfo.bunTarget}...`)
    const vendorTarget = targetInfo.os === "windows" ? `win32-${targetInfo.arch}` : targetInfo.bunTarget
    const result = await $`cd ${opencodeDir} && bun run build --target=${vendorTarget} --skip-install`.env(probe.env).nothrow()
    if (result.exitCode !== 0) {
      const stat = await Bun.file(binaryPath).stat().catch(() => null)
      if (!stat || stat.mtimeMs < buildStart) {
        console.error(`❌ Build failed (no fresh binary produced)`)
        throw new Error("OpenCode cross build failed without producing a fresh binary")
      }
      console.warn(`⚠️  vendor build exited ${result.exitCode} — binary is fresh, continuing`)
    }
  }
  dependencyState.assertUnchanged("OpenCode compilation")
} finally {
  probe.dispose()
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
if (process.platform === "darwin" && targetInfo.os === "darwin") {
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
// chmod is a no-op concept on Windows (and not a Bun Shell builtin there).
if (process.platform !== "win32") {
  await $`chmod +x ${targetPath}`
}

// Save hash after successful build
dependencyState.assertUnchanged("sidecar export")
await saveHash(hashFilePath, currentHash)
writeSidecarMetadata(targetPath, tauriTarget, currentHash)

const size = binaryFile.size / 1024 / 1024
console.log(`✅ OpenCode sidecar ready: ${targetName} (${size.toFixed(1)} MB)`)
