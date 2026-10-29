import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Resvg } from "@resvg/resvg-js"
import { cleanBrandEnvironment, prepareBrandBuild, PROJECT_ROOT, resolveBrandBuild } from "./brand-build"
import { alphaBounds } from "./macos-icon"
import { acquireBuildLock } from "./build-lock"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function masterIcns(bytes: Buffer): Buffer {
  expect(bytes.toString("ascii", 0, 4)).toBe("icns")
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset + 4)
    expect(length).toBeGreaterThanOrEqual(8)
    if (bytes.toString("ascii", offset, offset + 4) === "ic10") return bytes.subarray(offset + 8, offset + length)
    offset += length
  }
  throw new Error("Missing 1024px ICNS representation")
}
function bounds(bytes: Buffer) {
  const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><image width="1024" height="1024" href="data:image/png;base64,${bytes.toString("base64")}"/></svg>`).render()
  return alphaBounds(raster.pixels, 1024, 1024)
}

test("the active default dev/build ICNS is the checked macOS asset, while shared assets retain their baseline", () => {
  const config = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "packages/client/desktop/src-tauri/tauri.conf.json"), "utf8"))
  const file = config.bundle.icon.find((name: string) => name.endsWith(".icns"))
  expect(file).toBe("icons/icon-macos.icns")
  const png = masterIcns(readFileSync(path.join(PROJECT_ROOT, "packages/client/desktop/src-tauri", file)))
  expect(bounds(png)).toEqual({ x: 100, y: 100, width: 824, height: 824 })
  const baseline = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "branding/default-baseline.json"), "utf8")) as { assets: Record<string, string> }
  for (const [file, expected] of Object.entries(baseline.assets)) {
    const digest = createHash("sha256").update(readFileSync(path.join(PROJECT_ROOT, file))).digest("hex")
    expect(digest).toBe(expected)
  }
})

test("real custom preparation selects the padded ICNS and keeps its UI/PNG/ICO inputs separate", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "brand-macos-config-"))
  directories.push(root)
  const desktop = path.join(root, "packages/client/desktop")
  const tauri = path.join(desktop, "src-tauri")
  mkdirSync(tauri, { recursive: true })
  writeFileSync(path.join(desktop, "package.json"), '{"scripts":{"tauri":"tauri"}}')
  symlinkSync(path.join(PROJECT_ROOT, "packages/client/desktop/node_modules"), path.join(desktop, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  writeFileSync(path.join(tauri, "tauri.conf.json"), JSON.stringify({ app: { windows: [{ title: "Ultrawork" }] }, bundle: { resources: {} } }))
  const skills = path.join(root, "skills/builtin/example")
  mkdirSync(skills, { recursive: true })
  writeFileSync(path.join(skills, "SKILL.md"), "Fixture skill using ~/.ultrawork")
  const input = path.join(PROJECT_ROOT, "branding/mywork/assets/meiyou-app-rounded.png")
  const brand = resolveBrandBuild({ brandId: "iconwork", productName: "IconWork", icon: input }, root, root)
  const lease = acquireBuildLock(root, {})
  try {
  const prepared = await prepareBrandBuild(brand, root)
  const bundle = prepared.config.bundle as { icon: string[] }
  const icon = bundle.icon.find((file) => file.endsWith(".icns"))!
  expect(path.basename(icon)).toBe("icon-macos.icns")
  expect(prepared.env.ULTRAWORK_BRAND_MACOS_ICON).toBe(icon)
  expect(bounds(masterIcns(readFileSync(icon)))).toEqual({ x: 100, y: 100, width: 824, height: 824 })
  expect(readFileSync(prepared.env.ULTRAWORK_BRAND_UI_LOGO!).equals(readFileSync(input))).toBe(true)
  expect(bundle.icon.filter((file) => file.endsWith(".png")).map((file) => path.basename(file))).toEqual(["32x32.png", "128x128.png", "128x128@2x.png"])
  expect(bundle.icon.some((file) => path.basename(file) === "icon.ico")).toBe(true)
  // The normal PNG still fills its canvas; only macOS gets native padding.
  expect(bounds(readFileSync(bundle.icon.find((file) => file.endsWith("32x32.png"))!))!.width).toBe(1024)
  expect(cleanBrandEnvironment(prepared.env).ULTRAWORK_BRAND_MACOS_ICON).toBeUndefined()
  const defaultPrepared = await prepareBrandBuild(resolveBrandBuild({}, root, root), root)
  expect(defaultPrepared.configArgs).toEqual([])
  expect((defaultPrepared.config as { bundle?: unknown }).bundle).toBeUndefined()
  } finally { lease.release() }
}, 30_000)
