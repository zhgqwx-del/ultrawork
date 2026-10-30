import { afterEach, describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { deflateSync } from "node:zlib"
import { validatePng } from "./png-image"
import { DEFAULT_BRAND, parseBrandIdentity, resolveIdentity } from "../packages/core/brand/src/index"
import { absoluteBrandArgs, brandSkillMarkdown, imageInfo, parseBrandArgs, resolveBrandBuild, validateArguments, wixUpgradeCode, PROJECT_ROOT, prepareBrandBuild } from "./brand-build"
import { exportBrandArtifacts } from "./brand-artifacts"
import { macosSigningEnvironment, quarantineRemovalCommand } from "./macos-signing"
import { acquireBuildLock } from "./build-lock"
import { writeSidecarMetadata, verifySidecarMetadata } from "./sidecar-metadata"
import { createBuildProbeEnvironment } from "./build-probe-env"

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ultrawork-brand-test-"))
  dirs.push(dir)
  copyFileSync(path.join(PROJECT_ROOT, "branding/mywork/assets/meiyou-app.png"), path.join(dir, "icon.png"))
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// Ordinary CI checks out only this repository and installs its workspaces. The
// upstream Global acceptance additionally needs the vendor submodule/runtime;
// opt in explicitly so a clean runner reports a skip, never a false pass.
const vendorGlobalAcceptance = process.env.ULTRAWORK_TEST_VENDOR_GLOBAL === "1" ? test : test.skip
const pythonCommand = process.platform === "win32" ? "python" : "python3"

describe("brand build contract", () => {
  test("Python metadata identity matches the shared JS contract (requires Python)", () => {
    const cases = [
      DEFAULT_BRAND,
      ...["MyWork", "Research & Co", "A\u0085", "A\ufeff", "\u0085A", "\ufeffA", "😀".repeat(40), "😀".repeat(41),
        "A\u00a0", "A\u2007", "A\u202f", "A\u180e", "A\n", "A\r", "A\u2028", "A\u2029", " Ｕｌｔｒａｗｏｒｋ ", "COM1", "con.app", "Safe Work"]
        .map((productName) => ({ schemaVersion: 1, brandId: "identity-test", productName, identifier: "com.ultrawork.identity-test", namespace: "identity-test", mainBinaryName: "identity-test", isDefault: false })),
      ...["identity-test\n", "identity-test\r", "identity-test\u2028", "identity-test ", "con", "claude", "my_work", "ok-2"]
        .map((brandId) => ({ schemaVersion: 1, brandId, productName: "Test Work", identifier: `com.ultrawork.${brandId}`, namespace: brandId, mainBinaryName: brandId, isDefault: false })),
    ]
    const expected = cases.map((identity) => { try { return [true, parseBrandIdentity(identity).productName] } catch { return [false, null] } })
    const script = `import json,os,sys
sys.path.insert(0,sys.argv[1])
from docxcommon import brand_product_name,DocxError
for key in ('ULTRAWORK_BRAND_CONTEXT_FILE','ULTRAWORK_BRAND_MANAGED','OPENCODE_APP_NAME'): os.environ.pop(key,None)
results=[]
for identity in json.load(sys.stdin):
 os.environ['ULTRAWORK_BRAND_CONTEXT']=json.dumps({'schemaVersion':1,'identity':identity,'instanceId':'brand-parity-01'})
 try: results.append([True,brand_product_name()])
 except DocxError: results.append([False,None])
print(json.dumps(results))`
    const result = spawnSync(pythonCommand, ["-c", script, path.join(PROJECT_ROOT, "skills/builtin/docx/scripts")], { input: JSON.stringify(cases), encoding: "utf8", timeout: 15_000 })
    expect(result.status, result.error?.message || result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(expected)
  })
  test("DingTalk instructions use their own brand documents and preserve source attribution", () => {
    const relative = path.join("dingtalk-assistant", "SKILL.md")
    const source = readFileSync(path.join(PROJECT_ROOT, "skills/builtin", relative), "utf8")
    const attribution = "\nCopyright Ultrawork Team; source repository: ultrawork.\n"
    const mywork = resolveIdentity({ brandId: "mywork", productName: "MyWork" })
    const result = brandSkillMarkdown(relative, source + attribution, mywork)
    expect(source).toContain("<home>/.ultrawork/office-cli/skills/dws/SKILL.md")
    for (const form of ["`.mywork/office-cli/skills/dws/", "<home>/.mywork/office-cli/skills/dws/SKILL.md", "~/.mywork/..."]) expect(result).toContain(form)
    expect(result).not.toContain(".ultrawork/office-cli/skills/dws")
    expect(result).toContain("%USERPROFILE%")
    expect(result.endsWith(attribution)).toBe(true)
    expect(brandSkillMarkdown(relative, source, DEFAULT_BRAND)).toBe(source)
    // A historical path in somebody else's source note is not a host instruction.
    const sourceNote = "From ultrawork: <home>/.ultrawork/office-cli/skills/dws/SKILL.md"
    expect(brandSkillMarkdown(path.join("other", "ORIGIN.md"), sourceNote, mywork)).toBe(sourceNote)
  })
  test("build probe isolation preserves caller environment and removes only its own temporary root", () => {
    const parent = Object.freeze({ HOME: "/toolchain-home", USERPROFILE: "C:\\toolchain-home", XDG_CACHE_HOME: "/customer-cache", OPENCODE_TEST_HOME: "/customer-home", KEEP: "fixture" })
    const probe = createBuildProbeEnvironment(parent)
    expect(probe.env.HOME).toBe(parent.HOME)
    expect(probe.env.USERPROFILE).toBe(parent.USERPROFILE)
    expect(probe.env.KEEP).toBe("fixture")
    expect(parent.XDG_CACHE_HOME).toBe("/customer-cache")
    expect(parent.OPENCODE_TEST_HOME).toBe("/customer-home")
    expect(existsSync(probe.root)).toBe(true)
    probe.dispose(); probe.dispose()
    expect(existsSync(probe.root)).toBe(false)
  })
  test("a real subprocess receives only disposable application paths and preserves the caller's cache", () => {
    const root = fixture()
    const toolchainHome = path.join(root, "toolchain-home")
    mkdirSync(toolchainHome)
    const customerCache = path.join(root, "customer-cache", "ultrawork")
    mkdirSync(customerCache, { recursive: true })
    writeFileSync(path.join(customerCache, "version"), "old-version")
    writeFileSync(path.join(customerCache, "customer-marker"), "keep")
    const parent = Object.freeze({ ...process.env, HOME: toolchainHome, USERPROFILE: toolchainHome,
      OPENCODE_TEST_HOME: path.join(root, "customer-home"),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "customer-managed-config"),
      XDG_CONFIG_HOME: path.join(root, "customer-config"), XDG_DATA_HOME: path.join(root, "customer-data"),
      XDG_CACHE_HOME: path.dirname(customerCache), XDG_STATE_HOME: path.join(root, "customer-state") })
    const before = JSON.stringify(parent)
    const probe = createBuildProbeEnvironment(parent)
    try {
      const script = `
        import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
        import {homedir} from 'node:os'; import path from 'node:path';
        const keys=['OPENCODE_TEST_HOME','OPENCODE_TEST_MANAGED_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME'];
        const roots=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
        for(const directory of Object.values(roots)) {
          if(!directory || !path.isAbsolute(directory)) throw new Error('Application root must be absolute');
          mkdirSync(directory,{recursive:true}); writeFileSync(path.join(directory,'child-witness'),'isolated');
        }
        // Exercise a destructive cache-refresh consumer without a vendor install.
        const cache=path.join(roots.XDG_CACHE_HOME,'ultrawork');
        rmSync(cache,{recursive:true,force:true}); mkdirSync(cache); writeFileSync(path.join(cache,'version'),'probe-version');
        console.log(JSON.stringify({roots,toolchainHome:homedir()}));
      `
      const result = spawnSync(process.execPath, ["--eval", script], { cwd: root, env: probe.env, encoding: "utf8", timeout: 15_000 })
      expect(result.status, result.stderr).toBe(0)
      const actual = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!)
      expect(actual.toolchainHome).toBe(toolchainHome)
      for (const [key, value] of Object.entries(actual.roots) as [string, string][]) {
        const relative = path.relative(probe.root, value)
        expect(relative.startsWith("..")).toBe(false)
        expect(path.isAbsolute(relative)).toBe(false)
        expect(value).toBe(probe.env[key]!)
        expect(readFileSync(path.join(value, "child-witness"), "utf8")).toBe("isolated")
      }
      expect(readFileSync(path.join(customerCache, "version"), "utf8")).toBe("old-version")
      expect(readFileSync(path.join(customerCache, "customer-marker"), "utf8")).toBe("keep")
      expect(readFileSync(path.join(actual.roots.XDG_CACHE_HOME, "ultrawork", "version"), "utf8")).toBe("probe-version")
      expect(existsSync(parent.OPENCODE_TEST_HOME)).toBe(false)
      expect(existsSync(parent.OPENCODE_TEST_MANAGED_CONFIG_DIR)).toBe(false)
      for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const) expect(existsSync(parent[key])).toBe(false)
      expect(JSON.stringify(parent)).toBe(before)
    } finally { probe.dispose() }
    expect(existsSync(probe.root)).toBe(false)
  })
  vendorGlobalAcceptance("real vendor Global initialization cannot clear the caller's application cache (ULTRAWORK_TEST_VENDOR_GLOBAL=1)", () => {
    const root = fixture()
    const oldCache = path.join(root, "customer-cache", "ultrawork")
    mkdirSync(oldCache, { recursive: true })
    writeFileSync(path.join(oldCache, "version"), "old-version")
    writeFileSync(path.join(oldCache, "customer-marker"), "keep")
    const parent = { ...process.env, HOME: path.join(root, "toolchain-home"), USERPROFILE: path.join(root, "toolchain-home"), OPENCODE_APP_NAME: "ultrawork", OPENCODE_TEST_HOME: path.join(root, "customer-home"), XDG_CONFIG_HOME: path.join(root, "customer-config"), XDG_DATA_HOME: path.join(root, "customer-data"), XDG_CACHE_HOME: path.dirname(oldCache), XDG_STATE_HOME: path.join(root, "customer-state") }
    const probe = createBuildProbeEnvironment(parent)
    try {
      const moduleFile = path.join(PROJECT_ROOT, "vendor/opencode/packages/opencode/src/global/index.ts")
      if (!existsSync(moduleFile)) throw new Error("Vendor acceptance was requested: checkout vendor/opencode and install its dependencies first")
      const globalModule = pathToFileURL(moduleFile).href
      const script = `const {Global}=await import(${JSON.stringify(globalModule)}); console.log(JSON.stringify(Global.Path))`
      const result = spawnSync(process.execPath, ["--eval", script], { cwd: path.join(PROJECT_ROOT, "vendor/opencode/packages/opencode"), env: probe.env, encoding: "utf8", timeout: 15_000 })
      expect(result.status, result.stderr).toBe(0)
      const actual = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!)
      for (const value of Object.values(actual) as string[]) {
        const relative = path.relative(probe.root, value)
        expect(relative.startsWith("..")).toBe(false)
        expect(path.isAbsolute(relative)).toBe(false)
      }
      expect(readFileSync(path.join(oldCache, "version"), "utf8")).toBe("old-version")
      expect(readFileSync(path.join(oldCache, "customer-marker"), "utf8")).toBe("keep")
      expect(readFileSync(path.join(actual.cache, "version"), "utf8")).not.toBe("old-version")
      expect(parent.XDG_CACHE_HOME).toBe(path.dirname(oldCache))
    } finally { probe.dispose() }
    expect(existsSync(probe.root)).toBe(false)
  })
  test("default identity cannot be changed by stale generated build state", () => {
    const brand = resolveBrandBuild({})
    expect(brand.identity.productName).toBe("Ultrawork")
    expect(brand.identity.mainBinaryName).toBeUndefined()
    expect(brand.upgradeCode).toBe("7A7C1D26-332C-5C03-818C-2F87039B20DC")
  })
  test("default ignores broken custom presets, ledger and old manifests", async () => {
    for (const broken of ["branding/broken/brand.json", ".brand-build/identity-ledger.json", ".brand-build/artifacts/old/test/manifest-test.json"]) {
      const dir = fixture()
      const file = path.join(dir, broken)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, "{broken custom JSON")
      const tauri = path.join(dir, "packages/client/desktop/src-tauri")
      mkdirSync(tauri, { recursive: true })
      writeFileSync(path.join(tauri, "tauri.conf.json"), JSON.stringify({ productName: "Ultrawork", bundle: {} }))
      const defaultBrand = resolveBrandBuild({}, dir, dir)
      expect(defaultBrand.identity.isDefault).toBe(true)
      expect((await prepareBrandBuild(defaultBrand, dir)).configArgs).toEqual([])
      expect(readFileSync(file, "utf8")).toBe("{broken custom JSON")
      expect(() => resolveBrandBuild({ brandId: "explicit-custom", productName: "Explicit Custom", icon: path.join(dir, "icon.png") }, dir, dir)).toThrow()
    }
  })
  test("file-relative images work from another cwd and CLI override supersedes missing old image", () => {
    const dir = fixture()
    const file = path.join(dir, "brand.json")
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, brandId: "testbrand", productName: "TestBrand", icon: "missing.png" }))
    const brand = resolveBrandBuild({ file, icon: path.join(dir, "icon.png") }, tmpdir())
    expect(brand.identity.brandId).toBe("testbrand")
    expect(brand.icon).toBe(path.join(dir, "icon.png"))
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, brandId: "testbrand", productName: "TestBrand", icon: "icon.png" }))
    expect(resolveBrandBuild({ file }, tmpdir()).digest).toBe(brand.digest)
  })
  test("temporary name derives namespace, explicit identity remains stable", () => {
    const dir = fixture()
    expect(resolveBrandBuild({ productName: "Local Demo", icon: "icon.png" }, dir).identity.brandId).toBe("local-demo")
    expect(() => resolveBrandBuild({ productName: "中文品牌", icon: "icon.png" }, dir)).toThrow("brand-id")
    expect(() => resolveBrandBuild({ brandId: "demo-cn", productName: "中文品牌", icon: "icon.png" }, dir)).toThrow("ASCII")
    expect(() => resolveBrandBuild({ brandId: "demo-wide", productName: "ＭｙＷｏｒｋ", icon: "icon.png" }, dir)).toThrow("ASCII")
  })
  test("the final product name cannot interpolate the macOS DMG layout template", () => {
    const dir = fixture()
    for (const productName of ["Money$Work", "Meet@Work"]) {
      expect(() => resolveBrandBuild({ brandId: "template-fixture", productName, icon: "icon.png" }, dir, dir)).toThrow("DMG layout template")
      const file = path.join(dir, "brand.json")
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, brandId: "template-fixture", productName, icon: "icon.png" }))
      expect(() => resolveBrandBuild({ file }, dir, dir)).toThrow("DMG layout template")
      expect(resolveBrandBuild({ file, productName: "Safe Work" }, dir, dir).identity.productName).toBe("Safe Work")
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, brandId: "template-fixture", productName: "Safe Work", icon: "icon.png" }))
      expect(() => resolveBrandBuild({ file, productName }, dir, dir)).toThrow("DMG layout template")
    }
  })
  test("a brand main binary cannot collide with another Linux brand's prefixed sidecar", () => {
    const dir = fixture()
    expect(() => resolveBrandBuild({ brandId: "mywork-acp-client", productName: "Another Client", icon: path.join(dir, "icon.png") })).toThrow("conflicts with mywork")
  })
  test("macOS normalized single-instance sockets cannot collide with another Dev identity", () => {
    const dir = fixture()
    for (const brandId of ["mywork-dev", "desktop-dev"]) {
      expect(() => resolveBrandBuild({ brandId, productName: "Unrelated Product", icon: path.join(dir, "icon.png") })).toThrow("installation identity conflicts")
    }
    expect(resolveBrandBuild({ brandId: "mywork-second", productName: "Unrelated Product", icon: path.join(dir, "icon.png") }).identity.brandId).toBe("mywork-second")
  })
  test("unknown/schema/partial/repeated/unsafe input fails without falling back", () => {
    const dir = fixture()
    expect(() => parseBrandArgs(["--name"])).toThrow()
    expect(() => parseBrandArgs(["--icon", "a", "--icon", "b"])).toThrow()
    expect(() => validateArguments(["--typo"], [])).toThrow()
    expect(() => resolveBrandBuild({ icon: "icon.png" }, dir)).toThrow()
    const file = path.join(dir, "bad.json")
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, brandId: "demo", productName: "Demo", icon: "icon.png", identifier: "unsafe" }))
    expect(() => resolveBrandBuild({ file }, dir)).toThrow("Unknown")
  })
  test("all final PNG assets reject a valid header with truncated pixel content", () => {
    const dir = fixture()
    const valid = path.join(dir, "icon.png"), bad = path.join(dir, "truncated.png")
    writeFileSync(bad, readFileSync(valid).subarray(0, 100))
    for (const field of ["icon", "uiLogo", "trayIcon"] as const) {
      expect(() => resolveBrandBuild({ brandId: "png-fixture", productName: "PNG Fixture", icon: valid, [field]: bad }, dir, dir)).toThrow("Invalid PNG")
    }
    expect(() => imageInfo(bad)).toThrow("Invalid PNG")
  })
  test("PNG validation decodes compressed pixels and filters, including Adam7", () => {
    const chunk = (type: string, data: Buffer) => {
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length)
      const body = Buffer.concat([Buffer.from(type), data])
      const crc = Buffer.alloc(4); crc.writeUInt32BE(Bun.hash.crc32(body))
      return Buffer.concat([prefix, body, crc])
    }
    const png = (pixels: Buffer, interlace = 0, compressed = false) => {
      const header = Buffer.alloc(13)
      header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4)
      header[8] = 8; header[9] = 6; header[12] = interlace
      return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", compressed ? pixels : deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))])
    }
    expect(validatePng(png(Buffer.from([0,255,0,0,255])))).toEqual({ width: 1, height: 1 })
    expect(validatePng(png(Buffer.from([0,255,0,0,255]), 1))).toEqual({ width: 1, height: 1 })
    expect(() => validatePng(png(Buffer.from([0,1,2]), 0, true))).toThrow("compressed pixel data")
    expect(() => validatePng(png(Buffer.from([0,255,0])))).toThrow("scanline length")
    expect(() => validatePng(png(Buffer.from([5,255,0,0,255])))).toThrow("scanline filter")
    const badCrc = png(Buffer.from([0,255,0,0,255])); badCrc[badCrc.length - 1] ^= 1
    expect(() => validatePng(badCrc)).toThrow("CRC")
  })
  test("registered identity, normalized package and Dev-name collisions fail", () => {
    const dir = fixture()
    const icon = path.join(dir, "icon.png")
    expect(() => resolveBrandBuild({ brandId: "different", productName: "My Work", icon })).toThrow("conflicts")
    expect(() => resolveBrandBuild({ brandId: "different", productName: "MyWork Dev", icon })).toThrow("conflicts")
    expect(() => resolveBrandBuild({ brandId: "mywork", productName: "Renamed", icon })).toThrow("immutable")
  })
  test("a real temporary build registers identity and blocks later temporary collisions", async () => {
    const dir = fixture()
    const desktop = path.join(dir, "packages/client/desktop")
    mkdirSync(path.join(desktop, "src-tauri"), { recursive: true })
    writeFileSync(path.join(desktop, "src-tauri/tauri.conf.json"), JSON.stringify({ productName: "Ultrawork", app: { windows: [{ title: "Ultrawork", width: 1200 }] }, bundle: { resources: { "resources/builtin-skills": "skills/builtin" } } }))
    writeFileSync(path.join(desktop, "package.json"), JSON.stringify({ scripts: { tauri: "bun run --bun tauri-cli.ts" } }))
    writeFileSync(path.join(desktop, "tauri-cli.ts"), `await import(${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, "packages/client/desktop/node_modules/@tauri-apps/cli/tauri.js")).href)})`)
    mkdirSync(path.join(dir, "skills/builtin"), { recursive: true })
    writeFileSync(path.join(dir, "skills/builtin/README.md"), "Installed at ~/.config/ultrawork/skills; authored by ultrawork")
    mkdirSync(path.join(dir, "skills/builtin/dingtalk-assistant"))
    writeFileSync(path.join(dir, "skills/builtin/dingtalk-assistant/SKILL.md"), "<home>/.ultrawork/office-cli/skills/dws/SKILL.md")
    const args = { brandId: "temporary-one", productName: "Temporary One", icon: path.join(dir, "icon.png") }
    const first = resolveBrandBuild(args, dir, dir)
    expect(() => readFileSync(path.join(dir, ".brand-build/identity-ledger.json"))).toThrow()
    const lease = acquireBuildLock(dir, {})
    try {
      const prepared = await prepareBrandBuild(first, dir)
      const skillSource = prepared.env.ULTRAWORK_BUILTIN_SKILLS_SOURCE
      expect(readFileSync(path.join(skillSource, "README.md"), "utf8")).toBe("Installed at ~/.config/temporary-one/skills; authored by ultrawork")
      expect(readFileSync(path.join(skillSource, "dingtalk-assistant/SKILL.md"), "utf8")).toBe("<home>/.temporary-one/office-cli/skills/dws/SKILL.md")
      const ledger = readFileSync(path.join(dir, ".brand-build/identity-ledger.json"), "utf8")
      expect(ledger).toContain("temporary-one")
      expect(ledger).not.toContain(dir)
      expect(() => resolveBrandBuild({ ...args, productName: "Renamed Edition" }, dir, dir)).toThrow("immutable")
      expect(() => resolveBrandBuild({ ...args, brandId: "temporary-two" }, dir, dir)).toThrow("conflicts")
      expect(() => resolveBrandBuild({ ...args, brandId: "temporary-two", productName: "TemporaryOne" }, dir, dir)).toThrow("conflicts")
    } finally { lease.release() }
  }, 60_000)
  test("earlier artifact manifests also freeze temporary identity without a ledger", () => {
    const dir = fixture()
    const folder = path.join(dir, ".brand-build/artifacts/older-edition/test-platform")
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, "manifest-test-platform.json"), JSON.stringify({ schemaVersion: 1, identity: resolveIdentity({ brandId: "older-edition", productName: "Older Edition" }) }))
    const icon = path.join(dir, "icon.png")
    expect(() => resolveBrandBuild({ brandId: "older-edition", productName: "Renamed Edition", icon }, dir, dir)).toThrow("immutable")
    expect(() => resolveBrandBuild({ brandId: "different-edition", productName: "OlderEdition", icon }, dir, dir)).toThrow("conflicts")
  })
  test("setup forwards absolute CLI paths when the child cwd changes", async () => {
    const dir = fixture()
    writeFileSync(path.join(dir, "outside.json"), JSON.stringify({ schemaVersion: 1, brandId: "outside-cwd", productName: "Outside Cwd", icon: "old-missing.png" }))
    const args = absoluteBrandArgs({ file: "outside.json", icon: "icon.png" }, dir)
    const child = Bun.spawn([process.execPath, "run", "--bun", "scripts/brand-inspect.ts", "--brand", args.file!, "--icon", args.icon!], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" })
    const output = await new Response(child.stdout).text()
    const errors = await new Response(child.stderr).text()
    expect(await child.exited).toBe(0)
    expect(errors).toBe("")
    expect(JSON.parse(output).brandId).toBe("outside-cwd")
  })
  test("content digest changes when an image is replaced at the same path", () => {
    const dir = fixture()
    const args = { brandId: "testbrand", productName: "TestBrand", icon: path.join(dir, "icon.png") }
    const first = resolveBrandBuild(args).digest
    copyFileSync(path.join(PROJECT_ROOT, "branding/mywork/assets/meiyou-tray.png"), args.icon)
    expect(resolveBrandBuild(args).digest).not.toBe(first)
  })
  test("ad-hoc signing is explicitly applied by Tauri before installer creation", () => {
    const env = {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Existing Team",
      APPLE_ID: "fixture", APPLE_PASSWORD: "fixture", APPLE_TEAM_ID: "fixture",
      APPLE_API_KEY: "fixture", APPLE_API_ISSUER: "fixture", APPLE_API_KEY_PATH: "fixture",
      APPLE_CERTIFICATE: "fixture", APPLE_CERTIFICATE_PASSWORD: "fixture", CUSTOM_FLAG: "kept",
    }
    const adhoc = macosSigningEnvironment(env, true)
    expect(adhoc.APPLE_SIGNING_IDENTITY).toBe("-")
    expect(adhoc.CUSTOM_FLAG).toBe("kept")
    for (const key of Object.keys(env).filter((key) => key.startsWith("APPLE_") && key !== "APPLE_SIGNING_IDENTITY")) {
      expect(Object.hasOwn(adhoc, key)).toBe(false)
    }
    expect(env.APPLE_TEAM_ID).toBe("fixture")
    expect(macosSigningEnvironment(env, false)).toEqual(env)
    expect(macosSigningEnvironment({}, true).APPLE_SIGNING_IDENTITY).toBe("-")
    expect(() => macosSigningEnvironment({}, false)).toThrow("certificate")
    expect(() => macosSigningEnvironment({ APPLE_SIGNING_IDENTITY: "-" }, false)).toThrow("--unsigned")
  })
  test("quarantine instructions use the effective Dev name and quote shell characters", () => {
    expect(quarantineRemovalCommand("MyWork Dev")).toContain("'/Applications/MyWork Dev.app'")
    const command = quarantineRemovalCommand("O'Brien $(touch must-not-run) Dev")
    expect(command).toContain("O'\\''Brien")
    expect(command.endsWith("Dev.app'")).toBe(true)
  })
  test("the MyWork MSI upgrade family is independent and deterministic", () => {
    expect(wixUpgradeCode("com.ultrawork.mywork.exe.app.x64")).toBe("F53BC093-5A49-587C-962E-16AA01AD266D")
  })
  test("sidecar compatibility is verified even when compilation is skipped", () => {
    const dir = fixture(), binary = path.join(dir, "sidecar")
    writeFileSync(binary, "compiled binary")
    expect(() => verifySidecarMetadata(binary, "test-target")).toThrow("Missing")
    writeSidecarMetadata(binary, "test-target", "source-v1")
    expect(() => verifySidecarMetadata(binary, "test-target")).not.toThrow()
    writeFileSync(binary, "changed")
    expect(() => verifySidecarMetadata(binary, "test-target")).toThrow("Incompatible")
  })
  test("default prepare does not rename binaries or touch default config/icons", async () => {
    const dir = fixture()
    const tauri = path.join(dir, "packages/client/desktop/src-tauri")
    mkdirSync(tauri, { recursive: true })
    writeFileSync(path.join(tauri, "tauri.conf.json"), JSON.stringify({ productName: "Ultrawork", bundle: { icon: ["old.png"] } }))
    const prepared = await prepareBrandBuild(resolveBrandBuild({}), dir)
    expect(prepared.configArgs).toEqual([])
    expect(prepared.targetDir).toBe(path.join(tauri, "target"))
    expect(JSON.parse(readFileSync(path.join(tauri, "tauri.conf.json"), "utf8")).bundle.icon).toEqual(["old.png"])
  })
  test("artifact export excludes stale/foreign files and labels the effective Dev identity", async () => {
    const dir = fixture()
    const tauri = path.join(dir, "packages/client/desktop/src-tauri")
    mkdirSync(tauri, { recursive: true })
    writeFileSync(path.join(tauri, "tauri.conf.json"), JSON.stringify({ productName: "Ultrawork", bundle: {} }))
    const prepared = await prepareBrandBuild(resolveBrandBuild({}), dir)
    const bundle = path.join(tauri, "target/release/bundle")
    mkdirSync(path.join(bundle, "dmg"), { recursive: true })
    const recent = path.join(bundle, "dmg/Ultrawork Dev_0.3.9_arm64.dmg")
    const stale = path.join(bundle, "dmg/Ultrawork_0.1.0_arm64.dmg")
    writeFileSync(recent, "new installer")
    writeFileSync(stale, "old installer")
    utimesSync(stale, 1, 1)
    writeFileSync(path.join(bundle, "dmg/AnotherBrand_0.3.9_arm64.dmg"), "foreign installer")
    exportBrandArtifacts(prepared, bundle, Date.now(), dir, { mode: "unsigned-dev", productName: "Ultrawork Dev", identifier: "com.ultrawork.desktop.dev", signing: "ad-hoc" })
    const platform = `${process.platform}-${process.arch}`
    const manifest = JSON.parse(readFileSync(path.join(dir, ".brand-build/artifacts/ultrawork", platform, `manifest-${platform}.json`), "utf8"))
    expect(manifest.artifacts.map((item: { file: string }) => item.file)).toEqual([path.basename(recent)])
    expect(manifest.build).toMatchObject({ mode: "unsigned-dev", identifier: "com.ultrawork.desktop.dev", signing: "ad-hoc" })
    expect(JSON.stringify(manifest)).not.toContain(dir)
  })
  test("OS build lease is released when a holder crashes", async () => {
    const dir = fixture()
    const script = `import {acquireBuildLock} from ${JSON.stringify(path.join(PROJECT_ROOT, "scripts/build-lock.ts"))}; acquireBuildLock(${JSON.stringify(dir)},{}); console.log("READY"); setInterval(()=>{},1000);`
    const holder = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
    const reader = holder.stdout.getReader()
    try {
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain("READY")
      expect(() => acquireBuildLock(dir, {})).toThrow("Another build")
      holder.kill("SIGKILL")
      await holder.exited
      const recovered = acquireBuildLock(dir, {})
      recovered.release()
    } finally {
      holder.kill()
      reader.releaseLock()
      await holder.exited
    }
  })
  test("build lease rejects competitors, supports nested calls and releases", () => {
    const dir = fixture()
    const first = acquireBuildLock(dir, {})
    expect(() => acquireBuildLock(dir, {})).toThrow("Another build")
    const nested = acquireBuildLock(dir, { ULTRAWORK_BUILD_LOCK_TOKEN: first.token })
    nested.release()
    expect(() => acquireBuildLock(dir, {})).toThrow("Another build")
    first.release()
    const next = acquireBuildLock(dir, {})
    next.release()
  })
})
