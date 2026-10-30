import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { currentTarget, PROJECT_ROOT } from "./brand-build"
import { universalSidecarSourceHash, verifyFreshSidecarsForTarget } from "./sidecar-freshness"
import { SIDECAR_NAMES, verifySidecarFreshness, writeSidecarMetadata } from "./sidecar-metadata"

const temporary: string[] = []
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sidecar-freshness-"))
  temporary.push(root)
  return root
}
function put(file: string, text: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
function binary(root: string, role: string, target: string): string {
  return path.join(root, "packages/client/desktop/src-tauri/binaries", `${role}-${target}${target.includes("windows") ? ".exe" : ""}`)
}
function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true })
  expect(result.status, result.stderr).toBe(0)
}

describe("sidecar freshness", () => {
  test("valid protocol and binary integrity cannot authorize a stale source or cache stamp", () => {
    const root = fixture(), file = path.join(root, "binary"), stamp = path.join(root, "source.hash")
    put(file, "payload")
    writeSidecarMetadata(file, "target", "old-source")
    put(stamp, "old-source\n")
    expect(() => verifySidecarFreshness(file, "target", "current-source", stamp)).toThrow("Stale sidecar source")
    writeSidecarMetadata(file, "target", "current-source")
    expect(() => verifySidecarFreshness(file, "target", "current-source", stamp)).toThrow("Stale sidecar build hash")
    put(stamp, "current-source\n")
    expect(() => verifySidecarFreshness(file, "target", "current-source", stamp)).not.toThrow()
    const metadata = JSON.parse(readFileSync(`${file}.metadata.json`, "utf8"))
    put(`${file}.metadata.json`, JSON.stringify({ ...metadata, sourceHash: {} }))
    expect(() => verifySidecarFreshness(file, "target", "current-source", stamp)).toThrow("Incompatible or changed")
    put(`${file}.metadata.json`, JSON.stringify(metadata))
    rmSync(stamp)
    expect(() => verifySidecarFreshness(file, "target", "current-source", stamp)).toThrow("Missing sidecar build hash")
    put(stamp, "current-source\n")
    put(file, "replaced payload")
    expect(() => verifySidecarFreshness(file, "target", "current-source", stamp)).toThrow("Incompatible or changed")
  })

  for (const [name, role, pkg] of [
    ["acp", "acp-client", "packages/agent/acp-client"],
    ["gateway", "channel-gateway", "packages/channel/gateway"],
    ["knowledge", "knowledge-sidecar", "packages/knowledge/sidecar"],
    ["opencode", "opencode-server", "vendor/opencode/packages/opencode"],
  ]) {
    test(`${name}: real builder --check uses its current hash without compiling, installing or editing`, () => {
      const root = fixture(), scripts = path.join(root, "scripts"), target = currentTarget()
      const source = path.join(root, pkg, "src/index.ts")
      const dep = path.join(root, "packages/core/brand/src/index.ts")
      put(source, "This intentionally invalid TypeScript must never be compiled.\n")
      put(dep, "workspace dependency source v1\n")
      put(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*/*"] }))
      put(path.join(root, "packages/core/brand/package.json"), JSON.stringify({ name: "@agent/brand" }))
      put(path.join(root, pkg, "package.json"), JSON.stringify({ name: "fixture-sidecar", dependencies: { "@agent/brand": "workspace:*" } }))
      put(path.join(root, "bun.lock"), "fixture-root-lock\n")
      mkdirSync(scripts, { recursive: true })
      for (const file of [`build-${name}.ts`, "build-hash.ts", "sidecar-metadata.ts", "build-probe-env.ts", "vendor-dependencies.ts", "vendor-patches.ts"]) {
        copyFileSync(path.join(PROJECT_ROOT, "scripts", file), path.join(scripts, file))
      }
      const compileMarker = path.join(root, "compile-or-install-was-called")
      if (name === "opencode") {
        const vendor = path.join(root, "vendor/opencode")
        put(path.join(vendor, "package.json"), JSON.stringify({ name: "vendor-fixture", workspaces: ["packages/*"], scripts: {
          preinstall: `bun -e ${JSON.stringify(`Bun.write(${JSON.stringify(compileMarker)}, 'installed')`)}`,
        } }))
        put(path.join(vendor, "bun.lock"), "frozen-fixture-lock\n")
        put(path.join(vendor, "packages/opencode/package.json"), JSON.stringify({ name: "fixture-opencode", scripts: { build: "bun run --bun should-not-build.ts" } }))
        put(path.join(vendor, "packages/opencode/should-not-build.ts"), `await Bun.write(${JSON.stringify(compileMarker)}, "compiled"); throw new Error("check mode compiled")`)
        put(path.join(vendor, "README.md"), "before\n")
        git(vendor, ["init", "--quiet"])
        git(vendor, ["add", "."])
        git(vendor, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"])
        put(path.join(vendor, "README.md"), "after\n")
        put(path.join(root, "patches/vendor-opencode-config-fix.patch"), "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n")
      }
      const file = binary(root, role, target)
      const stamp = path.join(path.dirname(file), `.${role}-${target}.hash`)
      put(file, "a previously compiled sidecar")
      const reset = (hash: string) => { writeSidecarMetadata(file, target, hash); put(stamp, hash + "\n") }
      const check = () => spawnSync(process.execPath, ["run", "--bun", path.join(scripts, `build-${name}.ts`), "--target", target, "--check"], {
        cwd: root, env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" }, encoding: "utf8", timeout: 20_000, windowsHide: true,
      })
      reset("old-source")
      const stale = check()
      expect(stale.status).not.toBe(0)
      expect(stale.stderr).toContain("Stale sidecar source")
      const hash = stale.stderr.match(/expected ([a-f0-9]{64})/)?.[1]
      expect(hash).toBeDefined()
      reset(hash!)
      const before = readFileSync(`${file}.metadata.json`, "utf8")
      const fresh = check()
      expect(fresh.status, fresh.stderr).toBe(0)
      expect(fresh.stdout).toContain("freshness verified")
      expect(readFileSync(`${file}.metadata.json`, "utf8")).toBe(before)
      expect(readFileSync(file, "utf8")).toBe("a previously compiled sidecar")
      expect(existsSync(compileMarker)).toBe(false)
      const changed = name === "opencode" ? path.join(root, "patches/vendor-opencode-config-fix.patch") : source
      const previous = readFileSync(changed, "utf8")
      // A valid but changed cumulative patch also changes OpenCode's source hash.
      put(changed, previous + (name === "opencode" ? "\n" : "source v2\n"))
      const sourceChange = check()
      expect(sourceChange.status).not.toBe(0)
      expect(sourceChange.stderr).toContain("Stale sidecar source")
      put(changed, previous)
      const dependency = name === "opencode" ? path.join(root, "vendor/opencode/bun.lock") : dep
      const oldDependency = readFileSync(dependency, "utf8")
      put(dependency, oldDependency + "dependency v2\n")
      expect(check().stderr).toContain("Stale sidecar source")
      put(dependency, oldDependency)
      put(file, "tampered executable")
      expect(check().stderr).toContain("Incompatible or changed")
      put(file, "a previously compiled sidecar")
      put(stamp, "stale-stamp\n")
      expect(check().stderr).toContain("Stale sidecar build hash")
      reset(hash!)
      put(`${file}.metadata.json`, "{ broken json")
      expect(check().stderr).toContain("Missing sidecar metadata")
      reset(hash!)
      expect(check().status).toBe(0)
      expect(existsSync(compileMarker)).toBe(false)
      if (name === "opencode") {
        const vendor = path.join(root, "vendor/opencode")
        put(path.join(vendor, "README.md"), "before\n")
        expect(check().stderr).toContain("Vendor patch is not fully applied")
        expect(readFileSync(path.join(vendor, "README.md"), "utf8")).toBe("before\n")
        expect(existsSync(compileMarker)).toBe(false)
        git(vendor, ["diff", "--cached", "--quiet"])
      }
    }, 30_000)
  }

  test("Universal checks both fresh architectures and derives brand-independent provenance", async () => {
    const root = fixture(), target = "universal-apple-darwin"
    for (const name of SIDECAR_NAMES) for (const arch of ["aarch64-apple-darwin", "x86_64-apple-darwin", target]) {
      const file = binary(root, name, arch)
      put(file, `${name}/${arch}`)
      writeSidecarMetadata(file, arch, arch === target ? "old-brand-digest" : `current-source-${arch}`)
    }
    const calls: string[] = []
    const run = async (script: string, arch: string) => { calls.push(`${script}/${arch}`) }
    await expect(verifyFreshSidecarsForTarget(target, root, run)).rejects.toThrow("Stale sidecar source")
    expect(calls).toHaveLength(8)
    expect(calls.filter((call) => call.includes("aarch64"))).toHaveLength(4)
    expect(calls.filter((call) => call.includes("x86_64"))).toHaveLength(4)
    for (const name of SIDECAR_NAMES) writeSidecarMetadata(binary(root, name, target), target, universalSidecarSourceHash(name, root))
    await verifyFreshSidecarsForTarget(target, root, run)
    const copied = fixture()
    for (const name of SIDECAR_NAMES) for (const arch of ["aarch64-apple-darwin", "x86_64-apple-darwin", target]) {
      const source = binary(root, name, arch), destination = binary(copied, name, arch)
      mkdirSync(path.dirname(destination), { recursive: true })
      copyFileSync(source, destination)
      copyFileSync(`${source}.metadata.json`, `${destination}.metadata.json`)
    }
    expect(universalSidecarSourceHash("acp-client", copied)).toBe(universalSidecarSourceHash("acp-client", root))
    const previous = universalSidecarSourceHash("acp-client", root)
    const arm = binary(root, "acp-client", "aarch64-apple-darwin")
    put(arm, "new valid ARM executable")
    writeSidecarMetadata(arm, "aarch64-apple-darwin", "new-source")
    expect(universalSidecarSourceHash("acp-client", root)).not.toBe(previous)
    await expect(verifyFreshSidecarsForTarget(target, root, run)).rejects.toThrow("Stale sidecar source")
    writeSidecarMetadata(binary(root, "acp-client", target), target, universalSidecarSourceHash("acp-client", root))
    await verifyFreshSidecarsForTarget(target, root, run)
    await expect(verifyFreshSidecarsForTarget(target, root, async () => { throw new Error("stale architecture") })).rejects.toThrow("stale architecture")
    rmSync(`${arm}.metadata.json`)
    calls.length = 0
    await expect(verifyFreshSidecarsForTarget(target, root, run)).rejects.toThrow("Missing sidecar metadata")
    expect(calls).toHaveLength(0)
  })
})
