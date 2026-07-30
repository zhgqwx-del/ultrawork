#!/usr/bin/env bun
/**
 * Shared utility for sidecar incremental builds.
 * Computes a content hash of source files + package.json to determine
 * whether a rebuild is needed.
 */
import path from "path"
import { Glob } from "bun"

/**
 * Compute a SHA-256 hash over all matching files in a directory.
 * Files are sorted by relative path for deterministic ordering.
 *
 * @param extraDirs - additional directories to scan (e.g. workspace dependencies)
 */
export async function computeSourceHash(
  dir: string,
  globs: string[],
  extraFiles: string[] = [],
  extraDirs: { dir: string; globs: string[] }[] = [],
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")

  // Collect all matching file paths
  const files: string[] = [...extraFiles]

  const scanDir = async (scanRoot: string, patterns: string[]) => {
    for (const pattern of patterns) {
      const glob = new Glob(pattern)
      for await (const relPath of glob.scan({ cwd: scanRoot, absolute: false })) {
        files.push(path.join(scanRoot, relPath))
      }
    }
  }

  await scanDir(dir, globs)
  for (const extra of extraDirs) {
    await scanDir(extra.dir, extra.globs)
  }

  // Sort for deterministic hash
  files.sort()

  for (const filePath of files) {
    const file = Bun.file(filePath)
    if (await file.exists()) {
      hasher.update(filePath) // include path so renames are detected
      hasher.update(await file.arrayBuffer())
    }
  }

  return hasher.digest("hex")
}

/**
 * Resolve a package's `workspace:*` dependencies — TRANSITIVELY — to their source
 * directories, shaped for `computeSourceHash`'s `extraDirs`.
 *
 * Why this exists: the sidecars are bundled with `bun build --compile`, so a change
 * in `packages/core/*` lands in the binary. But every build script hashed only its
 * OWN `src/`, so editing a dependency left the cache reporting "up-to-date" and the
 * stale binary in place. That is worse than a slow build — a local verification run
 * silently exercises the old code.
 *
 * Transitive matters: gateway depends on connector, connector depends on api-client.
 * A direct-only walk would miss an api-client edit for anything that reaches it
 * indirectly.
 *
 * Derived from package.json rather than hand-listed so a newly added dependency is
 * covered automatically — a hand-written list is exactly what drifted here before.
 */
export async function workspaceDepDirs(
  pkgDir: string,
  rootDir: string,
  globs: string[] = ["src/**/*.ts", "package.json"],
): Promise<{ dir: string; globs: string[] }[]> {
  const byName = new Map<string, string>()
  const pkgGlob = new Glob("packages/*/*/package.json")
  for await (const rel of pkgGlob.scan({ cwd: rootDir, absolute: false })) {
    const full = path.join(rootDir, rel)
    try {
      const pkg = (await Bun.file(full).json()) as { name?: string }
      if (pkg.name) byName.set(pkg.name, path.dirname(full))
    } catch {
      // an unreadable package.json simply doesn't participate
    }
  }

  const seen = new Set<string>()
  const out: { dir: string; globs: string[] }[] = []
  const visit = async (dir: string): Promise<void> => {
    let pkg: { dependencies?: Record<string, string> }
    try {
      pkg = (await Bun.file(path.join(dir, "package.json")).json()) as typeof pkg
    } catch {
      return
    }
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      if (!String(spec).startsWith("workspace:")) continue
      const depDir = byName.get(name)
      if (!depDir || seen.has(depDir)) continue // `seen` also breaks dependency cycles
      seen.add(depDir)
      out.push({ dir: depDir, globs })
      await visit(depDir)
    }
  }
  await visit(pkgDir)
  return out
}

/**
 * Check if a rebuild is needed by comparing current source hash
 * against a stored hash file next to the binary.
 *
 * @returns `true` if rebuild is needed, `false` if binary is up-to-date
 */
export async function needsRebuild(
  hashFilePath: string,
  currentHash: string,
  binaryPath: string,
): Promise<boolean> {
  // Binary must exist
  if (!await Bun.file(binaryPath).exists()) return true

  // Hash file must exist and match
  const hashFile = Bun.file(hashFilePath)
  if (!await hashFile.exists()) return true

  const storedHash = (await hashFile.text()).trim()
  return storedHash !== currentHash
}

/**
 * Save the hash to disk after a successful build.
 */
export async function saveHash(hashFilePath: string, hash: string): Promise<void> {
  await Bun.write(hashFilePath, hash + "\n")
}
