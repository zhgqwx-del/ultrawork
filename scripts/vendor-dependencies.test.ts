import { afterEach, expect, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { captureVendorDependencies, FROZEN_VENDOR_INSTALL_ARGS, frozenInstallEnvironment, installVendorDependencies } from "./vendor-dependencies"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "uw-frozen-vendor-")))
  roots.push(root)
  const vendor = path.join(root, "vendor", "opencode")
  mkdirSync(vendor, { recursive: true })
  writeFileSync(path.join(vendor, "package.json"), JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }))
  writeFileSync(path.join(vendor, "bun.lock"), '{"lockfileVersion": 1}\n')
  return { root, vendor }
}

test("frozen installer rejects missing/empty lockfiles before any command", async () => {
  const f = fixture()
  let calls = 0
  for (const value of [null, " \n\t"]) {
    if (value === null) rmSync(path.join(f.vendor, "bun.lock"))
    else writeFileSync(path.join(f.vendor, "bun.lock"), value)
    await expect(installVendorDependencies(f.vendor, { run: async () => { calls++; return 0 } })).rejects.toThrow("Missing or empty vendor bun.lock")
  }
  expect(calls).toBe(0)
})

test("installer requests every optional target without dependency mutation args", async () => {
  const f = fixture()
  const env = { FIXTURE: "only" }
  await installVendorDependencies(f.vendor, { env, run: async (command, options) => {
    expect(command).toEqual([process.execPath, "install", "--frozen-lockfile", "--os=*", "--cpu=*"])
    expect(options).toEqual({ cwd: f.vendor, env })
    return 0
  } })
})

test("install failure propagates and changed lockfiles are left intact for review", async () => {
  const f = fixture()
  await expect(installVendorDependencies(f.vendor, { run: async () => 19 })).rejects.toThrow("exit 19")
  const changed = '{"changed":true}\n'
  await expect(installVendorDependencies(f.vendor, { run: async () => { writeFileSync(path.join(f.vendor, "bun.lock"), changed); return 0 } })).rejects.toThrow("inputs changed")
  expect(readFileSync(path.join(f.vendor, "bun.lock"), "utf8")).toBe(changed)
})

test("dependency digest catches workspace manifests, optional configuration and patch changes", () => {
  const f = fixture()
  const folder = path.join(f.vendor, "packages", "app")
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, "package.json"), '{"name":"fixture-app","version":"1.0.0"}')
  writeFileSync(path.join(f.vendor, "package.json"), JSON.stringify({ name: "fixture", workspaces: { packages: ["packages/*"] }, patchedDependencies: { "a@1.0.0": "patches/a.patch" } }))
  mkdirSync(path.join(f.vendor, "patches"))
  writeFileSync(path.join(f.vendor, "patches", "a.patch"), "patch-v1")
  const first = captureVendorDependencies(f.vendor)
  for (const [file, value] of [["packages/app/package.json", '{"name":"fixture-app","version":"2.0.0"}'], ["packages/app/bunfig.toml", "[install]\noptional = false"], ["patches/a.patch", "patch-v2"], ["bun.lock", '{"lockfileVersion": 2}']]) {
    const before = captureVendorDependencies(f.vendor)
    writeFileSync(path.join(f.vendor, file!), value!)
    expect(captureVendorDependencies(f.vendor).digest).not.toBe(before.digest)
    expect(() => before.assertUnchanged("fixture compilation")).toThrow("inputs changed")
  }
  expect(captureVendorDependencies(f.vendor).lockSha256).not.toBe(first.lockSha256)
})

function bun(command: string[], cwd: string) {
  return spawnSync(process.execPath, command, { cwd, env: { ...frozenInstallEnvironment(), BUN_INSTALL_CACHE_DIR: path.join(cwd, ".fixture-cache") }, encoding: "utf8", timeout: 20_000 })
}

