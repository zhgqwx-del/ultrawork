import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureVendorPatches } from "./vendor-patches"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "uw-vendor-patches-")))
  roots.push(temporary)
  const root = path.join(temporary, "品牌 checkout")
  const vendor = path.join(root, "vendor", "opencode")
  const patchDir = path.join(root, "patches")
  mkdirSync(vendor, { recursive: true })
  mkdirSync(patchDir)
  // Prevent inherited Git settings, hooks or signing from affecting the fixture.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(temporary, "empty-gitconfig") }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: vendor, env, encoding: "utf8", timeout: 10_000, windowsHide: true })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }
  const before = new Map([
    ["packages/源码 [1]/already-applied.txt", "source before\n"],
    ["packages/app/package.json", '{"name":"fixture","dependency":"floating"}\n'],
    ["bun.lock", "locked before\n"],
  ])
  const after = new Map([
    ["packages/源码 [1]/already-applied.txt", "source patched\n"],
    ["packages/app/package.json", '{"name":"fixture","dependency":"pinned"}\n'],
    ["bun.lock", "locked pinned\n"],
    ["packages/app/new-source.ts", "// new file in the tracked patch\n"],
  ])
  const put = (file: string, value: string) => { const output = path.join(vendor, file); mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, value) }
  for (const [file, value] of before) put(file, value)
  git(["init", "--quiet"])
  git(["add", "--", "."])
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"])
  for (const [file, value] of after) put(file, value)
  git(["add", "--intent-to-add", "--", "packages/app/new-source.ts"])
  const patch = path.join(patchDir, "vendor-opencode-config-fix.patch")
  writeFileSync(patch, git(["diff", "--binary", "--no-ext-diff"]))
  git(["rm", "--cached", "--force", "--", "packages/app/new-source.ts"])
  for (const [file, value] of before) put(file, value)
  rmSync(path.join(vendor, "packages/app/new-source.ts"))
  return { root, vendor, patch, before, after, put }
}

test("shared patch entry applies clean edits/additions and is idempotent", () => {
  const f = fixture()
  f.put("unrelated-user-file", "keep this\n")
  ensureVendorPatches(f.root)
  for (const [file, value] of f.after) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(value)
  ensureVendorPatches(f.root)
  for (const [file, value] of f.after) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(value)
  expect(readFileSync(path.join(f.vendor, "unrelated-user-file"), "utf8")).toBe("keep this\n")
})

test("an already applied source file does not hide later manifest, lock or new-file patches", () => {
  const f = fixture()
  const source = "packages/源码 [1]/already-applied.txt"
  f.put(source, f.after.get(source)!)
  ensureVendorPatches(f.root)
  for (const [file, value] of f.after) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(value)
})

test("a submodule/worktree-style .git file still identifies the correct vendor working tree", () => {
  const f = fixture()
  const gitFile = path.join(f.vendor, ".git")
  const metadata = path.join(path.dirname(f.root), "separate Git metadata")
  renameSync(gitFile, metadata)
  writeFileSync(gitFile, `gitdir: ${path.relative(f.vendor, metadata).replaceAll("\\", "/")}\n`)
  ensureVendorPatches(f.root)
  for (const [file, value] of f.after) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(value)
})

test("all files are checked before any pending file is changed on conflict", () => {
  const f = fixture()
  const conflict = "packages/源码 [1]/already-applied.txt"
  f.put(conflict, "user conflict stays untouched\n")
  expect(() => ensureVendorPatches(f.root)).toThrow("Vendor patch conflict")
  expect(readFileSync(path.join(f.vendor, conflict), "utf8")).toBe("user conflict stays untouched\n")
  for (const file of ["bun.lock", "packages/app/package.json"]) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(f.before.get(file)!)
  expect(existsSync(path.join(f.vendor, "packages/app/new-source.ts"))).toBe(false)
})

test("a source archive nested in a parent Git repository cannot silently skip all patch files", () => {
  const f = fixture()
  rmSync(path.join(f.vendor, ".git"), { recursive: true, force: true })
  const parent = spawnSync("git", ["init", "--quiet"], { cwd: f.root, encoding: "utf8", windowsHide: true })
  expect(parent.status, parent.stderr).toBe(0)
  expect(() => ensureVendorPatches(f.root)).toThrow("must be its own initialized Git working tree")
  for (const [file, value] of f.before) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(value)
  expect(existsSync(path.join(f.vendor, "packages/app/new-source.ts"))).toBe(false)
})

test("missing canonical patch fails instead of building an unpatched vendor", () => {
  const f = fixture()
  rmSync(f.patch)
  expect(() => ensureVendorPatches(f.root)).toThrow("Missing canonical vendor patch")
  for (const [file, value] of f.before) expect(readFileSync(path.join(f.vendor, file), "utf8")).toBe(value)
  expect(existsSync(path.join(f.vendor, "packages/app/new-source.ts"))).toBe(false)
})
