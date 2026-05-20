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
