#!/usr/bin/env bun
/**
 * Cross-platform one-click setup (macOS / Windows / Linux).
 *
 * Shared implementation for `bun run setup` and the setup.sh compatibility entry.
 * Usage: bun run scripts/setup.ts [--dev | --build] [--force-build] [brand options]
 *   --dev          : setup + start dev server (default)
 *   --build        : setup + build release package
 *   --force-build  : force-rebuild all sidecars (skip incremental cache)
 */
import { $ } from "bun"
import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { absoluteBrandArgs, parseBrandArgs, resolveBrandBuild, validateArguments } from "./brand-build"
import { acquireBuildLock } from "./build-lock"
import { brandArtifactDirectory } from "./brand-artifacts"
import { ensureVendorPatches } from "./vendor-patches"
import { frozenInstallEnvironment } from "./vendor-dependencies"

const rootDir = path.resolve(import.meta.dir, "..")
const vendorDir = path.join(rootDir, "vendor", "opencode")
const binariesDir = path.join(rootDir, "packages", "client", "desktop", "src-tauri", "binaries")

const inputArgs = process.argv.slice(2)
const parsedBrand = parseBrandArgs(inputArgs)
const resolvedBrandArgs = absoluteBrandArgs(parsedBrand.brand)
validateArguments(parsedBrand.rest, ["--dev", "--build", "--force-build"])
const brand = resolveBrandBuild(resolvedBrandArgs) // fail before downloads or dependency installation
const argv = parsedBrand.rest
if (argv.includes("--dev") && argv.includes("--build")) throw new Error("Choose --dev or --build")
const rootLock = path.join(rootDir, "bun.lock")
if (!existsSync(rootLock) || !readFileSync(rootLock, "utf8").trim()) throw new Error("Missing or empty root bun.lock. Restore the tracked lockfile before setup; frozen setup never creates one.")
const lease = acquireBuildLock(rootDir)
process.env.ULTRAWORK_BUILD_LOCK_TOKEN = lease.token
process.on("exit", () => lease.release())
const brandArgs = Object.entries(resolvedBrandArgs).flatMap(([key, value]) => {
  const flag = ({ file: "--brand", brandId: "--brand-id", productName: "--name", icon: "--icon", uiLogo: "--ui-logo", trayIcon: "--tray-icon" } as Record<string, string>)[key]
  return [flag, value]
})
const mode = argv.find((a) => a === "--dev" || a === "--build") ?? "--dev"
const force = argv.includes("--force-build") ? "--force" : ""

console.log("========================================")
console.log("  Ultrawork Setup")
console.log("========================================")

// ── 1. Prerequisites ───────────────────────────────────────────────
function requireCmd(cmd: string, hint: string) {
  if (!Bun.which(cmd)) {
    console.error(`ERROR: ${cmd} is not installed.\n  ${hint}`)
    process.exit(1)
  }
}
requireCmd("bun", "Install: https://bun.sh")
requireCmd("cargo", "Install: https://rustup.rs")

// On Apple Silicon the Universal DMG build needs the x86_64 Rust target too.
if (process.platform === "darwin" && process.arch === "arm64" && Bun.which("rustup")) {
  const installed = await $`rustup target list --installed`.nothrow().text()
  if (!installed.split("\n").includes("x86_64-apple-darwin")) {
    console.log("  Installing Rust target x86_64-apple-darwin (Universal DMG)...")
    await $`rustup target add x86_64-apple-darwin`.nothrow()
  }
}
console.log("[1/6] Prerequisites OK (bun, cargo)")

// ── 2. Submodules ──────────────────────────────────────────────────
if (!existsSync(path.join(vendorDir, "packages"))) {
  console.log("[2/6] Initializing git submodules...")
  await $`git submodule update --init --recursive`.cwd(rootDir)
} else {
  console.log("[2/6] Submodules already initialized")
}

// ── 3. Apply vendor patches ────────────────────────────────────────
console.log("[3/6] Applying vendor patches...")
await ensureVendorPatches(rootDir)

// ── 4. Dependencies ────────────────────────────────────────────────
console.log("[4/6] Installing dependencies...")
await $`bun install --frozen-lockfile`.env(frozenInstallEnvironment()).cwd(rootDir)
console.log("  Installing vendor/opencode dependencies...")
await $`bun run --bun ${path.join(rootDir, "scripts/vendor-dependencies.ts")}`.cwd(rootDir)

// ── 5. Sidecar binaries ────────────────────────────────────────────
console.log("[5/6] Building sidecar binaries...")
await $`mkdir -p ${binariesDir}`
for (const [label, script] of [
  ["OpenCode server", "build:opencode"],
  ["Channel Gateway", "build:gateway"],
  ["Knowledge Sidecar", "build:knowledge"],
  ["ACP Client", "build:acp"],
] as const) {
  console.log(`  Building ${label}...`)
  if (force) await $`bun run ${script} ${force}`.cwd(rootDir)
  else await $`bun run ${script}`.cwd(rootDir)
}
console.log("  Sidecar binaries ready in src-tauri/binaries/")

// Port conflicts must never cause setup to kill another brand or a user process.

// ── 6. Dev / Build ─────────────────────────────────────────────────
if (mode === "--dev") {
  console.log("[6/6] Starting dev server...\n")
  console.log("  Frontend:  http://localhost:1420")
  console.log("  OpenCode:  http://localhost:4096")
  console.log("  Gateway:   http://localhost:4097")
  console.log("  Knowledge: http://localhost:4098")
  console.log("  ACP:       http://localhost:4099\n")
  await $`bun run tauri:dev ${brandArgs}`.cwd(rootDir)
} else if (mode === "--build") {
  console.log("[6/6] Building release package...")
  await $`bun run tauri:build ${brandArgs}`.cwd(rootDir)
  console.log(`\nBuild complete! Installers and manifest: ${brandArtifactDirectory(rootDir, brand.identity.brandId)}`)
} else {
  console.log("[6/6] Setup complete!\n")
  console.log("Next steps:")
  console.log("  bun run tauri:dev    # Start dev server")
  console.log("  bun run tauri:build  # Build release package")
}