test("Bun skip environment overrides cannot bypass frozen validation or skip installation", async () => {
  const f = fixture()
  const local = path.join(f.vendor, "local")
  mkdirSync(local)
  writeFileSync(path.join(local, "package.json"), JSON.stringify({ name: "local-fixture", version: "1.0.0" }))
  const manifest = { name: "override-fixture", private: true, dependencies: { "local-fixture": "file:./local" } }
  writeFileSync(path.join(f.vendor, "package.json"), JSON.stringify(manifest))
  rmSync(path.join(f.vendor, "bun.lock"))
  const initial = bun(["install"], f.vendor)
  expect(initial.status, initial.stderr).toBe(0)
  const lock = readFileSync(path.join(f.vendor, "bun.lock"))
  rmSync(path.join(f.vendor, "node_modules"), { recursive: true, force: true })
  const env = { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(f.vendor, ".fixture-cache"), BUN_CONFIG_SKIP_LOAD_LOCKFILE: "false", BUN_CONFIG_SKIP_INSTALL_PACKAGES: "true", BUN_CONFIG_SKIP_SAVE_LOCKFILE: "1", bun_config_skip_load_lockfile: "1" }
  expect(frozenInstallEnvironment(env).BUN_CONFIG_SKIP_LOAD_LOCKFILE).toBeUndefined()
  expect(frozenInstallEnvironment(env).bun_config_skip_load_lockfile).toBeUndefined()
  await installVendorDependencies(f.vendor, { env })
  expect(existsSync(path.join(f.vendor, "node_modules", "local-fixture", "package.json"))).toBe(true)
  expect(readFileSync(path.join(f.vendor, "bun.lock")).equals(lock)).toBe(true)
  expect(env.BUN_CONFIG_SKIP_LOAD_LOCKFILE).toBe("false")
  expect(env.BUN_CONFIG_SKIP_INSTALL_PACKAGES).toBe("true")
  writeFileSync(path.join(f.vendor, "package.json"), JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, second: "file:./local" } }))
  for (const value of ["", "false", "1"]) {
    await expect(installVendorDependencies(f.vendor, { env: { ...env, BUN_CONFIG_SKIP_LOAD_LOCKFILE: value } })).rejects.toThrow("Frozen vendor dependency installation failed")
    expect(readFileSync(path.join(f.vendor, "bun.lock")).equals(lock)).toBe(true)
  }
}, 30_000)

test("real offline frozen install accepts all OS/CPU flags and rejects stale manifests without rewriting lock", async () => {
  const f = fixture()
  const optionalDependencies: Record<string, string> = {}
  for (const [name, os, cpu] of [["fixture-darwin-x64", "darwin", "x64"], ["fixture-windows-x64", "win32", "x64"], ["fixture-linux-arm64", "linux", "arm64"]]) {
    const directory = path.join(f.vendor, "fixtures", name!)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", os: [os], cpu: [cpu] }))
    optionalDependencies[name!] = `file:./fixtures/${name}`
  }
  const manifest = { name: "frozen-offline-fixture", private: true, optionalDependencies }
  writeFileSync(path.join(f.vendor, "package.json"), JSON.stringify(manifest))
  rmSync(path.join(f.vendor, "bun.lock"))
  const initial = bun(["install", "--os=*", "--cpu=*"], f.vendor)
  expect(initial.status, initial.stdout + initial.stderr).toBe(0)
  const lock = readFileSync(path.join(f.vendor, "bun.lock"))
  rmSync(path.join(f.vendor, "node_modules"), { recursive: true, force: true })
  await installVendorDependencies(f.vendor, { env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(f.vendor, ".fixture-cache") } })
  for (const name of Object.keys(optionalDependencies)) expect(existsSync(path.join(f.vendor, "node_modules", name, "package.json"))).toBe(true)
  expect(readFileSync(path.join(f.vendor, "bun.lock")).equals(lock)).toBe(true)
  writeFileSync(path.join(f.vendor, "package.json"), JSON.stringify({ ...manifest, dependencies: { "new-dependency": "file:./fixtures/fixture-darwin-x64" } }))
  const stale = bun([...FROZEN_VENDOR_INSTALL_ARGS], f.vendor)
  expect(stale.status).not.toBe(0)
  expect(stale.stderr).toContain("lockfile is frozen")
  expect(readFileSync(path.join(f.vendor, "bun.lock")).equals(lock)).toBe(true)
}, 30_000)

