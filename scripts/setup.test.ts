import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { brandArtifactDirectory } from "./brand-artifacts"

const root = path.resolve(import.meta.dir, "..")
const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const unixTest = process.platform === "win32" ? test.skip : test

function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ultrawork-setup-test-")))
  directories.push(directory)
  const checkout = path.join(directory, "checkout")
  const caller = path.join(directory, "调用者 cwd")
  const bin = path.join(directory, "bin")
  for (const folder of [path.join(checkout, "scripts"), path.join(checkout, "vendor/opencode"), path.join(checkout, "patches"), caller, bin]) mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(checkout, "bun.lock"), "{}\n")
  writeFileSync(path.join(checkout, "patches/vendor-opencode-config-fix.patch"), "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n")
  const log = path.join(directory, "commands.jsonl")
  const stub = path.join(directory, "stub.ts")
  writeFileSync(stub, `import { appendFileSync } from "node:fs";
    appendFileSync(process.env.ULTRAWORK_SETUP_TEST_LOG!, JSON.stringify({ command: process.argv[2], args: process.argv.slice(3), cwd: process.cwd() }) + "\\n");
    if (process.argv[2] === "rustup") console.log("x86_64-apple-darwin");
    if (process.argv[2] === "git" && process.argv.includes("--show-toplevel")) console.log(process.cwd());
    if (process.argv[2] === "git" && process.argv.includes("--numstat")) process.stdout.write("1\\t1\\tx.txt\\0");
    process.exit(Number(process.env.ULTRAWORK_SETUP_TEST_EXIT || 0));`)
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  for (const name of ["bun", "cargo", "git", "rustup"]) {
    const file = path.join(bin, name)
    writeFileSync(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(stub)} ${quote(name)} "$@"\n`)
    chmodSync(file, 0o755)
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(directory, "home"), USERPROFILE: path.join(directory, "home"), ULTRAWORK_SETUP_TEST_LOG: log }
  delete env.ULTRAWORK_BUILD_LOCK_TOKEN
  return { checkout, caller, log, env, commands: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { command: string; args: string[]; cwd: string }) : [] }
}

test("artifact directory includes the selected independent brand", () => {
  expect(brandArtifactDirectory("/checkout", "ultrawork", "darwin-arm64")).toBe(path.join("/checkout", ".brand-build/artifacts/ultrawork/darwin-arm64"))
  expect(brandArtifactDirectory("/checkout", "mywork", "win32-x64")).toBe(path.join("/checkout", ".brand-build/artifacts/mywork/win32-x64"))
})

unixTest("shell setup preserves all argv, caller cwd, and child exit status", () => {
  const f = fixture()
  const args = ["--brand", "品牌 配置/brand.json", "--build", "--name", "My Work 美柚", "--icon", "icons/美柚 icon.png", "--force-build", "--unknown-option"]
  const result = spawnSync("/bin/bash", [path.join(root, "setup.sh"), ...args], { cwd: f.caller, env: { ...f.env, ULTRAWORK_SETUP_TEST_EXIT: "29" }, encoding: "utf8" })
  expect(result.status, result.stderr).toBe(29)
  expect(f.commands()).toEqual([{ command: "bun", args: ["run", "--bun", path.join(root, "scripts/setup.ts"), ...args], cwd: f.caller }])
})

function copiedSetup(checkout: string): string {
  // Run the real setup flow against disposable paths. Only parsing/brand/lease
  // modules are real; every external git/bun/cargo command is an inert stub.
  let source = readFileSync(path.join(root, "scripts/setup.ts"), "utf8")
  for (const file of ["brand-build", "build-lock", "brand-artifacts", "vendor-patches", "vendor-dependencies"]) source = source.replace(`from "./${file}"`, `from ${JSON.stringify(pathToFileURL(path.join(root, "scripts", `${file}.ts`)).href)}`)
  const output = path.join(checkout, "scripts/setup.ts")
  writeFileSync(output, source)
  return output
}

unixTest("setup uses its checkout for submodules and retains the default dev mode", () => {
  const f = fixture()
  const result = spawnSync(process.execPath, [copiedSetup(f.checkout)], { cwd: f.caller, env: f.env, encoding: "utf8", timeout: 15_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(f.commands().find((entry) => entry.command === "git")).toEqual({ command: "git", args: ["submodule", "update", "--init", "--recursive"], cwd: f.checkout })
  expect(f.commands().at(-1)).toEqual({ command: "bun", args: ["run", "tauri:dev"], cwd: f.checkout })
  expect(f.commands()).toContainEqual({ command: "bun", args: ["install", "--frozen-lockfile"], cwd: f.checkout })
  expect(f.commands()).toContainEqual({ command: "bun", args: ["run", "--bun", path.join(f.checkout, "scripts/vendor-dependencies.ts")], cwd: f.checkout })
})

unixTest("setup forwards relative brand options and force-build, and reports branded artifacts", () => {
  const f = fixture()
  const brand = path.join(root, "branding/mywork/brand.json")
  const result = spawnSync(process.execPath, [copiedSetup(f.checkout), "--brand", path.relative(f.caller, brand), "--build", "--force-build"], { cwd: f.caller, env: f.env, encoding: "utf8", timeout: 15_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(f.commands().at(-1)).toEqual({ command: "bun", args: ["run", "tauri:build", "--brand", brand], cwd: f.checkout })
  expect(f.commands().filter((entry) => entry.args[1]?.startsWith("build:")).map((entry) => entry.args.at(-1))).toEqual(["--force", "--force", "--force", "--force"])
  expect(result.stdout).toContain(brandArtifactDirectory(f.checkout, "mywork"))
})

unixTest("invalid setup arguments fail before lock acquisition or external commands", () => {
  for (const args of [["--unknown-option"], ["--dev", "--build"]]) {
    const f = fixture()
    const result = spawnSync(process.execPath, [copiedSetup(f.checkout), ...args], { cwd: f.caller, env: f.env, encoding: "utf8", timeout: 15_000 })
    expect(result.status).not.toBe(0)
    expect(f.commands()).toEqual([])
    expect(existsSync(path.join(f.checkout, ".brand-build"))).toBe(false)
  }
})

unixTest("setup rejects missing or empty root locks before installation or build lease", () => {
  for (const content of [undefined, " \n"]) {
    const f = fixture()
    const lock = path.join(f.checkout, "bun.lock")
    if (content === undefined) rmSync(lock)
    else writeFileSync(lock, content)
    const result = spawnSync(process.execPath, [copiedSetup(f.checkout)], { cwd: f.caller, env: f.env, encoding: "utf8", timeout: 15_000 })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Missing or empty root bun.lock")
    expect(f.commands()).toEqual([])
    expect(existsSync(path.join(f.checkout, ".brand-build"))).toBe(false)
  }
})
