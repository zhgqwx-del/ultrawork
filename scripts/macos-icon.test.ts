import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Resvg } from "@resvg/resvg-js"
import { DEFAULT_MACOS_ICON_FILE, generateDefaultMacosIcon, MACOS_ICON_PROJECT_ROOT } from "./gen-macos-icon"
import { alphaBounds, canonicalizeIcns, equivalentIcnsRepresentations, MACOS_ICON_CONTENT_SIZE, normalizeMacosIcon, writeMacosIcon } from "./macos-icon"
import { validatePng } from "./png-image"

const root = MACOS_ICON_PROJECT_ROOT
const source = path.join(root, "design", "logo", "icon-1024.png")
const branded = path.join(root, "branding", "mywork", "assets", "meiyou-app-rounded.png")
const icons = path.join(root, "packages", "client", "desktop", "src-tauri", "icons")
const svg = (body: string, size = 1024) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${body}</svg>`)
const png = (body: string, size = 1024) => new Resvg(svg(body, size), { font: { loadSystemFonts: false } }).render().asPng()

function decoded(bytes: Buffer) {
  const { width, height } = validatePng(bytes)
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${bytes.toString("base64")}"/></svg>`, { font: { loadSystemFonts: false } }).render()
}
function alpha(bytes: Buffer) {
  const raster = decoded(bytes)
  return Buffer.from(raster.pixels.filter((_, index) => index % 4 === 3))
}
function chunks(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("icns")
  expect(bytes.readUInt32BE(4)).toBe(bytes.length)
  const result = new Map<string, Buffer>()
  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset + 4)
    expect(length).toBeGreaterThanOrEqual(8)
    expect(offset + length).toBeLessThanOrEqual(bytes.length)
    const type = bytes.toString("ascii", offset, offset + 4)
    expect(result.has(type)).toBe(false)
    result.set(type, bytes.subarray(offset + 8, offset + length))
    offset += length
  }
  expect(offset).toBe(bytes.length)
  return result
}

function saveIcnsDifference(expected: Buffer, actual: Buffer) {
  const output = path.join(root, ".brand-build", "verification", "icns-ci-diff", `${process.platform}-${process.arch}`)
  mkdirSync(output, { recursive: true })
  writeFileSync(path.join(output, "checked.icns"), expected)
  writeFileSync(path.join(output, "generated.icns"), actual)
  writeFileSync(path.join(output, "normalized-source.png"), normalizeMacosIcon(readFileSync(source), ".png").png)
  writeFileSync(path.join(output, "source.png"), readFileSync(source))
  const a = chunks(expected), b = chunks(actual)
  const difference = (left: Uint8Array, right: Uint8Array, rgba: boolean) => {
    let differentComponents = 0, maximumDelta = 0, differentAlphaComponents = 0, maximumAlphaDelta = 0
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const delta = Math.abs(left[index]! - right[index]!)
      if (!delta) continue
      differentComponents++; maximumDelta = Math.max(maximumDelta, delta)
      if (rgba && index % 4 === 3) { differentAlphaComponents++; maximumAlphaDelta = Math.max(maximumAlphaDelta, delta) }
    }
    return { leftComponents: left.length, rightComponents: right.length, differentComponents, maximumDelta, ...(rgba ? { differentAlphaComponents, maximumAlphaDelta } : {}) }
  }
  const representations = [...new Set([...a.keys(), ...b.keys()])].sort().map((type) => {
    const left = a.get(type), right = b.get(type)
    if (!left || !right) return { type, kind: "missing", expected: !!left, actual: !!right }
    const png = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    if (png(left) && png(right)) {
      writeFileSync(path.join(output, `checked-${type}.png`), left)
      writeFileSync(path.join(output, `generated-${type}.png`), right)
      const before = decoded(left), after = decoded(right)
      return { type, kind: "png", encodedBytesEqual: left.equals(right), expectedDimensions: [before.width, before.height], actualDimensions: [after.width, after.height], ...difference(before.pixels, after.pixels, true) }
    }
    const alphaMask = type === "s8mk" || type === "l8mk"
    return { type, kind: alphaMask ? "legacy-alpha-mask" : "legacy-encoded-rgb", encodedBytesEqual: left.equals(right), ...(alphaMask ? { dimensions: type === "s8mk" ? [16, 16] : [32, 32], alphaDifference: difference(left, right, false) } : { encodedDifference: difference(left, right, false) }) }
  })
  const report = { platform: process.platform, arch: process.arch, bun: Bun.version, expectedBytes: expected.length, actualBytes: actual.length, representations }
  writeFileSync(path.join(output, "difference.json"), JSON.stringify(report, null, 2) + "\n")
  console.error("ICNS cross-platform difference:", JSON.stringify(report, null, 2))
}

