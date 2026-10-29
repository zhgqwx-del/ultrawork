import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Resvg } from "@resvg/resvg-js"
import { DEFAULT_ICON_MASTER, ICON_PROJECT_ROOT, MYWORK_ICON_OUTPUT, MYWORK_ICON_SOURCE, myworkIconArtifacts, renderMyworkIcon } from "./gen-mywork-icon"
import { validatePng } from "./png-image"

const read = (file: string) => readFileSync(path.join(ICON_PROJECT_ROOT, file))
const defaultIcons = path.join(ICON_PROJECT_ROOT, "packages", "client", "desktop", "src-tauri", "icons")

function decode(bytes: Buffer) {
  const { width, height } = validatePng(bytes)
  const rendered = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${bytes.toString("base64")}"/></svg>`, { font: { loadSystemFonts: false } }).render()
  const rgba = rendered.pixels
  const alpha = Buffer.alloc(width * height)
  for (let index = 0; index < alpha.length; index++) alpha[index] = rgba[index * 4 + 3]
  return { width, height, rgba, alpha }
}

function matchingSilhouette(original: Buffer, branded: Buffer) {
  const a = decode(original), b = decode(branded)
  expect([b.width, b.height]).toEqual([a.width, a.height])
  // Equality of every alpha value also proves identical visible bounds,
  // transparent padding, rounded corners and antialiasing at this size.
  expect(b.alpha.equals(a.alpha)).toBe(true)
}

function icnsChunks(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("icns")
  expect(bytes.readUInt32BE(4)).toBe(bytes.length)
  const chunks = new Map<string, Buffer>()
  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset + 4)
    expect(length).toBeGreaterThanOrEqual(8)
    expect(offset + length).toBeLessThanOrEqual(bytes.length)
    const type = bytes.toString("ascii", offset, offset + 4)
    expect(chunks.has(type)).toBe(false)
    chunks.set(type, bytes.subarray(offset + 8, offset + length))
    offset += length
  }
  expect(offset).toBe(bytes.length)
  return chunks
}

function icoEntries(bytes: Buffer) {
  expect(bytes.readUInt16LE(0)).toBe(0)
  expect(bytes.readUInt16LE(2)).toBe(1)
  const entries = new Map<number, Buffer>()
  for (let index = 0; index < bytes.readUInt16LE(4); index++) {
    const offset = 6 + index * 16
    const width = bytes[offset] || 256, height = bytes[offset + 1] || 256
    expect(width).toBe(height)
    expect(bytes.readUInt16LE(offset + 6)).toBe(32)
    const size = bytes.readUInt32LE(offset + 8), start = bytes.readUInt32LE(offset + 12)
    expect(start + size).toBeLessThanOrEqual(bytes.length)
    expect(entries.has(width)).toBe(false)
    entries.set(width, bytes.subarray(start, start + size))
  }
  return entries
}

test("MyWork derived icon and provenance are reproducible; preset selects the rounded asset", () => {
  const artifacts = myworkIconArtifacts()
  expect(readFileSync(artifacts.imageFile).equals(artifacts.image)).toBe(true)
  expect(JSON.parse(readFileSync(artifacts.provenanceFile, "utf8"))).toEqual(artifacts.provenance)
  const brand = JSON.parse(read(path.join("branding", "mywork", "brand.json")).toString("utf8"))
  expect(path.resolve(ICON_PROJECT_ROOT, "branding", "mywork", brand.icon)).toBe(path.join(ICON_PROJECT_ROOT, MYWORK_ICON_OUTPUT))
  expect(brand.trayIcon).toBe("./assets/meiyou-tray.png")
})

test("MyWork master preserves official opaque pixels and exactly copies the default alpha silhouette", () => {
  const original = decode(read(MYWORK_ICON_SOURCE))
  const maskBytes = read(DEFAULT_ICON_MASTER), outputBytes = read(MYWORK_ICON_OUTPUT)
  const output = decode(outputBytes)
  matchingSilhouette(maskBytes, outputBytes)
  expect([output.width, output.height]).toEqual([1024, 1024])
  expect(original.alpha.every((value) => value === 255)).toBe(true)
  expect(output.alpha[0]).toBe(0)
  expect(output.alpha[output.width / 2]).toBe(255)
  let changedOpaquePixels = 0
  for (let index = 0; index < output.alpha.length; index++) {
    if (output.alpha[index] !== 255) continue
    const offset = index * 4
    if (!output.rgba.subarray(offset, offset + 3).equals(original.rgba.subarray(offset, offset + 3))) changedOpaquePixels++
  }
  expect(changedOpaquePixels).toBe(0)
  expect(() => renderMyworkIcon(read(MYWORK_ICON_SOURCE), readFileSync(path.join(defaultIcons, "32x32.png")))).toThrow("matching square dimensions")
}, 30_000)

test("base Tauri PNG/ICO and retained legacy ICNS templates match default sizes and alpha masks", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "mywork-native-icons-"))
  try {
    // The icon subcommand only writes image assets to this disposable folder;
    // it does not build or launch the app, or access application user data.
    const child = Bun.spawn([process.execPath, "run", "--bun", "tauri", "icon", path.join(ICON_PROJECT_ROOT, MYWORK_ICON_OUTPUT), "--output", directory], {
      cwd: path.join(ICON_PROJECT_ROOT, "packages", "client", "desktop"), stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code, error: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, error: "" })
    const pngs = readdirSync(defaultIcons).filter((name) => name.endsWith(".png") && !name.startsWith("tray-"))
    expect(pngs.length).toBe(15)
    for (const file of pngs) matchingSilhouette(readFileSync(path.join(defaultIcons, file)), readFileSync(path.join(directory, file)))

    const defaultIcns = icnsChunks(readFileSync(path.join(defaultIcons, "icon.icns")))
    const customIcns = icnsChunks(readFileSync(path.join(directory, "icon.icns")))
    expect([...customIcns.keys()].sort()).toEqual([...defaultIcns.keys()].sort())
    let pngCount = 0, legacyAlphaCount = 0
    for (const [type, bytes] of defaultIcns) {
      if (bytes[0] === 137) { matchingSilhouette(bytes, customIcns.get(type)!); pngCount++ }
      else if (type === "s8mk" || type === "l8mk") { expect(customIcns.get(type)!.equals(bytes)).toBe(true); legacyAlphaCount++ }
    }
    expect([pngCount, legacyAlphaCount]).toEqual([8, 2])

    const defaultIco = icoEntries(readFileSync(path.join(defaultIcons, "icon.ico")))
    const customIco = icoEntries(readFileSync(path.join(directory, "icon.ico")))
    expect([...defaultIco.keys()].sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 256])
    expect([...customIco.keys()].sort()).toEqual([...defaultIco.keys()].sort())
    for (const [size, bytes] of defaultIco) matchingSilhouette(bytes, customIco.get(size)!)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 180_000)
