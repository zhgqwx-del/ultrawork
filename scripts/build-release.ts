#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"

const rootDir = path.resolve(import.meta.dir, "..")
const tauriDir = path.join(rootDir, "packages/client/desktop/src-tauri")

// ── CLI flags ──────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2))
const skipSidecar = args.has("--skip-sidecar")
const skipNotarize = args.has("--skip-notarize")
const verbose = args.has("--verbose")
const nativeOnly = args.has("--native")     // dev escape hatch: skip cross-compile
const unsigned  = args.has("--unsigned")    // ad-hoc sign only; produces app that runs locally but fails Gatekeeper for redistribution

// ── Resolve Tauri target triple ────────────────────────────────────
const getCurrentTauriTarget = () => {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  } else if (process.platform === "win32") {
    return "x86_64-pc-windows-msvc"
  } else {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  }
}

// On macOS we build a Universal binary (arm64 + x86_64) by default.
// Tauri internally lipo-merges externalBin files when --target=universal-apple-darwin.
const isMacOS = process.platform === "darwin"
const tauriTarget = isMacOS && !nativeOnly ? "universal-apple-darwin" : getCurrentTauriTarget()
const sidecarTargets = (() => {
  if (!isMacOS) return [getCurrentTauriTarget()]
  if (nativeOnly) return [getCurrentTauriTarget()]
  return ["aarch64-apple-darwin", "x86_64-apple-darwin"]
})()

// ── Non-macOS release path ────────────────────────────────────────
// Windows/Linux have no Apple signing/notarization pipeline. Build the
// current-platform sidecars + run `tauri build`, which emits the platform's
// native installers (Windows: nsis/msi, Linux: deb/appimage/rpm). Installer
// code signing, where wanted, is delegated to CI secrets + Tauri's own config.
if (!isMacOS) {
  const target = getCurrentTauriTarget()
  console.log(`\n🚀 Ultrawork Release Build (${process.platform})`)
  console.log(`   Target: ${target}`)
  if (!skipSidecar) {
    console.log(`📦 Building sidecars for ${target}...`)
    await $`bun run ${path.join(rootDir, "scripts/build-opencode.ts")} --target ${target}`.quiet(!verbose)
    await $`bun run ${path.join(rootDir, "scripts/build-gateway.ts")} --target ${target}`.quiet(!verbose)
    await $`bun run ${path.join(rootDir, "scripts/build-knowledge.ts")} --target ${target}`.quiet(!verbose)
    await $`bun run ${path.join(rootDir, "scripts/build-acp.ts")} --target ${target}`.quiet(!verbose)
  }
  console.log("\n🔨 Running tauri build...")
  await $`cd ${path.join(rootDir, "packages/client/desktop")} && bun run --bun tauri build --target ${target}`
    .quiet(!verbose)
  const bundleDir = path.join(tauriDir, "target", target, "release/bundle")
  console.log(`\n🎉 Release build complete! Installers under:`)
  console.log(`   ${bundleDir}`)
  process.exit(0)
}

// ── Environment checks (macOS only below) ─────────────────────────
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY
if (!unsigned && !signingIdentity) {
  console.error("❌ APPLE_SIGNING_IDENTITY is required (or pass --unsigned for ad-hoc build)")
  console.error("   Set it to your 'Developer ID Application: ...' identity")
  console.error("   List identities: security find-identity -v -p codesigning")
  process.exit(1)
}

const appleId = process.env.APPLE_ID
const applePassword = process.env.APPLE_PASSWORD
const appleTeamId = process.env.APPLE_TEAM_ID
const canNotarize = !unsigned && !!(appleId && applePassword && appleTeamId)

if (unsigned) {
  console.warn("⚠️  --unsigned: producing ad-hoc signed build")
  console.warn("   The .app will run on your machine but the DMG will fail Gatekeeper")
  console.warn("   on other Macs. End users must run:")
  console.warn("     xattr -dr com.apple.quarantine /Applications/Ultrawork.app")
} else if (!skipNotarize && !canNotarize) {
  console.warn("⚠️  Notarization credentials missing (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)")
  console.warn("   Will sign only. Use --skip-notarize to suppress this warning.")
}

console.log(`\n🚀 Ultrawork Release Build`)
console.log(`   Tauri target:    ${tauriTarget}`)
console.log(`   Sidecar targets: ${sidecarTargets.join(", ")}`)
console.log(`   Identity:        ${unsigned ? "(ad-hoc / unsigned)" : signingIdentity}`)
console.log(`   Notarize:        ${canNotarize ? "yes" : "no"}`)
console.log()

// ── Step 1: Build sidecars (each arch) ────────────────────────────
if (skipSidecar) {
  console.log("⏭️  Skipping sidecar build (--skip-sidecar)")
} else {
  for (const target of sidecarTargets) {
    console.log(`📦 Building sidecars for ${target}...`)
    await $`bun run ${path.join(rootDir, "scripts/build-opencode.ts")} --target ${target}`.quiet(!verbose)
    await $`bun run ${path.join(rootDir, "scripts/build-gateway.ts")} --target ${target}`.quiet(!verbose)
    await $`bun run ${path.join(rootDir, "scripts/build-knowledge.ts")} --target ${target}`.quiet(!verbose)
    await $`bun run ${path.join(rootDir, "scripts/build-acp.ts")} --target ${target}`.quiet(!verbose)
  }
}