test("both brands have the same centered 824px macOS plate and preserve their original master", () => {
  const defaultBefore = readFileSync(source), myworkBefore = readFileSync(branded)
  const a = normalizeMacosIcon(defaultBefore, ".png"), b = normalizeMacosIcon(myworkBefore, ".png")
  expect(a.boundsAfter).toEqual({ x: 100, y: 100, width: 824, height: 824 })
  expect(b.boundsAfter).toEqual(a.boundsAfter)
  expect(alpha(b.png).equals(alpha(a.png))).toBe(true)
  for (const result of [a, b]) {
    expect(validatePng(result.png)).toEqual({ width: 1024, height: 1024 })
    expect(result.scale).toBe(824 / 1024)
    const twice = normalizeMacosIcon(result.png, ".png")
    expect(twice.scale).toBe(1)
    expect(twice.png.equals(result.png)).toBe(true)
  }
  expect(readFileSync(source).equals(defaultBefore)).toBe(true)
  expect(readFileSync(branded).equals(myworkBefore)).toBe(true)
})

test("existing transparent margins are preserved instead of being padded repeatedly", () => {
  for (const size of [824, 640, 100]) {
    const inset = (1024 - size) / 2
    const image = png(`<rect x="${inset}" y="${inset}" width="${size}" height="${size}" fill="#e01e5a"/>`)
    const result = normalizeMacosIcon(image, ".png")
    expect(result.scale).toBe(1)
    expect(result.png.equals(image)).toBe(true)
    expect(result.boundsAfter).toEqual({ x: inset, y: inset, width: size, height: size })
  }
})

