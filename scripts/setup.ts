#!/usr/bin/env bun
/**
 * Cross-platform one-click setup (macOS / Windows / Linux).
 *
 * Mirrors setup.sh but uses Bun APIs so it runs natively on Windows (no bash).
 * Usage: bun run scripts/setup.ts [--dev | --build] [--force-build]
 *   --dev          : setup + start dev server (default)
 *   --build        : setup + build release package
 *   --force-build  : force-rebuild all sidecars (skip incremental cache)
 */
import { $ } from "bun"
import path from "node:path"
import { existsSync } from "node:fs"

const rootDir = path.resolve(import.meta.dir, "..")
const vendorDir = path.join(rootDir, "vendor", "opencode")
const patchDir = path.join(rootDir, "patches")
const binariesDir = path.join(rootDir, "packages", "client", "desktop", "src-tauri", "binaries")

const argv = process.argv.slice(2)
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
  await $`git submodule update --init --recursive`
} else {
  console.log("[2/6] Submodules already initialized")
}

// ── 3. Apply vendor patches ────────────────────────────────────────
if (existsSync(patchDir)) {
  console.log("[3/6] Applying vendor patches...")
  const glob = new Bun.Glob("vendor-opencode-*.patch")
  for (const name of glob.scanSync(patchDir)) {
    const patch = path.join(patchDir, name)
    // .quiet() suppresses git's noisy "patch failed" probe output (the patch is
    // usually already applied — vendor/opencode ships as "modified content").
    const fwd = await $`git -C ${vendorDir} apply --check ${patch}`.nothrow().quiet()
    if (fwd.exitCode === 0) {
      await $`git -C ${vendorDir} apply ${patch}`
      console.log(`  Applied: ${name}`)
    } else {
      // Distinguish "already applied" (reverse-applies cleanly) from a real conflict.
      const rev = await $`git -C ${vendorDir} apply --reverse --check ${patch}`.nothrow().quiet()
      if (rev.exitCode === 0) {
        console.log(`  Already applied: ${name}`)
      } else {
        console.log(`  ⚠️  Conflict — ${name} neither applies nor reverses cleanly (vendor may need re-patch)`)
      }
    }
  }
} else {
  console.log("[3/6] No patches to apply")
}

// ── 4. Dependencies ────────────────────────────────────────────────
console.log("[4/6] Installing dependencies...")
await $`bun install`.cwd(rootDir)
console.log("  Installing vendor/opencode dependencies...")
await $`bun install`.cwd(vendorDir)

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

// ── 6. Dev / Build ─────────────────────────────────────────────────
if (mode === "--dev") {
  console.log("[6/6] Starting dev server...\n")
  console.log("  Frontend:  http://localhost:1420")
  console.log("  OpenCode:  http://localhost:4096")
  console.log("  Gateway:   http://localhost:4097")
  console.log("  Knowledge: http://localhost:4098")
  console.log("  ACP:       http://localhost:4099\n")
  await $`bun run tauri:dev`.cwd(rootDir)
} else if (mode === "--build") {
  console.log("[6/6] Building release package...")
  await $`bun run tauri:build`.cwd(rootDir)
  console.log("\nBuild complete! Check packages/client/desktop/src-tauri/target/release/bundle/")
} else {
  console.log("[6/6] Setup complete!\n")
  console.log("Next steps:")
  console.log("  bun run tauri:dev    # Start dev server")
  console.log("  bun run tauri:build  # Build release package")
}