// ── Step 1b: lipo merge per-arch sidecars into a universal binary ─
// Tauri's universal-apple-darwin bundler looks for files with the
// `-universal-apple-darwin` suffix in binaries/; it does not lipo
// per-arch files automatically. Produce the merged binary ourselves.
if (isMacOS && !nativeOnly && !skipSidecar) {
  const binariesDir = path.join(rootDir, "packages/client/desktop/src-tauri/binaries")
  const SIDECAR_BASES = ["opencode-server", "channel-gateway", "knowledge-sidecar", "acp-client"]
  console.log("\n🪢 Creating universal sidecar binaries via lipo...")
  for (const base of SIDECAR_BASES) {
    const arm = path.join(binariesDir, `${base}-aarch64-apple-darwin`)
    const x64 = path.join(binariesDir, `${base}-x86_64-apple-darwin`)
    const universal = path.join(binariesDir, `${base}-universal-apple-darwin`)
    await $`lipo -create ${arm} ${x64} -output ${universal}`
    // Re-sign: lipo doesn't preserve a usable signature on universal output.
    await $`codesign --remove-signature ${universal} 2>/dev/null; codesign -s - ${universal}`.nothrow()
    const size = Bun.file(universal).size / 1024 / 1024
    console.log(`   ${base}-universal-apple-darwin (${size.toFixed(1)} MB)`)
  }
}

// ── Step 2: Tauri build (auto-signs via APPLE_SIGNING_IDENTITY when set) ──
console.log("\n🔨 Running tauri build...")
const tauriEnv = unsigned
  ? Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "APPLE_SIGNING_IDENTITY"))
  : { ...process.env, APPLE_SIGNING_IDENTITY: signingIdentity! }
await $`cd ${path.join(rootDir, "packages/client/desktop")} && bun run --bun tauri build --target ${tauriTarget}`
  .env(tauriEnv)
  .quiet(!verbose)

// ── Locate build outputs ──────────────────────────────────────────
const bundleDir = path.join(tauriDir, "target", tauriTarget, "release/bundle")
const appPath = path.join(bundleDir, "macos/Ultrawork.app")
const dmgGlob = new Bun.Glob("*.dmg")
const dmgFiles = Array.from(dmgGlob.scanSync(path.join(bundleDir, "dmg")))
const dmgPath = dmgFiles.length > 0 ? path.join(bundleDir, "dmg", dmgFiles[0]) : null

console.log(`\n✅ Build complete`)
console.log(`   .app: ${appPath}`)
if (dmgPath) console.log(`   .dmg: ${dmgPath}`)

// ── Step 3: Verify code signing (or ad-hoc sign for --unsigned) ───
if (unsigned) {
  console.log("\n🔏 Ad-hoc signing (no Dev ID)...")
  await $`codesign --force --deep -s - ${appPath}`
  if (dmgPath) {
    // DMG itself can't be ad-hoc signed meaningfully — Gatekeeper will reject it for redistribution.
    console.warn(`   Note: ${path.basename(dmgPath)} is unsigned. End users must run`)
    console.warn(`   'xattr -dr com.apple.quarantine /Applications/Ultrawork.app' after install.`)
  }
} else {
  console.log("\n🔏 Verifying code signature...")
  await $`codesign --verify --deep --strict ${appPath}`
  console.log("   Signature valid ✓")

  if (verbose) {
    await $`codesign -dv --verbose=2 ${appPath}`
  }
}

// ── Step 4: Notarize & staple ─────────────────────────────────────
if (skipNotarize || !canNotarize) {
  console.log("\n⏭️  Skipping notarization")
} else {
  // Notarize the DMG (preferred) or .app as zip fallback
  if (!dmgPath) {
    // Need to zip the .app for notarization
    console.log("\n📤 Zipping .app for notarization...")
    const zipPath = path.join(bundleDir, "Ultrawork.zip")
    await $`ditto -c -k --sequesterRsrc --keepParent ${appPath} ${zipPath}`
  }

  const submitTarget = dmgPath ?? path.join(bundleDir, "Ultrawork.zip")

  console.log(`\n📤 Submitting for notarization: ${path.basename(submitTarget)}`)
  console.log("   This may take several minutes...")

  await $`xcrun notarytool submit ${submitTarget} --apple-id ${appleId} --password ${applePassword} --team-id ${appleTeamId} --wait`
    .quiet(!verbose)

  console.log("   Notarization approved ✓")

  // Staple the ticket
  console.log("\n📎 Stapling notarization ticket...")
  await $`xcrun stapler staple ${appPath}`
  if (dmgPath) {
    await $`xcrun stapler staple ${dmgPath}`
  }
  console.log("   Stapled ✓")
}

// ── Summary ───────────────────────────────────────────────────────
console.log("\n" + "─".repeat(50))
console.log("🎉 Release build complete!")
console.log(`   .app: ${appPath}`)
if (dmgPath) console.log(`   .dmg: ${dmgPath}`)
console.log()
if (unsigned) {
  console.log("⚠️  Unsigned build — for local use or trusted-channel distribution only.")
  console.log("   End users must remove the quarantine attribute after install:")
  console.log(`     xattr -dr com.apple.quarantine /Applications/Ultrawork.app`)
} else {
  console.log("Verify with:")
  console.log(`   codesign -dv --verbose=2 "${appPath}"`)
  if (canNotarize) {
    console.log(`   spctl --assess --type open --context context:primary-signature "${appPath}"`)
  }
}