test("SVG and off-center artwork are fitted by their visible plate and stay centered", () => {
  const result = normalizeMacosIcon(svg('<rect x="0" y="0" width="900" height="900" fill="#ff8800"/>'), ".svg")
  expect(result.boundsBefore).toEqual({ x: 0, y: 0, width: 900, height: 900 })
  expect(result.boundsAfter).toEqual({ x: 100, y: 100, width: 824, height: 824 })
  const raster = decoded(result.png)
  // Downscaling solid colors must not recolor their fully opaque center.
  expect([...raster.pixels.subarray((512 * 1024 + 512) * 4, (512 * 1024 + 512) * 4 + 4)]).toEqual([255, 136, 0, 255])
  const second = normalizeMacosIcon(result.png, ".png")
  expect(second.png.equals(result.png)).toBe(true)
  expect(() => normalizeMacosIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"/>'), ".svg")).toThrow("square")
  expect(() => normalizeMacosIcon(Buffer.from("not an icon"), ".ico")).toThrow("PNG or SVG")
})

test("normal shadows do not control plate size; translucent/blank artwork has explicit fallbacks", () => {
  const shadowed = png('<rect width="1024" height="1024" fill="black" opacity="0.1"/><rect x="100" y="100" width="824" height="824" fill="red"/>')
  const result = normalizeMacosIcon(shadowed, ".png")
  expect(result.alphaThreshold).toBe(128)
  expect(result.scale).toBe(1)
  expect(result.png.equals(shadowed)).toBe(true)
  const translucent = normalizeMacosIcon(png('<rect width="1024" height="1024" fill="red" opacity="0.25"/>'), ".png")
  expect(translucent.alphaThreshold).toBe(1)
  expect(translucent.boundsAfter).not.toBeNull()
  // Bilinear edge coverage may include one low-alpha boundary pixel per side.
  expect(translucent.boundsAfter!.width).toBeLessThanOrEqual(MACOS_ICON_CONTENT_SIZE + 2)
  const blank = png("")
  const empty = normalizeMacosIcon(blank, ".png")
  expect(empty.boundsAfter).toBeNull()
  expect(empty.scale).toBe(1)
  expect(empty.png.equals(blank)).toBe(true)
})

test("ICNS semantic comparison ignores PNG encoding metadata while checking all pixels and legacy data", () => {
  const archive = (image: Buffer, legacy = Buffer.from([1, 2, 3]), type = "ic10", secondImage?: Buffer) => {
    const representation = (name: string, data: Buffer) => {
      const header = Buffer.alloc(8); header.write(name, "ascii"); header.writeUInt32BE(data.length + 8, 4)
      return Buffer.concat([header, data])
    }
    const body = Buffer.concat([representation(type, image), representation("s8mk", legacy), ...(secondImage ? [representation("ic09", secondImage)] : [])])
    const header = Buffer.alloc(8); header.write("icns", "ascii"); header.writeUInt32BE(body.length + 8, 4)
    return Buffer.concat([header, body])
  }
  const image = png('<rect width="1" height="1" fill="red"/>', 1)
  const metadata = Buffer.from("Comment\0different PNG encoding")
  const chunkHeader = Buffer.alloc(8); chunkHeader.writeUInt32BE(metadata.length); chunkHeader.write("tEXt", 4, "ascii")
  const crc = Buffer.alloc(4); crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([chunkHeader.subarray(4), metadata])))
  const annotated = Buffer.concat([image.subarray(0, 33), chunkHeader, metadata, crc, image.subarray(33)])
  expect(archive(image).equals(archive(annotated))).toBe(false)
  expect(equivalentIcnsRepresentations(archive(image), archive(annotated))).toBe(true)
  expect(equivalentIcnsRepresentations(archive(image), archive(png('<rect width="1" height="1" fill="blue"/>', 1)))).toBe(false)
  expect(equivalentIcnsRepresentations(archive(image), archive(png('<rect width="2" height="2" fill="red"/>', 2)))).toBe(false)
  expect(equivalentIcnsRepresentations(archive(image), archive(image, Buffer.from([1, 2, 4])))).toBe(false)
  expect(equivalentIcnsRepresentations(archive(image), archive(image, undefined, "ic09"))).toBe(false)
  const oneRgbLevel = png('<rect width="1" height="1" fill="#fe0000"/>', 1)
  const crossHost = { allowSingleRgbRounding: true }
  expect(equivalentIcnsRepresentations(archive(image), archive(oneRgbLevel))).toBe(false)
  expect(equivalentIcnsRepresentations(archive(image), archive(oneRgbLevel), crossHost)).toBe(true)
  expect(equivalentIcnsRepresentations(archive(oneRgbLevel), archive(image), crossHost)).toBe(true)
  expect(equivalentIcnsRepresentations(archive(image), archive(png('<rect width="1" height="1" fill="#fd0000"/>', 1)), crossHost)).toBe(false)
  expect(equivalentIcnsRepresentations(archive(image), archive(png('<rect width="1" height="1" fill="#fe0100"/>', 1)), crossHost)).toBe(false)
  const opaqueBlack = png('<rect width="1" height="1" fill="black"/>', 1)
  const fadedBlack = png('<rect width="1" height="1" fill="black" opacity="0.996"/>', 1)
  expect([decoded(opaqueBlack).pixels[3], decoded(fadedBlack).pixels[3]]).toEqual([255, 254])
  expect(equivalentIcnsRepresentations(archive(opaqueBlack), archive(fadedBlack), crossHost)).toBe(false)
  expect(equivalentIcnsRepresentations(archive(image), archive(image, Buffer.from([1, 2, 4])), crossHost)).toBe(false)
  expect(equivalentIcnsRepresentations(archive(image), archive(image, undefined, "ic09"), crossHost)).toBe(false)
  const redGrid = png('<rect width="2" height="2" fill="red"/>', 2)
  const roundedGrid = png('<rect width="2" height="2" fill="#fe0000"/>', 2)
  expect(equivalentIcnsRepresentations(archive(image), archive(redGrid), crossHost)).toBe(false)
  expect(equivalentIcnsRepresentations(archive(redGrid), archive(roundedGrid), crossHost)).toBe(false)
  expect(equivalentIcnsRepresentations(archive(image, undefined, "ic10", image), archive(oneRgbLevel, undefined, "ic10", oneRgbLevel), crossHost)).toBe(false)
})

