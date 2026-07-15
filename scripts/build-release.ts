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
// Companion to TAURI_BUNDLER_DMG_IGNORE_CI=false (see Step 2): downgrades the
// DMG layout check to a warning so a release can ship while upstream's Finder
// automation is broken. Ugly on purpose — it lets a mislaid DMG out the door.
const allowBadDmgLayout = args.has("--allow-bad-dmg-layout")

// ── Version tag guard ──────────────────────────────────────────────
// When this build happens AT a version tag, the tag must equal the version
// baked into tauri.conf.json — the version that lands in the installer and,
// via check-docs.ts §2f, on the About page. Otherwise the Release page title
// (which is just the tag name) and the installer's real version silently
// disagree. CI's release.yml fails fast on the same mismatch; this mirrors it
// for a local `bun run release` off a tagged commit. A build that is NOT on a
// tag (routine dev/test build) is skipped — only a v* tag triggers the check.
{
  const ci = process.env.GITHUB_REF_NAME
  let versionTag: string | null = ci && ci.startsWith("v") ? ci : null
  if (!versionTag) {
    // Local: is HEAD sitting exactly on a v* tag?
    const r = await $`git describe --tags --exact-match HEAD`.quiet().nothrow()
    const t = r.exitCode === 0 ? r.stdout.toString().trim() : ""
    if (t.startsWith("v")) versionTag = t
  }
  if (versionTag) {
    const fileVer = (await Bun.file(path.join(tauriDir, "tauri.conf.json")).json()).version
    const tagVer = versionTag.replace(/^v/, "")
    if (tagVer !== fileVer) {
      console.error(`❌ Version tag '${versionTag}' does not match tauri.conf.json version '${fileVer}'.`)
      console.error(`   Bump the five version files (root + desktop package.json, tauri.conf.json,`)
      console.error(`   Cargo.toml, app-version.ts) to match the tag, or retag. See check-docs.ts §2f.`)
      process.exit(1)
    }
    console.log(`🔖 Version tag '${versionTag}' matches file version '${fileVer}' ✓`)
  }
}

// ── Built-in skills zip (bundle.resources 携带物) ──────────────────
// beforeBuildCommand 也会跑，这里显式再跑一次是双保险 + 日志可见；hash 未变时瞬时跳过。
console.log("📦 Packing built-in skills zip...")
await $`bun run --bun ${path.join(rootDir, "scripts/pack-builtin-skills.ts")}`

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

// ── Windows: two NSIS installers + one MSI (discussions/030 D1/D2) ─
//
//   *-setup.exe          embeds the 1.8MB WebView2 bootstrapper, which downloads
//                        the ~176MB runtime at install time. The default.
//   *-offline-setup.exe  carries the whole runtime; installs with no network.
//                        For China / air-gapped / locked-down machines.
//   *_en-US.msi          embed flavour only — enterprise deploys via SCCM/Intune
//                        usually pre-provision WebView2, and stuffing 127MB of
//                        runtime through WiX's cabinet is a risk for no gain.
//
// `offlineInstaller` needs no `path`: tauri-bundler downloads the runtime itself
// at bundle time and caches it under %LOCALAPPDATA%\tauri. That download resolves
// a Microsoft fwlink and then asserts the redirect target starts with a hardcoded
// CDN prefix, so it can fail on networks that land on a different edge — see
// discussions/030 §9.3-A for the pre-seed escape hatch.
const WEBVIEW2_OFFLINE_MIN_DELTA = 100 * 1024 * 1024

const OFFLINE_SUFFIX = "-offline-setup.exe"

