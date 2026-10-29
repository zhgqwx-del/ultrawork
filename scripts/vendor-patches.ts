/** Apply the tracked cumulative vendor patches before resolving dependencies. */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

export function ensureVendorPatches(rootDir: string): void {
  const patchDir = path.join(rootDir, "patches")
  const canonical = path.join(patchDir, "vendor-opencode-config-fix.patch")
  if (!existsSync(canonical) || !statSync(canonical).isFile()) throw new Error(`Missing canonical vendor patch: ${canonical}. Restore the tracked patch before installing or building.`)
  const vendorDir = path.join(rootDir, "vendor", "opencode")
  // Ask Git whether cwd is a worktree root instead of comparing its absolute
  // path with Bun's realpath: Windows may return an 8.3 alias in one and the
  // long path in the other, even though both name the same directory.
  const location = spawnSync("git", ["rev-parse", "--is-inside-work-tree", "--show-prefix"], { cwd: vendorDir, encoding: "utf8", windowsHide: true })
  const [insideWorktree, prefix] = location.stdout?.split(/\r?\n/) ?? []
  const isVendorWorktree = location.status === 0 && insideWorktree === "true" && prefix === ""
  // git apply called from a plain folder inside a parent repo can filter every
  // file away yet return success, even for --check and --reverse --check.
  if (!isVendorWorktree) throw new Error(`vendor/opencode must be its own initialized Git working tree: ${vendorDir}. Run git submodule update --init --recursive; a parent repository or source archive is insufficient.`)
  const patches = [canonical, ...readdirSync(patchDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== path.basename(canonical) && /^vendor-opencode-.*\.patch$/.test(entry.name))
    .map((entry) => path.join(patchDir, entry.name))].sort()
  const git = (args: string[]) => spawnSync("git", ["apply", ...args], { cwd: vendorDir, encoding: "utf8", windowsHide: true })
  const plans: { patch: string; includes: string[] }[] = []
  const seen = new Set<string>()
  for (const patch of patches) {
    const stat = git(["--numstat", "-z", "--", patch])
    if (stat.status !== 0) throw new Error(`Cannot inspect vendor patch ${path.basename(patch)}: ${stat.stderr || stat.error || "git failed"}`)
    const rows = stat.stdout.split("\0").filter(Boolean)
    if (!rows.length) throw new Error(`Vendor patch is empty: ${patch}`)
    const pending: string[] = []
    for (const row of rows) {
      // -z emits unquoted UTF-8 names, including spaces, tabs and non-ASCII.
      // Rename patches use additional NUL fields and are deliberately rejected;
      // the project's cumulative patch consists of edits/additions/deletions.
      const match = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/s.exec(row)
      if (!match) throw new Error(`Unsupported rename or malformed filename in vendor patch ${path.basename(patch)}`)
      const file = match[1]!
      if (seen.has(file)) throw new Error(`Vendor patches overlap at ${file}; consolidate changes into the existing cumulative patch`)
      seen.add(file)
      // git apply --include is a wildcard pattern, not a literal pathspec.
      const include = `--include=${file.replace(/[\\*?[\]]/g, "\\$&")}`
      if (git(["--check", include, "--", patch]).status === 0) pending.push(include)
      else {
        const reverse = git(["--reverse", "--check", include, "--", patch])
        if (reverse.status !== 0) throw new Error(`Vendor patch conflict in ${file} (${path.basename(patch)}). No pending patches were applied; resolve this file explicitly before installing dependencies. ${reverse.stderr || reverse.error || ""}`)
      }
    }
    plans.push({ patch, includes: pending })
  }
  // Inspect every file first. A conflict must not leave unrelated pending files
  // patched. A single cumulative patch is applied in one atomic git operation.
  for (const plan of plans) {
    if (!plan.includes.length) {
      console.log(`[vendor] Already applied: ${path.basename(plan.patch)}`)
      continue
    }
    const applied = git([...plan.includes, "--", plan.patch])
    if (applied.status !== 0) throw new Error(`Vendor patch application failed: ${path.basename(plan.patch)}. ${applied.stderr || applied.error || ""}`)
    const verified = git(["--reverse", "--check", "--", plan.patch])
    if (verified.status !== 0) throw new Error(`Vendor patch verification failed: ${path.basename(plan.patch)}. ${verified.stderr || verified.error || ""}`)
    console.log(`[vendor] Applied ${plan.includes.length} pending file(s): ${path.basename(plan.patch)}`)
  }
}
