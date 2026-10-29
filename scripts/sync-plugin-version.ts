#!/usr/bin/env bun
/** Update PINNED_PLUGIN_VERSION without dropping any cumulative vendor fixes. */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { ensureVendorPatches } from "./vendor-patches"

function git(vendorDir: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  const result = spawnSync("git", args, {
    cwd: vendorDir, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...options,
  })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error || result.stdout}`)
  return result.stdout
}

function patchFiles(vendorDir: string, patch: string): string[] {
  const rows = git(vendorDir, ["apply", "--numstat", "-z", "--", "-"], { input: patch }).split("\0").filter(Boolean)
  const files = rows.map((row) => {
    const match = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/s.exec(row)
    if (!match) throw new Error("Unsupported rename or malformed path in cumulative vendor patch")
    const file = match[1]!
    const relative = path.relative(vendorDir, path.resolve(vendorDir, file))
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Vendor patch path is outside its working tree: ${file}`)
    return file
  })
  if (!files.length || new Set(files).size !== files.length) throw new Error("Cumulative vendor patch must contain a nonempty, unique file set")
  return files
}

/** Use a disposable index so additions are included without staging user files. */
export function regenerateVendorPatch(vendorDir: string, patchFile: string): string[] {
  const files = patchFiles(vendorDir, readFileSync(patchFile, "utf8"))
  const temporary = mkdtempSync(path.join(tmpdir(), "uw-vendor-patch-index-"))
  const output = path.join(path.dirname(patchFile), `.${path.basename(patchFile)}.${randomUUID()}.tmp`)
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "index") }
  try {
    git(vendorDir, ["read-tree", "HEAD"], { env })
    const additions = files.filter((file) => {
      const tracked = spawnSync("git", ["cat-file", "-e", `HEAD:${file}`], { cwd: vendorDir, env, encoding: "utf8", windowsHide: true, timeout: 10_000 })
      if (tracked.status === 0) return false
      if (!existsSync(path.join(vendorDir, file))) throw new Error(`Patched new file is missing: ${file}`)
      return true
    })
    if (additions.length) git(vendorDir, ["add", "--intent-to-add", "--", ...additions.map((file) => `:(literal)${file}`)], { env })
    const patch = git(vendorDir, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", "--", ...files.map((file) => `:(literal)${file}`)], { env })
    const generated = patchFiles(vendorDir, patch)
    if (JSON.stringify([...generated].sort()) !== JSON.stringify([...files].sort())) throw new Error("Regenerated vendor patch would drop a previously patched file; original patch was preserved")
    git(vendorDir, ["apply", "--reverse", "--check", "--", "-"], { input: patch })
    writeFileSync(output, patch)
    renameSync(output, patchFile)
    return generated
  } finally {
    rmSync(output, { force: true })
    rmSync(temporary, { recursive: true, force: true })
  }
}

export async function syncPluginVersion(rootDir: string, options: { lookupPluginVersion?: (version: string) => Promise<boolean> } = {}): Promise<void> {
  const vendorDir = path.join(rootDir, "vendor", "opencode")
  const opencodeDir = path.join(vendorDir, "packages", "opencode")
  const configFile = path.join(opencodeDir, "src", "config", "config.ts")
  const patchFile = path.join(rootDir, "patches", "vendor-opencode-config-fix.patch")
  ensureVendorPatches(rootDir)
  const pkg = JSON.parse(readFileSync(path.join(opencodeDir, "package.json"), "utf8"))
  const version = pkg.version
  if (typeof version !== "string" || !version) throw new Error("Could not read the vendor OpenCode version")
  console.log(`Checking @opencode-ai/plugin@${version} on npm...`)
  const available = await (options.lookupPluginVersion ?? (async (value) => (await fetch(`https://registry.npmjs.org/@opencode-ai/plugin/${encodeURIComponent(value)}`)).ok))(version)
  if (!available) throw new Error(`@opencode-ai/plugin@${version} was not found on npm; no version or patch was rewritten`)
  const source = readFileSync(configFile, "utf8")
  const match = source.match(/const PINNED_PLUGIN_VERSION = "([^"]+)"/)
  if (!match) throw new Error("PINNED_PLUGIN_VERSION is missing after applying the cumulative vendor patch")
  if (match[1] === version) {
    console.log(`PINNED_PLUGIN_VERSION is already ${version}; cumulative vendor patches are applied`)
    return
  }
  writeFileSync(configFile, source.replace(match[0], `const PINNED_PLUGIN_VERSION = "${version}"`))
  const files = regenerateVendorPatch(vendorDir, patchFile)
  console.log(`Updated PINNED_PLUGIN_VERSION: ${match[1]} → ${version}; preserved all ${files.length} patched files`)
  console.log("Next: bun run build:opencode")
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Usage: bun run --bun scripts/sync-plugin-version.ts")
  await syncPluginVersion(path.resolve(import.meta.dir, ".."))
}
