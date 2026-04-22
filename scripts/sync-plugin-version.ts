#!/usr/bin/env bun
/**
 * Syncs PINNED_PLUGIN_VERSION in vendor/opencode config.ts to match the
 * current vendor opencode version, then regenerates the patch file.
 *
 * The patch file covers ALL vendor modifications:
 *   - config.ts: PINNED_PLUGIN_VERSION + config.json→opencode.json fix +
 *                OPENCODE_APP_NAME (managed dir + endsWith filter)
 *   - paths.ts:  OPENCODE_APP_NAME (skip home dir search)
 *   - global/index.ts: OPENCODE_APP_NAME (app name configurable)
 *
 * Run after updating vendor/opencode submodule:
 *   bun run scripts/sync-plugin-version.ts
 */
import { $ } from "bun"
import path from "path"

const rootDir = path.resolve(import.meta.dir, "..")
const vendorDir = path.join(rootDir, "vendor/opencode")
const opencodeDir = path.join(vendorDir, "packages/opencode")
const configFile = path.join(opencodeDir, "src/config/config.ts")
const patchFile = path.join(rootDir, "patches/vendor-opencode-config-fix.patch")

// Files covered by the vendor patch
const PATCHED_FILES = [
  "packages/opencode/src/config/config.ts",
  "packages/opencode/src/config/paths.ts",
  "packages/opencode/src/global/index.ts",
]

// Read vendor opencode version
const pkgJson = await Bun.file(path.join(opencodeDir, "package.json")).json()
const newVersion: string = pkgJson.version
if (!newVersion) {
  console.error("❌ Could not read version from vendor/opencode/packages/opencode/package.json")
  process.exit(1)
}

// Verify the version exists on npm
console.log(`Checking @opencode-ai/plugin@${newVersion} on npm...`)
const res = await fetch(`https://registry.npmjs.org/@opencode-ai/plugin/${newVersion}`)
if (!res.ok) {
  console.error(`❌ @opencode-ai/plugin@${newVersion} not found on npm (status ${res.status})`)
  console.error(`   Check https://registry.npmjs.org/@opencode-ai/plugin for available versions`)
  process.exit(1)
}
console.log(`✅ @opencode-ai/plugin@${newVersion} exists on npm`)

// Read config.ts and find current pinned version.
// If the patch hasn't been applied yet (e.g. after git submodule update --remote),
// apply it first so all vendor fixes are present before we update the version.
let src = await Bun.file(configFile).text()
let match = src.match(/const PINNED_PLUGIN_VERSION = "([^"]+)"/)
if (!match) {
  console.log("PINNED_PLUGIN_VERSION not found — applying existing patch first...")
  const applyResult = await $`cd ${vendorDir} && git apply ${patchFile}`.nothrow()
  if (applyResult.exitCode !== 0) {
    console.error("❌ Failed to apply patch. Check patches/vendor-opencode-config-fix.patch")
    process.exit(1)
  }
  src = await Bun.file(configFile).text()
  match = src.match(/const PINNED_PLUGIN_VERSION = "([^"]+)"/)
  if (!match) {
    console.error("❌ Could not find PINNED_PLUGIN_VERSION in config.ts even after applying patch")
    process.exit(1)
  }
}
const currentVersion = match[1]

if (currentVersion === newVersion) {
  console.log(`ℹ️  PINNED_PLUGIN_VERSION is already ${newVersion}, nothing to do`)
  process.exit(0)
}

// Update config.ts
const updated = src.replace(
  `const PINNED_PLUGIN_VERSION = "${currentVersion}"`,
  `const PINNED_PLUGIN_VERSION = "${newVersion}"`
)
await Bun.write(configFile, updated)
console.log(`Updated PINNED_PLUGIN_VERSION: ${currentVersion} → ${newVersion}`)

// Regenerate patch file (all patched vendor files)
await $`cd ${vendorDir} && git diff -- ${PATCHED_FILES.join(" ")} > ${patchFile}`
console.log(`✅ Patch file updated: patches/vendor-opencode-config-fix.patch`)
console.log(`\nNext: rebuild the sidecar with: bun run build:opencode`)
