import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_BRAND, resolveIdentity, type BrandIdentity } from "../packages/core/brand/src/index"
import { packagedSidecarName, SIDECAR_NAMES } from "./brand-sidecars"
import { assertLinuxInstallLayout, inspectLinuxInstallers, parseDebianFileList, parseRpmFileList } from "./linux-install-layout"

const target = "x86_64-unknown-linux-gnu"
const mywork = resolveIdentity({ brandId: "mywork", productName: "MyWork" })
const spaced = resolveIdentity({ brandId: "space-work", productName: "My Work Edition" })
const temporary: string[] = []
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })
const pathsFor = (identity: BrandIdentity) => [
  `/usr/bin/${identity.mainBinaryName ?? "ultrawork"}`,
  ...SIDECAR_NAMES.map((role) => `/usr/bin/${packagedSidecarName(identity, role, target)}`),
  `/usr/lib/${identity.productName}/skills/builtin/skills-builtin.zip`,
]

test("Debian machine lists accept bare, ./ and absolute paths without splitting product spaces", () => {
  for (const identity of [DEFAULT_BRAND, mywork, spaced]) for (const prefix of ["", "./", "/"]) {
    const expected = pathsFor(identity)
    const listing = ["./", `${prefix}usr/`, `${prefix}usr/bin/`, ...expected.map((file) => prefix + file.slice(1)), ""].join("\r\n")
    expect(parseDebianFileList(listing)).toEqual(expected)
    expect(() => assertLinuxInstallLayout(identity, target, parseDebianFileList(listing))).not.toThrow()
  }
})

test("RPM machine lists retain full filenames and symlinks while excluding directories", () => {
  const expected = pathsFor(spaced)
  const listing = ["drwxr-xr-x /usr/bin", ...expected.map((file, index) => `${index === 0 ? "lrwxrwxrwx" : "-rwxr-xr-x"} ${file}`), ""].join("\r\n")
  expect(parseRpmFileList(listing)).toEqual(expected)
  expect(() => assertLinuxInstallLayout(spaced, target, parseRpmFileList(listing))).not.toThrow()
})

test("machine list parsers reject malformed paths or RPM rows instead of losing them silently", () => {
  for (const value of ["../usr/bin/mywork", "usr/../bin/mywork", "usr/bin/mywork\0ignored", "../usr/"]) expect(() => parseDebianFileList(value)).toThrow("Invalid installer entry")
  for (const value of [" /usr/bin/mywork", "garbage /usr/bin/mywork", "-rwxr-xr-x relative/path"]) expect(() => parseRpmFileList(value)).toThrow("Invalid RPM file-list row")
  expect(() => parseRpmFileList("drwxr-xr-x /usr/../outside")).toThrow("Invalid installer entry")
  expect(parseDebianFileList("\n./\nusr/bin/\n")).toEqual([])
})

test("non-Linux targets do not invoke any package inspection commands", async () => {
  expect(await inspectLinuxInstallers(DEFAULT_BRAND, "aarch64-apple-darwin", "missing-bundle", Date.now())).toEqual([])
})

function command(name: string, args: string[]) {
  const result = spawnSync(name, args, { encoding: "utf8", timeout: 15_000, env: { ...process.env, LC_ALL: "C", TAR_OPTIONS: "" } })
  expect(result.status, `${name}: ${result.error?.message ?? result.stderr}`).toBe(0)
  return result.stdout
}

/** Tiny ar container around real GNU tar archives. Listing uses real dpkg-deb;
 * choosing "usr" or "." as tar input reproduces both Tauri's bare entries and
 * the ./ entries made by traditional Debian package builders. */
function debFixture(identity: BrandIdentity, dotted: boolean, options: { missing?: string; foreign?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "linux-layout-deb-"))
  temporary.push(root)
  const payload = path.join(root, "payload"), control = path.join(root, "control"), bundle = path.join(root, "bundle")
  mkdirSync(payload); mkdirSync(control); mkdirSync(bundle)
  for (const file of [...pathsFor(identity), ...(options.foreign ? [options.foreign] : [])]) {
    if (file === options.missing) continue
    const output = path.join(payload, file.slice(1))
    mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, "fixture payload\n")
  }
  writeFileSync(path.join(control, "control"), `Package: layout-fixture-${identity.brandId}\nVersion: 1.0.0\nArchitecture: all\nMaintainer: Fixture <fixture@example.invalid>\nDescription: Installer pathname inspection fixture\n`)
  const controlTar = path.join(root, "control.tar.gz"), dataTar = path.join(root, "data.tar.gz")
  command("tar", ["--create", "--gzip", "--file", controlTar, "--directory", control, "."])
  command("tar", ["--create", "--gzip", "--file", dataTar, "--directory", payload, dotted ? "." : "usr"])
  const file = path.join(bundle, `${identity.productName} ${dotted ? "dotted" : "bare"}.deb`)
  const parts = [Buffer.from("!<arch>\n")]
  for (const [name, content] of [["debian-binary", Buffer.from("2.0\n")], ["control.tar.gz", readFileSync(controlTar)], ["data.tar.gz", readFileSync(dataTar)]] as const) {
    const header = `${(name + "/").padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(content.length).padEnd(10)}\x60\n`
    expect(Buffer.byteLength(header)).toBe(60)
    parts.push(Buffer.from(header), content)
    if (content.length % 2) parts.push(Buffer.from("\n"))
  }
  writeFileSync(file, Buffer.concat(parts))
  // Tools are mandatory on Linux CI. An absent/broken dpkg-deb fails this
  // positive control rather than turning native coverage into a silent skip.
  command("dpkg-deb", ["--info", file])
  return { root, bundle, file }
}

const linuxTest = process.platform === "linux" ? test : test.skip
linuxTest("real dpkg-deb and streamed tar inspect bare and dotted packages for both brands and space names", async () => {
  for (const identity of [DEFAULT_BRAND, mywork, spaced]) for (const dotted of [false, true]) {
    const fixture = debFixture(identity, dotted)
    const layouts = await inspectLinuxInstallers(identity, target, fixture.bundle, 0)
    expect(layouts).toHaveLength(1)
    expect(layouts[0]!.file).toBe(path.basename(fixture.file))
    expect(layouts[0]!.installedFiles.sort()).toEqual(pathsFor(identity).sort())
  }
}, 30_000)

linuxTest("real Debian inspection rejects missing or shared binaries and identifies the exact package", async () => {
  const missing = `/usr/bin/${packagedSidecarName(mywork, "acp-client", target)}`
  for (const [options, problem] of [[{ missing }, `missing ${missing}`], [{ foreign: "/usr/bin/acp-client" }, "overwrite another brand"]] as const) {
    const fixture = debFixture(mywork, false, options)
    let message = ""
    try { await inspectLinuxInstallers(mywork, target, fixture.bundle, 0) } catch (error) { message = String(error) }
    expect(message).toContain(path.basename(fixture.file))
    expect(message).toContain(problem)
    expect(message).toContain("Listing:")
    expect(message).toContain("usr/bin/mywork")
  }
}, 15_000)

linuxTest("corrupt Debian payload reports both command exits without treating a failed pipe as a valid list", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "linux-layout-corrupt-")); temporary.push(root)
  const file = path.join(root, "corrupt.deb")
  writeFileSync(file, "not a Debian archive")
  let message = ""
  try { await inspectLinuxInstallers(DEFAULT_BRAND, target, root, 0) } catch (error) { message = String(error) }
  expect(message).toContain("corrupt.deb")
  expect(message).toContain("dpkg-deb → tar exit codes:")
  expect(message).toContain("Listing:")
})
