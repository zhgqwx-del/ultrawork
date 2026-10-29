#!/usr/bin/env bun
/** Verify the exported DMG, then relocate its app away from the build checkout.
 * No application is installed or launched. --keep retains only our copied app.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { unzipSync } from "fflate"
import { parseBrandIdentity } from "../packages/core/brand/src/index"

if (process.platform !== "darwin") throw new Error("This verifier requires macOS and its disk image/code signing tools")
const argv = process.argv.slice(2)
let manifestFile: string | undefined
let outputFile: string | undefined
let expectedIcon: string | undefined
let keep = false
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--manifest" && !manifestFile) manifestFile = path.resolve(argv[++i] ?? "")
  else if (argv[i] === "--output" && !outputFile) outputFile = path.resolve(argv[++i] ?? "")
  else if (argv[i] === "--expected-icon" && !expectedIcon) expectedIcon = path.resolve(argv[++i] ?? "")
  else if (argv[i] === "--keep" && !keep) keep = true
  else throw new Error(`Unknown or repeated argument: ${argv[i]}`)
}
assert(manifestFile, "Usage: verify-brand-macos-package.ts --manifest <manifest.json> [--output report.json] [--expected-icon icon.icns] [--keep]")
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
assert.equal(manifest.schemaVersion, 1)
const identity = parseBrandIdentity(manifest.identity)
assert.equal(typeof manifest.build?.productName, "string")
assert.equal(typeof manifest.build?.identifier, "string")
const artifacts = manifest.artifacts.filter((item: { file: string }) => item.file.endsWith(".dmg"))
assert.equal(artifacts.length, 1, "The selected manifest must contain exactly one DMG")
const artifact = artifacts[0]
assert.equal(path.basename(artifact.file), artifact.file, "Artifact must be a local filename")
const dmg = path.join(path.dirname(manifestFile), artifact.file)
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")
const dmgBytes = readFileSync(dmg)
assert.equal(dmgBytes.byteLength, artifact.bytes)
assert.equal(sha(dmgBytes), artifact.sha256)

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 })
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.error || result.stdout}`)
  return result.stdout
}

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "uw-brand-package-")))
const mount = path.join(root, "mount")
const relocation = path.join(root, "Customer path with spaces", "客户测试")
mkdirSync(mount)
mkdirSync(relocation, { recursive: true })
let mounted = false
const checks: string[] = ["exported DMG hash and byte size match its manifest"]
const expectedName = `${manifest.build.productName}.app`
const copiedApp = path.join(relocation, expectedName)
let report: Record<string, unknown> | undefined
try {
  run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg])
  mounted = true
  assert.deepEqual(readdirSync(mount).filter((name) => name.endsWith(".app")), [expectedName])
  const mountedApp = path.join(mount, expectedName)
  const plist = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", path.join(mountedApp, "Contents", "Info.plist")]))
  assert.equal(plist.CFBundleName, manifest.build.productName)
  assert.equal(plist.CFBundleDisplayName, manifest.build.productName)
  assert.equal(plist.CFBundleIdentifier, manifest.build.identifier)
  assert.equal(plist.CFBundleExecutable, identity.mainBinaryName ?? "ultrawork")
  run("codesign", ["--verify", "--deep", "--strict", mountedApp])
  checks.push("mounted DMG contains only the expected app with matching name, identifier and executable", "app inside the DMG passes strict deep code-signature verification")
  cpSync(mountedApp, copiedApp, { recursive: true, verbatimSymlinks: true })
  run("codesign", ["--verify", "--deep", "--strict", copiedApp])
  checks.push("relocation to a temporary customer path containing spaces and Chinese preserves the signature")

  const resources = path.join(copiedApp, "Contents", "Resources")
  assert.equal(typeof plist.CFBundleIconFile, "string", "Info.plist must identify the macOS icon")
  const iconFile = plist.CFBundleIconFile.endsWith(".icns") ? plist.CFBundleIconFile : `${plist.CFBundleIconFile}.icns`
  assert.equal(path.basename(iconFile), iconFile, "The macOS icon must be a local resource")
  const iconBytes = readFileSync(path.join(resources, iconFile))
  assert.equal(iconBytes.toString("ascii", 0, 4), "icns")
  if (expectedIcon) {
    assert(iconBytes.equals(readFileSync(expectedIcon)), "Packaged macOS icon differs from the expected current ICNS")
    checks.push("Info.plist selects the current macOS icon, matching its expected ICNS byte for byte")
  }
  const skillsRoot = path.join(resources, "skills", "builtin")
  assert(existsSync(path.join(skillsRoot, "skills-builtin.zip")))
  assert(existsSync(path.join(skillsRoot, ".builtin-version")))
  const checkout = path.resolve(import.meta.dir, "..")
  let textFiles = 0
  const checkText = (name: string, bytes: Uint8Array) => {
    if (!/\.(?:json|js|mjs|cjs|html|md|py|sh|ts|tsx|css|txt)$/.test(name)) return
    textFiles++
    assert(!Buffer.from(bytes).toString("utf8").includes(checkout), `Build checkout leaked into packaged text: ${name}`)
  }
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) {
        const bytes = readFileSync(file)
        checkText(file, bytes)
        if (entry.name === "skills-builtin.zip") for (const [name, content] of Object.entries(unzipSync(bytes))) checkText(name, content)
      }
    }
  }
  visit(resources)
  const binaries = path.join(copiedApp, "Contents", "MacOS")
  const roles = [identity.mainBinaryName ?? "ultrawork", "opencode-server", "channel-gateway", "knowledge-sidecar", "acp-client"]
  const architecture: Record<string, string> = {}
  for (const name of roles) {
    const binary = path.join(binaries, name)
    assert(existsSync(binary), `Missing packaged binary: ${name}`)
    architecture[name] = run("lipo", ["-archs", binary]).trim()
    // Universal binaries repeat the filename header for every architecture.
    // Headers may contain spaces; only indented load-command rows are dylibs.
    const libraries = run("otool", ["-L", binary]).split("\n")
      .filter((line) => /^\s+.* \(compatibility version /.test(line))
      .map((line) => line.trim().replace(/ \(compatibility version .*$/, ""))
    assert(libraries.length > 0, `No Mach-O library load commands found: ${name}`)
    for (const library of libraries) assert(library.startsWith("@") || library.startsWith("/System/") || library.startsWith("/usr/lib/"), `Machine-local dylib dependency in ${name}: ${library}`)
  }
  checks.push(`${textFiles} packaged text files contain no reference to this build checkout`, "all five Mach-O binaries use only relative or macOS system library dependencies")
  report = { schemaVersion: 1, identity, build: manifest.build, dmg, sha256: artifact.sha256, copiedApp: keep ? copiedApp : null, icon: { file: iconFile, sha256: sha(iconBytes), bytes: iconBytes.length }, checks, architecture }
  if (outputFile) { mkdirSync(path.dirname(outputFile), { recursive: true }); writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n") }
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (mounted) run("hdiutil", ["detach", mount])
  if (!keep || !report) rmSync(root, { recursive: true, force: true })
}