test("text SVGs supported by Tauri stay visible with normal font resolution in the new ICNS", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uw-macos-text-icon-"))
  try {
    const input = path.join(directory, "text.svg")
    const reference = path.join(directory, "tauri-reference")
    // Arial is provided by macOS/Windows; the Linux CI fixture installs
    // Liberation Sans. Keep both renderers on the same explicit font list.
    writeFileSync(input, svg('<text x="100" y="700" font-family="Arial,Liberation Sans,DejaVu Sans,sans-serif" font-size="600">M</text>'))
    const child = Bun.spawn([process.execPath, "run", "--bun", "tauri", "icon", input, "--output", reference], {
      cwd: path.join(root, "packages", "client", "desktop"), stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code, error: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, error: "" })
    const original = decoded(readFileSync(path.join(reference, "icon.png")))
    const originalBounds = alphaBounds(original.pixels, original.width, original.height)
    expect(originalBounds).not.toBeNull()
    const output = path.join(directory, "text-macos.icns")
    const metrics = await writeMacosIcon(input, output, root)
    expect(metrics.boundsBefore).not.toBeNull()
    const normalized = decoded(chunks(readFileSync(output)).get("ic10")!)
    const normalizedBounds = alphaBounds(normalized.pixels, normalized.width, normalized.height)
    expect(normalizedBounds).not.toBeNull()
    // Each platform supplies its own normal font resolver. Compare against
    // Tauri on that same host, rather than assuming one OS's glyph pixels.
    expect(Math.abs(normalizedBounds!.width / normalized.width - originalBounds!.width / original.width)).toBeLessThan(0.02)
    expect(Math.abs(normalizedBounds!.height / normalized.height - originalBounds!.height / original.height)).toBeLessThan(0.02)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 60_000)

test("ICNS generation is deterministic, fits every native representation, and exports only ICNS", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uw-macos-icons-"))
  const unchanged = new Map(["icon.icns", "icon.ico", "32x32.png", "128x128.png", "128x128@2x.png", "tray-template@2x.png"].map((name) => [name, readFileSync(path.join(icons, name))]))
  const inputs = [readFileSync(source), readFileSync(branded)]
  try {
    const output = path.join(directory, "icon-macos.icns")
    const custom = path.join(directory, "mywork-macos.icns")
    writeFileSync(path.join(directory, "icon.png"), "PNG neighbor must stay untouched")
    writeFileSync(path.join(directory, "icon.ico"), "ICO neighbor must stay untouched")
    await writeMacosIcon(source, output, root)
    const first = readFileSync(output)
    await writeMacosIcon(source, output, root)
    expect(readFileSync(output).equals(first)).toBe(true)
    await writeMacosIcon(branded, custom, root)
    const a = chunks(first), b = chunks(readFileSync(custom))
    expect([...a.keys()]).toEqual([...a.keys()].sort())
    expect([...b.keys()]).toEqual([...a.keys()])
    let pngCount = 0, legacyCount = 0
    for (const [type, representation] of a) {
      if (representation[0] === 137) {
        const raster = decoded(representation)
        const bounds = alphaBounds(raster.pixels, raster.width, raster.height)!
        expect(bounds).not.toBeNull()
        expect(bounds.width / raster.width).toBeGreaterThan(0.75)
        expect(bounds.width / raster.width).toBeLessThan(0.85)
        expect(Math.abs(bounds.x - (raster.width - bounds.x - bounds.width))).toBeLessThanOrEqual(1)
        expect(Math.abs(bounds.y - (raster.height - bounds.y - bounds.height))).toBeLessThanOrEqual(1)
        expect(alpha(b.get(type)!).equals(alpha(representation))).toBe(true)
        pngCount++
      } else if (type === "s8mk" || type === "l8mk") {
        expect(b.get(type)!.equals(representation)).toBe(true)
        legacyCount++
      }
    }
    expect([pngCount, legacyCount]).toEqual([8, 2])
    expect(readFileSync(path.join(directory, "icon.png"), "utf8")).toBe("PNG neighbor must stay untouched")
    expect(readFileSync(path.join(directory, "icon.ico"), "utf8")).toBe("ICO neighbor must stay untouched")
    expect(readdirSync(directory).sort()).toEqual(["icon-macos.icns", "icon.ico", "icon.png", "mywork-macos.icns"])
    expect(readFileSync(source).equals(inputs[0]!)).toBe(true)
    expect(readFileSync(branded).equals(inputs[1]!)).toBe(true)
    for (const [name, before] of unchanged) expect(readFileSync(path.join(icons, name)).equals(before)).toBe(true)
    // This proves the checked-in default resource is generated from the same
    // pipeline dev and packaging will reference, rather than an unrelated image.
    const checked = readFileSync(path.join(root, DEFAULT_MACOS_ICON_FILE))
    const equivalent = equivalentIcnsRepresentations(checked, first, { allowSingleRgbRounding: process.platform !== "darwin" })
    const matches = process.platform === "darwin" ? checked.equals(first) : equivalent
    if (!matches || !equivalent) saveIcnsDifference(checked, first)
    expect(matches).toBe(true)
    expect(equivalent).toBe(true)
    expect(equivalentIcnsRepresentations(first, readFileSync(custom))).toBe(false)
    await generateDefaultMacosIcon(true, root)
    expect(canonicalizeIcns(first).equals(first)).toBe(true)
    const malformed = Buffer.from(first)
    malformed.writeUInt32BE(7, 12)
    expect(() => canonicalizeIcns(malformed)).toThrow("chunk length")
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 90_000)
