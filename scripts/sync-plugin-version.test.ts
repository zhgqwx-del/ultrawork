import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { regenerateVendorPatch, syncPluginVersion } from "./sync-plugin-version"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(version = "2.0.0") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "uw-sync-plugin-")))
  roots.push(root)
  const vendor = path.join(root, "vendor", "opencode")
  mkdirSync(vendor, { recursive: true })
  mkdirSync(path.join(root, "patches"))
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig") }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: vendor, env, encoding: "utf8", windowsHide: true })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }
  const config = "packages/opencode/src/config/config.ts"
  const source = "packages/源码 [1]/extra-fix.ts"
  const addition = "packages/opencode/src/new-fix.ts"
  const deletion = "packages/app/deleted-by-patch.txt"
  const before = new Map([
    [config, 'export const upstream = true\n'],
    [source, "export const value = 'upstream'\n"],
    ["packages/app/package.json", '{"dependencies":{"ghostty-web":"github:example/ghostty#main"}}\n'],
    ["bun.lock", "original lock main\n"],
    ["packages/app/icon.bin", "binary\0before\n"],
    [deletion, "upstream file removed by the patch\n"],
  ])
  const after = new Map([
    [config, 'const PINNED_PLUGIN_VERSION = "1.0.0"\n'],
    [source, "export const value = 'patched'\n"],
    [addition, "export const added = 'keep this new fix'\n"],
    ["packages/app/package.json", '{"dependencies":{"ghostty-web":"github:example/ghostty#fixed-commit"}}\n'],
    ["bun.lock", "original lock fixed-commit\n"],
    ["packages/app/icon.bin", "binary\0after\n"],
  ])
  const put = (file: string, content: string) => { const output = path.join(vendor, file); mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, content) }
  for (const [file, content] of before) put(file, content)
  put("packages/opencode/package.json", JSON.stringify({ name: "fixture-opencode", version }))
  git(["init", "--quiet"])
  // Keep this fixture's LF byte assertions independent of the user's/system's
  // Git for Windows defaults when the production helper invokes git apply.
  git(["config", "core.autocrlf", "false"])
  git(["add", "--", "."])
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"])
  for (const [file, content] of after) put(file, content)
  rmSync(path.join(vendor, deletion))
  git(["add", "--intent-to-add", "--", addition])
  const patch = path.join(root, "patches", "vendor-opencode-config-fix.patch")
  writeFileSync(patch, git(["diff", "--binary", "--no-ext-diff"]))
  git(["rm", "--cached", "--force", "--", addition])
  for (const [file, content] of before) put(file, content)
  rmSync(path.join(vendor, addition))
  return { root, vendor, patch, git, put, before, after, config, source, addition, deletion }
}

test("version sync preserves every cumulative patch file and new source without staging user work", async () => {
  const f = fixture()
  f.put("user-staged.txt", "user staged change\n")
  f.git(["add", "--", "user-staged.txt"])
  f.put("user-untracked.txt", "user untracked change\n")
  const index = readFileSync(path.join(f.vendor, ".git", "index"))
  await syncPluginVersion(f.root, { lookupPluginVersion: async (version) => version === "2.0.0" })
  expect(readFileSync(path.join(f.vendor, f.config), "utf8")).toContain('PINNED_PLUGIN_VERSION = "2.0.0"')
  for (const [file, content] of f.after) if (file !== f.config) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(content)
  expect(readFileSync(path.join(f.vendor, ".git", "index")).equals(index)).toBe(true)
  const generated = readFileSync(f.patch, "utf8")
  expect(generated).toContain("new file mode")
  expect(generated).toContain("GIT binary patch")
  expect(generated).toContain("fixed-commit")
  expect(generated).not.toContain("user-staged.txt")
  expect(generated).not.toContain("user-untracked.txt")
  expect(existsSync(path.join(f.vendor, f.deletion))).toBe(false)
  f.git(["apply", "--reverse", "--check", "--", f.patch])
  f.git(["apply", "--reverse", "--", f.patch])
  for (const [file, content] of f.before) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(content)
  expect(existsSync(path.join(f.vendor, f.addition))).toBe(false)
  f.git(["apply", "--", f.patch])
  expect(readFileSync(path.join(f.vendor, f.config), "utf8")).toContain('PINNED_PLUGIN_VERSION = "2.0.0"')
  expect(readFileSync(path.join(f.vendor, f.addition), "utf8")).toBe(f.after.get(f.addition)!)
})

test("same plugin version still applies newer manifest and lock fixes in a partial old patch", async () => {
  const f = fixture("1.0.0")
  f.put(f.config, f.after.get(f.config)!)
  const previous = readFileSync(f.patch)
  await syncPluginVersion(f.root, { lookupPluginVersion: async () => true })
  for (const [file, content] of f.after) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(content)
  expect(readFileSync(f.patch).equals(previous)).toBe(true)
})

test("conflicts and failed regeneration preserve the original patch and real Git index", async () => {
  const f = fixture()
  f.put(f.source, "user conflicting source remains\n")
  const previous = readFileSync(f.patch)
  const index = readFileSync(path.join(f.vendor, ".git", "index"))
  await expect(syncPluginVersion(f.root, { lookupPluginVersion: async () => true })).rejects.toThrow("Vendor patch conflict")
  expect(readFileSync(f.patch).equals(previous)).toBe(true)
  expect(readFileSync(path.join(f.vendor, f.source), "utf8")).toBe("user conflicting source remains\n")
  expect(() => regenerateVendorPatch(f.vendor, f.patch)).toThrow("Patched new file is missing")
  expect(readFileSync(f.patch).equals(previous)).toBe(true)
  expect(readFileSync(path.join(f.vendor, ".git", "index")).equals(index)).toBe(true)
})