async function buildWindowsInstallers(
  tauriBuild: (extra: string[]) => Promise<unknown>,
  nsisDir: string,
) {
  const fs = await import("fs/promises")
  const listExes = async (): Promise<string[]> => fs.readdir(nsisDir).catch(() => [])
  // `-offline-setup.exe` also ends in `-setup.exe`, so the default installer has to
  // be identified by exclusion.
  const defaultSetupExes = async () =>
    (await listExes()).filter((f) => f.endsWith("-setup.exe") && !f.endsWith(OFFLINE_SUFFIX))

  // Stale outputs from an earlier local `bun run release` would make the
  // "exactly one" checks below ambiguous, and a leftover offline exe could survive
  // a failed rebuild and be published. CI starts clean; developers do not.
  const embedStashSuffix = ".embed-stash"
  for (const stale of await listExes()) {
    if (stale.endsWith(".exe") || stale.endsWith(embedStashSuffix)) {
      await fs.rm(path.join(nsisDir, stale))
    }
  }

  // Embed + MSI first. These are the primary installers and the reliable build:
  // no network beyond the tiny bootstrapper fetch. Surfacing a broken config or a
  // WiX failure here — before the ~13-minute offline build — keeps the fragile
  // step from being a prerequisite for the reliable one. tauri-bundler hardcodes
  // the NSIS output as `{product}_{version}_{arch}-setup.exe` (nsis/mod.rs), which
  // is exactly the name we want to ship, so stash it out of the way before the
  // offline build reuses that name, then restore it.
  console.log("\n🔨 tauri build — default (embedded bootstrapper) + MSI...")
  await tauriBuild(["--bundles", "nsis", "msi"])
  const embedList = await defaultSetupExes()
  if (embedList.length !== 1) {
    throw new Error(
      `expected exactly one *-setup.exe after the embed build, found ${embedList.length}: ${embedList.join(", ")}`,
    )
  }
  const embedName = embedList[0]
  await fs.rename(path.join(nsisDir, embedName), path.join(nsisDir, embedName + embedStashSuffix))

  // Offline second. tauri-bundler fetches ~176MB from Microsoft at bundle time and
  // asserts the fwlink redirects to a hardcoded CDN prefix, so it can fail on
  // networks that resolve to a different edge — discussions/030 §9.3-A. Translate
  // that opaque failure into a pointer to the pre-seed escape hatch. Fatal on
  // purpose: a release is expected to carry all three installers or fail loudly.
  const offlineConfig = JSON.stringify({
    bundle: { windows: { webviewInstallMode: { type: "offlineInstaller", silent: true } } },
  })
  console.log("\n🔨 tauri build — offline WebView2 variant...")
  try {
    await tauriBuild(["--bundles", "nsis", "--config", offlineConfig])
  } catch (e) {
    throw new Error(
      `offline WebView2 build failed. If the log shows "WebView2 URL prefix mismatch", ` +
        `tauri-bundler's fwlink resolved to an unexpected CDN host (common on CN networks). ` +
        `Pre-seed %LOCALAPPDATA%\\tauri with the runtime installer to skip the download ` +
        `(discussions/030 §9.3-A).\n${e}`,
    )
  }
  const offlineList = await defaultSetupExes()
  if (offlineList.length !== 1) {
    throw new Error(
      `expected exactly one *-setup.exe after the offline build, found ${offlineList.length}: ${offlineList.join(", ")}`,
    )
  }
  const offlineName = offlineList[0].replace(/-setup\.exe$/, OFFLINE_SUFFIX)
  await fs.rename(path.join(nsisDir, offlineList[0]), path.join(nsisDir, offlineName))
  console.log(`   → ${offlineName}`)

  // Restore the embed installer to its canonical name.
  await fs.rename(path.join(nsisDir, embedName + embedStashSuffix), path.join(nsisDir, embedName))

  // A wrong `webviewInstallMode` does not fail the build — it silently falls back,
  // and the only visible symptom is a smaller installer. v0.2.2 shipped a broken
  // DMG layout for exactly this class of reason, so assert rather than trust.
  const offlineBytes = (await fs.stat(path.join(nsisDir, offlineName))).size
  const embedBytes = (await fs.stat(path.join(nsisDir, embedName))).size
  const delta = offlineBytes - embedBytes
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1)
  console.log(`\n📏 ${embedName}: ${mb(embedBytes)} MB`)
  console.log(`   ${offlineName}: ${mb(offlineBytes)} MB  (+${mb(delta)} MB)`)
  if (delta < WEBVIEW2_OFFLINE_MIN_DELTA) {
    throw new Error(
      `offline installer is only ${mb(delta)} MB larger than the default one; ` +
        `the bundled WebView2 runtime (~127MB) is missing — webviewInstallMode likely did not apply`,
    )
  }
  console.log("   WebView2 offline runtime ✓")
}

