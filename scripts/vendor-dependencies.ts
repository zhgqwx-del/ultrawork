#!/usr/bin/env bun
/** Frozen vendor installation shared by setup, CI and OpenCode builds. */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { ensureVendorPatches } from "./vendor-patches"

export const FROZEN_VENDOR_INSTALL_ARGS = ["install", "--frozen-lockfile", "--os=*", "--cpu=*"] as const

/** Bun's internal skip overrides take precedence over --frozen-lockfile. */
export function frozenInstallEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent }
  const overrides = new Set(["BUN_CONFIG_SKIP_LOAD_LOCKFILE", "BUN_CONFIG_SKIP_INSTALL_PACKAGES", "BUN_CONFIG_SKIP_SAVE_LOCKFILE"])
  for (const key of Object.keys(env)) if (overrides.has(key.toUpperCase())) delete env[key]
  return env
}

/** Capture every manifest/config/patch that can affect this workspace install. */
export function captureVendorDependencies(vendorDir: string): { digest: string; lockSha256: string; assertUnchanged(operation: string): void } {
  const lock = path.join(vendorDir, "bun.lock")
  if (!existsSync(lock) || !readFileSync(lock, "utf8").trim()) {
    throw new Error(`Missing or empty vendor bun.lock: ${lock}. Initialize vendor/opencode and restore its tracked lockfile; frozen builds never create one.`)
  }
  const rootManifest = path.join(vendorDir, "package.json")
  const manifest = JSON.parse(readFileSync(rootManifest, "utf8")) as {
    workspaces?: string[] | { packages?: string[] }
    patchedDependencies?: Record<string, string>
  }
  const files = new Set(["bun.lock", "package.json"])
  const workspacePatterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? []
  for (const pattern of workspacePatterns) {
    for (const file of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: vendorDir, onlyFiles: true, followSymlinks: false })) files.add(file)
  }
  for (const file of [...files].filter((file) => path.basename(file) === "package.json")) {
    for (const name of ["bunfig.toml", ".npmrc"]) {
      const config = path.join(path.dirname(file), name)
      if (existsSync(path.join(vendorDir, config))) files.add(config)
    }
  }
  for (const patch of Object.values(manifest.patchedDependencies ?? {})) {
    const resolved = path.resolve(vendorDir, patch)
    const relative = path.relative(vendorDir, resolved)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Vendor dependency patch must be inside vendor/opencode: ${patch}`)
    files.add(relative)
  }
  const hash = createHash("sha256")
  for (const file of [...files].sort()) {
    // Normalize only hash labels, never actual filesystem paths.
    hash.update(file.replaceAll("\\", "/"))
    hash.update("\0")
    hash.update(readFileSync(path.join(vendorDir, file)))
    hash.update("\0")
  }
  const digest = hash.digest("hex")
  const lockSha256 = createHash("sha256").update(readFileSync(lock)).digest("hex")
  return {
    digest,
    lockSha256,
    assertUnchanged(operation) {
      let current: ReturnType<typeof captureVendorDependencies>
      try { current = captureVendorDependencies(vendorDir) } catch (error) {
        throw new Error(`Vendor dependency inputs changed during ${operation}; no build cache or metadata will be saved. Restore or review the files explicitly.`, { cause: error })
      }
      if (current.digest !== digest) throw new Error(`Vendor dependency inputs changed during ${operation}; no build cache or metadata will be saved. Files are left untouched for review.`)
    },
  }
}

type InstallRunner = (command: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>
const runInstall: InstallRunner = async (command, options) => {
  const child = Bun.spawn([...command], { ...options, stdout: "inherit", stderr: "inherit" })
  return child.exited
}

export async function installVendorDependencies(vendorDir: string, options: { env?: NodeJS.ProcessEnv; run?: InstallRunner } = {}): Promise<void> {
  const state = captureVendorDependencies(vendorDir)
  let code: number
  try {
    code = await (options.run ?? runInstall)([process.execPath, ...FROZEN_VENDOR_INSTALL_ARGS], { cwd: vendorDir, env: frozenInstallEnvironment(options.env) })
  } finally {
    state.assertUnchanged("frozen dependency installation")
  }
  if (code !== 0) throw new Error(`Frozen vendor dependency installation failed (exit ${code}). Resolve the manifest/lockfile or dependency download error; the build was not started.`)
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Usage: bun run --bun scripts/vendor-dependencies.ts")
  const rootDir = path.resolve(import.meta.dir, "..")
  ensureVendorPatches(rootDir)
  await installVendorDependencies(path.join(rootDir, "vendor", "opencode"))
}
