import { afterEach, describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_BRAND, resolveIdentity } from "../packages/core/brand/src/index"
import { currentTarget, PROJECT_ROOT, type PreparedBrandBuild } from "./brand-build"
import { acquireBuildLock } from "./build-lock"
import { materializeBrandSidecars, packagedSidecarName, SIDECAR_NAMES } from "./brand-sidecars"
import { assertLinuxInstallLayout } from "./linux-install-layout"
import { writeSidecarMetadata } from "./sidecar-metadata"

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const linux = "x86_64-unknown-linux-gnu"
const mywork = resolveIdentity({ brandId: "mywork", productName: "MyWork" })
const second = resolveIdentity({ brandId: "secondwork", productName: "SecondWork" })

describe("Linux branded sidecar packaging", () => {
  test("actual default public build/dev/release entries reject incompatible skipped sidecars before Tauri or packing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "default-sidecar-entry-")); temporary.push(root)
    const scripts = path.join(root, "scripts")
    const desktop = path.join(root, "packages/client/desktop")
    const bin = path.join(desktop, "src-tauri/binaries")
    mkdirSync(scripts, { recursive: true }); mkdirSync(bin, { recursive: true })
    mkdirSync(path.join(root, "packages/core/brand/src"), { recursive: true })
    copyFileSync(path.join(PROJECT_ROOT, "packages/core/brand/src/index.ts"), path.join(root, "packages/core/brand/src/index.ts"))
    for (const file of ["tauri-brand.ts", "build-release.ts", "brand-build.ts", "build-lock.ts", "brand-artifacts.ts", "brand-sidecars.ts", "linux-install-layout.ts", "sidecar-metadata.ts", "macos-signing.ts", "macos-icon.ts", "builtin-skills-exclude.ts", "png-image.ts"]) copyFileSync(path.join(PROJECT_ROOT, "scripts", file), path.join(scripts, file))
    symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"), "junction")
    const tauriMarker = path.join(root, "tauri-was-called")
    const packMarker = path.join(root, "packing-was-called")
    writeFileSync(path.join(desktop, "package.json"), JSON.stringify({ scripts: { tauri: "bun run --bun fake-tauri.ts" } }))
    writeFileSync(path.join(desktop, "fake-tauri.ts"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(tauriMarker)}, 'called'); process.exit(37)`)
    writeFileSync(path.join(scripts, "pack-builtin-skills.ts"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(packMarker)}, 'called')`)
    writeFileSync(path.join(desktop, "src-tauri/tauri.conf.json"), JSON.stringify({ productName: "Ultrawork", identifier: "com.ultrawork.desktop", version: "0.3.9", bundle: {} }))
    const target = currentTarget()
    const binary = (role: string) => path.join(bin, `${role}-${target}${target.includes("windows") ? ".exe" : ""}`)
    const reset = () => {
      rmSync(tauriMarker, { force: true }); rmSync(packMarker, { force: true })
      for (const role of SIDECAR_NAMES) { writeFileSync(binary(role), "fixture"); writeSidecarMetadata(binary(role), target, "fixture-source") }
    }
    const env = { ...process.env, GITHUB_REF_NAME: "", ULTRAWORK_BUILD_LOCK_TOKEN: "", ULTRAWORK_BUILD_TARGET_DIR: "", CARGO_TARGET_DIR: "" }
    const calls = [["tauri-brand.ts", "build"], ["tauri-brand.ts", "dev"], ["build-release.ts", "--native", "--unsigned", "--skip-sidecar"]]
    for (const missing of [true, false]) for (const [script, ...args] of calls) {
      reset()
      const metadata = `${binary("acp-client")}.metadata.json`
      if (missing) rmSync(metadata)
      else { const data = JSON.parse(readFileSync(metadata, "utf8")); data.brandContextProtocol = 0; writeFileSync(metadata, JSON.stringify(data)) }
      const result = spawnSync(process.execPath, ["run", "--bun", path.join(scripts, script), ...args], { cwd: root, env, encoding: "utf8", timeout: 15_000 })
      expect(result.status, result.stderr).not.toBe(0)
      expect(result.stderr).toContain(missing ? "Missing sidecar metadata" : "Incompatible or changed sidecar")
      expect(existsSync(tauriMarker)).toBe(false)
      expect(existsSync(packMarker)).toBe(false)
    }
    // A valid set reaches the downstream CLI stub, so the negative controls
    // above cannot pass merely because the copied entry point cannot execute.
    reset()
    const valid = spawnSync(process.execPath, ["run", "--bun", path.join(scripts, "tauri-brand.ts"), "build"], { cwd: root, env, encoding: "utf8", timeout: 15_000 })
    expect(valid.status, valid.stderr).toBe(37)
    expect(existsSync(tauriMarker)).toBe(true)
  })

  test("actual staged external binaries use distinct install basenames without changing the shared sources", () => {
    const root = mkdtempSync(path.join(tmpdir(), "linux-brand-sidecars-")); temporary.push(root)
    const bin = path.join(root, "packages/client/desktop/src-tauri/binaries")
    mkdirSync(bin, { recursive: true })
    const lease = acquireBuildLock(root)
    try {
      for (const role of SIDECAR_NAMES) {
        const file = path.join(bin, `${role}-${linux}`)
        writeFileSync(file, `native-sidecar-fixture:${role}`)
        writeSidecarMetadata(file, linux, "fixture-source-hash")
      }
      const installedPaths: Set<string>[] = [new Set(["/usr/bin/ultrawork", ...SIDECAR_NAMES.map((role) => `/usr/bin/${role}`)])]
      for (const identity of [mywork, second]) {
        const stageDir = path.join(root, ".brand-build", identity.brandId, "stage")
        mkdirSync(stageDir, { recursive: true })
        const configFile = path.join(stageDir, "tauri-brand.json")
        const prepared = { brand: { identity }, stageDir, env: { ULTRAWORK_BUILD_CONFIG_FILE: configFile }, config: { bundle: { icon: ["preserve.ico"] } } } as unknown as PreparedBrandBuild
        materializeBrandSidecars(prepared, linux, root)
        const config = JSON.parse(readFileSync(configFile, "utf8"))
        expect(config.bundle.icon).toEqual(["preserve.ico"])
        const paths = new Set<string>([`/usr/bin/${identity.mainBinaryName}`])
        for (let i = 0; i < SIDECAR_NAMES.length; i++) {
          const role = SIDECAR_NAMES[i]
          const staged = `${config.bundle.externalBin[i]}-${linux}`
          expect(readFileSync(staged, "utf8")).toBe(`native-sidecar-fixture:${role}`)
          expect(readFileSync(path.join(bin, `${role}-${linux}`), "utf8")).toBe(`native-sidecar-fixture:${role}`)
          paths.add(`/usr/bin/${path.basename(config.bundle.externalBin[i])}`)
        }
        installedPaths.push(paths)
      }
      for (let a = 0; a < installedPaths.length; a++) for (let b = a + 1; b < installedPaths.length; b++) {
        expect([...installedPaths[a]].filter((file) => installedPaths[b].has(file))).toEqual([])
      }
    } finally { lease.release() }
  })

  test("non-Linux and default names retain the existing bundle layout", () => {
    for (const role of SIDECAR_NAMES) {
      expect(packagedSidecarName(DEFAULT_BRAND, role, linux)).toBe(role)
      for (const target of ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"]) expect(packagedSidecarName(mywork, role, target)).toBe(role)
    }
  })

  test("installed payload validation rejects legacy shared paths or a missing branded sidecar", () => {
    const filesFor = (identity: typeof DEFAULT_BRAND) => [`/usr/bin/${identity.mainBinaryName ?? "ultrawork"}`, ...SIDECAR_NAMES.map((name) => `/usr/bin/${packagedSidecarName(identity, name, linux)}`), `/usr/lib/${identity.productName}/skills/builtin/skills-builtin.zip`]
    const layouts = [DEFAULT_BRAND, mywork, second].map(filesFor)
    for (const [index, identity] of [DEFAULT_BRAND, mywork, second].entries()) expect(() => assertLinuxInstallLayout(identity, linux, layouts[index])).not.toThrow()
    for (let a = 0; a < layouts.length; a++) for (let b = a + 1; b < layouts.length; b++) expect(layouts[a].filter((file) => layouts[b].includes(file))).toEqual([])
    expect(() => assertLinuxInstallLayout(mywork, linux, [...layouts[1], "/usr/bin/acp-client"])).toThrow("overwrite")
    expect(() => assertLinuxInstallLayout(mywork, linux, layouts[1].filter((file) => !file.endsWith("mywork-acp-client")))).toThrow("missing")
    expect(() => assertLinuxInstallLayout(mywork, linux, [...layouts[1], "/usr/lib/Ultrawork/skills/builtin/skills-builtin.zip"])).toThrow("default-brand resources")
  })
})