// ── Non-macOS release path ────────────────────────────────────────
// Windows/Linux have no Apple signing/notarization pipeline. Build the
// current-platform sidecars + run `tauri build`, which emits the platform's
// native installers (Windows: nsis/msi, Linux: deb/rpm). Installer code
// signing, where wanted, is delegated to CI secrets + Tauri's own config.
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
  const bundleDir = path.join(tauriDir, "target", target, "release/bundle")
  const desktopDir = path.join(rootDir, "packages/client/desktop")
  const tauriBuild = (extra: string[]) =>
    $`cd ${desktopDir} && bun run --bun tauri build --target ${target} ${extra}`.quiet(!verbose)

  if (process.platform === "win32") {
    await buildWindowsInstallers(tauriBuild, path.join(bundleDir, "nsis"))
  } else {
    // Linux: restrict to deb+rpm. AppImage's linuxdeploy needs FUSE/GStreamer
    // plumbing that's fragile on CI runners; deb/rpm cover the install story.
    console.log("\n🔨 Running tauri build...")
    await tauriBuild(["--bundles", "deb", "rpm"])
  }

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
// TAURI_BUNDLER_DMG_IGNORE_CI: when `CI=true`, tauri-bundler passes
// `--skip-jenkins` to bundle_dmg, which skips the AppleScript that positions
// the icons and writes .DS_Store. Finder then falls back to sorting by name,
// putting `Applications` LEFT of `Ultrawork.app` — the reverse of the
// drag-right convention. Opting out makes the AppleScript run on CI too; if
// Finder is unreachable there, bundle_dmg exits 64 and the build fails loudly
// rather than shipping a mislaid DMG.
//
// Overridable because driving Finder from a runner is not something upstream
// supports — GitHub's macOS image regressed once already (tauri-action#1091:
// AppleEvent timed out -1712), and the fix landed image-side. During such a
// window, `TAURI_BUNDLER_DMG_IGNORE_CI=false` plus `--allow-bad-dmg-layout`
// gets a release out; both are required, so no single flag silently ships a
// name-sorted DMG.
const tauriEnv = {
  ...(unsigned
    ? Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "APPLE_SIGNING_IDENTITY"))
    : { ...process.env, APPLE_SIGNING_IDENTITY: signingIdentity! }),
  TAURI_BUNDLER_DMG_IGNORE_CI: process.env.TAURI_BUNDLER_DMG_IGNORE_CI ?? "true",
}
await $`cd ${path.join(rootDir, "packages/client/desktop")} && bun run --bun tauri build --target ${tauriTarget}`
  .env(tauriEnv)
  .quiet(!verbose)

// ── Locate build outputs ──────────────────────────────────────────
// Match this build's DMG by name. tauri stamps the version into the filename
// and never prunes older ones, so a bumped version in a dirty tree leaves
// several here — and `dmgPath` feeds verification, notarization *and* staple.
// Taking the first glob hit would happily verify and ship a stale DMG.
const tauriConf = await Bun.file(path.join(tauriDir, "tauri.conf.json")).json()
const bundleDir = path.join(tauriDir, "target", tauriTarget, "release/bundle")
const appPath = path.join(bundleDir, "macos", `${tauriConf.productName}.app`)
const dmgPrefix = `${tauriConf.productName}_${tauriConf.version}_`
const dmgGlob = new Bun.Glob("*.dmg")
const dmgFiles = Array.from(dmgGlob.scanSync(path.join(bundleDir, "dmg"))).filter((f) =>
  path.basename(f).startsWith(dmgPrefix),
)
if (dmgFiles.length > 1) {
  console.error(`❌ ${dmgFiles.length} DMGs match ${dmgPrefix}*: ${dmgFiles.join(", ")}`)
  console.error("   Cannot tell which one this build produced. Clean bundle/dmg/ and rebuild.")
  process.exit(1)
}
const dmgPath = dmgFiles.length > 0 ? path.join(bundleDir, "dmg", dmgFiles[0]) : null

console.log(`\n✅ Build complete`)
console.log(`   .app: ${appPath}`)
if (dmgPath) console.log(`   .dmg: ${dmgPath}`)

// Guard the install-window layout before spending minutes on notarization.
if (dmgPath) {
  console.log("\n🔍 Verifying DMG icon layout...")
  const check = await $`bun run --bun ${path.join(rootDir, "scripts/verify-dmg-layout.ts")} ${dmgPath}`.nothrow()
  if (check.exitCode !== 0) {
    if (!allowBadDmgLayout) process.exit(check.exitCode)
    console.warn("⚠️  --allow-bad-dmg-layout: shipping a DMG whose install window is mislaid.")
  }
}

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