const unixTest = process.platform === "win32" ? test.skip : test
unixTest("real build wrapper fails before compilation/cache export on stale lock and rejects build-time drift", () => {
  const f = fixture()
  const scripts = path.join(f.root, "scripts")
  mkdirSync(scripts)
  for (const file of ["build-opencode.ts", "build-hash.ts", "sidecar-metadata.ts", "build-probe-env.ts", "vendor-dependencies.ts", "vendor-patches.ts"]) copyFileSync(path.join(import.meta.dir, file), path.join(scripts, file))
  const opencode = path.join(f.vendor, "packages", "opencode")
  mkdirSync(path.join(opencode, "src", "global"), { recursive: true })
  writeFileSync(path.join(opencode, "src", "global", "index.ts"), "// OPENCODE_APP_NAME")
  writeFileSync(path.join(opencode, "package.json"), JSON.stringify({ name: "opencode-fixture", version: "1.0.0", scripts: { build: "bun run fake-build.ts" } }))
  writeFileSync(path.join(opencode, "fake-build.ts"), `import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs'; import path from 'node:path';
    const args=process.argv.slice(2); if(!args.includes('--skip-install')) throw new Error('upstream install was not disabled');
    writeFileSync('build-witness',JSON.stringify(args));
    const target=args.find(x=>x.startsWith('--target='))?.slice(9) || (process.platform+'-'+process.arch);
    const outputTarget=target.replace(/^win32-/,'windows-');
    const out=path.join('dist','opencode-'+outputTarget,'bin'); mkdirSync(out,{recursive:true});writeFileSync(path.join(out,outputTarget.startsWith('windows-')?'opencode.exe':'opencode'),'fixture-binary');
    if(process.env.FIXTURE_LOCK_DRIFT) appendFileSync('../../bun.lock',' ');`)
  rmSync(path.join(f.vendor, "bun.lock"))
  const initial = bun(["install"], f.vendor)
  expect(initial.status, initial.stdout + initial.stderr).toBe(0)
  const git = (args: string[]) => spawnSync("git", args, { cwd: f.vendor, encoding: "utf8" })
  expect(git(["init", "--quiet"]).status).toBe(0)
  expect(git(["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"]).status).toBe(0)
  const patches = path.join(f.root, "patches")
  mkdirSync(patches)
  writeFileSync(path.join(patches, "vendor-opencode-config-fix.patch"), "diff --git a/patch-witness b/patch-witness\nnew file mode 100644\n--- /dev/null\n+++ b/patch-witness\n@@ -0,0 +1 @@\n+fixture patch applied\n")
  const bin = path.join(f.root, "bin")
  mkdirSync(bin)
  const codesign = path.join(bin, "codesign")
  writeFileSync(codesign, '#!/bin/sh\nprintf "called\\n" >> "$FIXTURE_CODESIGN_LOG"\nexit 0\n')
  chmodSync(codesign, 0o755)
  const codesignLog = path.join(f.root, "codesign.log")
  const env = { ...process.env, PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.PATH, BUN_INSTALL_CACHE_DIR: path.join(f.root, ".fixture-cache"), FIXTURE_CODESIGN_LOG: codesignLog }
  const run = (extraEnv = {}, args: string[] = []) => spawnSync(process.execPath, [path.join(scripts, "build-opencode.ts"), ...args], { cwd: f.root, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 20_000 })
  // Successful fixture build proves the real wrapper passes --skip-install.
  const good = run()
  expect(good.status, good.stdout + good.stderr).toBe(0)
  expect(JSON.parse(readFileSync(path.join(opencode, "build-witness"), "utf8"))).toContain("--skip-install")
  const target = process.platform === "darwin" ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin") : (process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu")
  const output = path.join(f.root, "packages", "client", "desktop", "src-tauri", "binaries")
  const hashFile = path.join(output, `.opencode-server-${target}.hash`)
  const metadata = path.join(output, `opencode-server-${target}.metadata.json`)
  const goodHash = readFileSync(hashFile), goodMetadata = readFileSync(metadata)
  const crossTarget = process.platform === "darwin" && process.arch === "x64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  const crossBunTarget = crossTarget.startsWith("aarch64") ? "darwin-arm64" : "darwin-x64"
  const cross = run({}, ["--target", crossTarget])
  expect(cross.status, cross.stdout + cross.stderr).toBe(0)
  expect(JSON.parse(readFileSync(path.join(opencode, "build-witness"), "utf8"))).toEqual([`--target=${crossBunTarget}`, "--skip-install"])
  const previousSigning = existsSync(codesignLog) ? readFileSync(codesignLog, "utf8") : ""
  for (const [crossTriple, bunTarget] of [["x86_64-pc-windows-msvc", "win32-x64"], ["x86_64-unknown-linux-gnu", "linux-x64"], ["aarch64-unknown-linux-gnu", "linux-arm64"]]) {
    const cross = run({}, ["--target", crossTriple!, "--force"])
    expect(cross.status, cross.stdout + cross.stderr).toBe(0)
    expect(JSON.parse(readFileSync(path.join(opencode, "build-witness"), "utf8"))).toEqual([crossTriple === target ? "--single" : `--target=${bunTarget}`, "--skip-install"])
    expect(existsSync(codesignLog) ? readFileSync(codesignLog, "utf8") : "").toBe(previousSigning)
  }
  rmSync(path.join(opencode, "build-witness"))
  const cached = run()
  expect(cached.status, cached.stderr).toBe(0)
  expect(cached.stdout).toContain("up-to-date")
  expect(existsSync(path.join(opencode, "build-witness"))).toBe(false)
  for (const corrupt of [
    () => writeFileSync(metadata, "{"),
    () => writeFileSync(metadata, JSON.stringify({ ...JSON.parse(goodMetadata.toString()), sourceHash: "stale" })),
    () => writeFileSync(metadata.replace(/\.metadata\.json$/, ""), "altered-binary"),
  ]) {
    corrupt()
    const repaired = run()
    expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0)
    expect(existsSync(path.join(opencode, "build-witness"))).toBe(true)
    expect(readFileSync(metadata).equals(goodMetadata)).toBe(true)
    rmSync(path.join(opencode, "build-witness"))
  }
  // A changed workspace manifest must invalidate an otherwise successful cache.
  const pkg = JSON.parse(readFileSync(path.join(opencode, "package.json"), "utf8"))
  writeFileSync(path.join(opencode, "package.json"), JSON.stringify({ ...pkg, dependencies: { missing: "file:./missing" } }))
  const stale = run()
  expect(stale.status).not.toBe(0)
  expect(existsSync(path.join(opencode, "build-witness"))).toBe(false)
  expect(readFileSync(hashFile).equals(goodHash)).toBe(true)
  expect(readFileSync(metadata).equals(goodMetadata)).toBe(true)
  writeFileSync(path.join(opencode, "package.json"), JSON.stringify(pkg))
  const drift = run({ FIXTURE_LOCK_DRIFT: "1" }, ["--force"])
  expect(drift.status).not.toBe(0)
  expect(drift.stderr).toContain("inputs changed during OpenCode compilation")
  expect(readFileSync(hashFile).equals(goodHash)).toBe(true)
  expect(readFileSync(metadata).equals(goodMetadata)).toBe(true)
}, 60_000)
