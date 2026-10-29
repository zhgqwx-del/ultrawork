/** Derive the macOS ICNS independently of UI, Windows and Linux artwork. */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Resvg } from "@resvg/resvg-js"
import { validatePng } from "./png-image"

export const MACOS_ICON_POLICY = "macos-content-fit-v1"
export const MACOS_ICON_SIZE = 1024
export const MACOS_ICON_CONTENT_SIZE = 824

export interface IconBounds { x: number; y: number; width: number; height: number }
export interface MacosIconMetrics {
  scale: number
  alphaThreshold: number
  boundsBefore: IconBounds | null
  boundsAfter: IconBounds | null
}

/** Alpha >= 128 excludes a normal soft shadow when measuring the icon plate. */
export function alphaBounds(pixels: Uint8Array, width: number, height: number, threshold = 128): IconBounds | null {
  if (pixels.length !== width * height * 4 || threshold < 1 || threshold > 255) throw new Error("Invalid icon pixel dimensions or alpha threshold")
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3]! < threshold) continue
    left = Math.min(left, x); top = Math.min(top, y)
    right = Math.max(right, x); bottom = Math.max(bottom, y)
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

function pngSvg(bytes: Buffer, size: number, x = 0, y = 0, imageSize = size): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image x="${x}" y="${y}" width="${imageSize}" height="${imageSize}" href="data:image/png;base64,${bytes.toString("base64")}"/></svg>`
}

/** Only shrink oversized content; an already padded PNG must not shrink twice.
 * Fully translucent artwork uses all visible pixels instead of an opaque plate.
 * A deliberately blank icon stays blank, rather than dividing by empty bounds.
 */
export function normalizeMacosIcon(bytes: Buffer, extension: string): { png: Buffer } & MacosIconMetrics {
  const kind = extension.toLowerCase()
  let source: Resvg
  let originalSize: number | undefined
  if (kind === ".png") {
    const dimensions = validatePng(bytes, "macOS icon input")
    if (dimensions.width !== dimensions.height) throw new Error("macOS icon input must be square")
    originalSize = dimensions.width
    source = new Resvg(pngSvg(bytes, MACOS_ICON_SIZE), { font: { loadSystemFonts: false } })
  } else if (kind === ".svg") {
    // Keep normal Resvg SVG font resolution; disabling it silently drops text
    // from otherwise supported custom SVG artwork. PNG-only transforms below
    // do not need fonts and remain independent of the host font database.
    source = new Resvg(bytes, { fitTo: { mode: "width", value: MACOS_ICON_SIZE } })
    if (!Number.isFinite(source.width) || source.width <= 0 || source.width !== source.height) throw new Error("macOS icon input must be square")
  } else throw new Error("macOS icon input must be PNG or SVG")
  const raster = source.render()
  if (raster.width !== MACOS_ICON_SIZE || raster.height !== MACOS_ICON_SIZE) throw new Error("macOS icon raster must be 1024px square")
  let alphaThreshold = 128
  let boundsBefore = alphaBounds(raster.pixels, raster.width, raster.height, alphaThreshold)
  if (!boundsBefore) {
    alphaThreshold = 1
    boundsBefore = alphaBounds(raster.pixels, raster.width, raster.height, alphaThreshold)
  }
  const scale = boundsBefore ? Math.min(1, MACOS_ICON_CONTENT_SIZE / Math.max(boundsBefore.width, boundsBefore.height)) : 1
  if (scale === 1) {
    return { png: kind === ".png" && originalSize === MACOS_ICON_SIZE ? bytes : raster.asPng(), scale, alphaThreshold, boundsBefore, boundsAfter: boundsBefore }
  }
  // Center the measured plate, not an accidentally asymmetric source canvas.
  // Keeping the whole raster in the image preserves any soft shadow around it.
  const x = MACOS_ICON_SIZE / 2 - (boundsBefore!.x + boundsBefore!.width / 2) * scale
  const y = MACOS_ICON_SIZE / 2 - (boundsBefore!.y + boundsBefore!.height / 2) * scale
  const result = new Resvg(pngSvg(raster.asPng(), MACOS_ICON_SIZE, x, y, MACOS_ICON_SIZE * scale), { font: { loadSystemFonts: false } }).render()
  return { png: result.asPng(), scale, alphaThreshold, boundsBefore, boundsAfter: alphaBounds(result.pixels, result.width, result.height, alphaThreshold) }
}

/** ICNS chunk order from the native encoder is not stable. Sort the independent
 * representations so generation/check works byte-for-byte on every run.
 */
export function canonicalizeIcns(bytes: Buffer): Buffer {
  if (bytes.length < 8 || bytes.toString("ascii", 0, 4) !== "icns" || bytes.readUInt32BE(4) !== bytes.length) throw new Error("Invalid ICNS header")
  const chunks = new Map<string, Buffer>()
  let offset = 8
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("Truncated ICNS chunk")
    const type = bytes.toString("ascii", offset, offset + 4)
    const length = bytes.readUInt32BE(offset + 4)
    if (length < 8 || offset + length > bytes.length) throw new Error("Invalid ICNS chunk length")
    if (type === "TOC ") throw new Error("ICNS table-of-contents chunks are not supported by this generator")
    if (chunks.has(type)) throw new Error(`Duplicate ICNS representation: ${type}`)
    chunks.set(type, bytes.subarray(offset, offset + length))
    offset += length
  }
  if (!chunks.size) throw new Error("ICNS has no representations")
  return Buffer.concat([bytes.subarray(0, 8), ...[...chunks].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, chunk]) => chunk)])
}

/** Compare decoded pixels while retaining exact legacy data checks. The
 * explicit cross-host option permits one RGB component to round by one level
 * across the entire ICNS; alpha, dimensions and all other data remain exact.
 */
export function equivalentIcnsRepresentations(left: Buffer, right: Buffer, options: { allowSingleRgbRounding?: boolean } = {}): boolean {
  const representations = (bytes: Buffer) => {
    const canonical = canonicalizeIcns(bytes)
    const result = new Map<string, Buffer>()
    for (let offset = 8; offset < canonical.length;) {
      const length = canonical.readUInt32BE(offset + 4)
      const type = canonical.toString("ascii", offset, offset + 4)
      const payload = canonical.subarray(offset + 8, offset + length)
      if (payload.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        const { width, height } = validatePng(payload, `ICNS ${type}`)
        const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${payload.toString("base64")}"/></svg>`, { font: { loadSystemFonts: false } }).render()
        const dimensions = Buffer.alloc(8)
        dimensions.writeUInt32BE(width, 0); dimensions.writeUInt32BE(height, 4)
        result.set(type, Buffer.concat([Buffer.from([1]), dimensions, raster.pixels]))
      } else result.set(type, Buffer.concat([Buffer.from([0]), payload]))
      offset += length
    }
    return result
  }
  const a = representations(left), b = representations(right)
  let remainingRounding = options.allowSingleRgbRounding === true ? 1 : 0
  return a.size === b.size && [...a].every(([type, pixels]) => {
    const other = b.get(type)
    if (!other || pixels.length !== other.length) return false
    if (pixels.equals(other)) return true
    // Each PNG comparison buffer starts with its format marker and dimensions.
    // Legacy data and representation headers never receive a rounding budget.
    if (!remainingRounding || pixels[0] !== 1 || !pixels.subarray(0, 9).equals(other.subarray(0, 9))) return false
    for (let index = 9; index < pixels.length; index++) {
      const delta = Math.abs(pixels[index]! - other[index]!)
      if (!delta) continue
      if (!remainingRounding || (index - 9) % 4 === 3 || delta !== 1) return false
      remainingRounding--
    }
    return true
  })
}

/** Tauri's icon subcommand is cross-platform and never starts the application.
 * All PNG/ICO side products stay in a disposable directory; only ICNS is exported.
 */
export async function writeMacosIcon(inputPath: string, outputIcns: string, rootDir: string, env: NodeJS.ProcessEnv = process.env): Promise<MacosIconMetrics> {
  const { png, ...metrics } = normalizeMacosIcon(readFileSync(inputPath), path.extname(inputPath))
  mkdirSync(path.dirname(outputIcns), { recursive: true })
  const temporary = mkdtempSync(path.join(path.dirname(outputIcns), ".macos-icon-"))
  try {
    const input = path.join(temporary, "normalized.png")
    const native = path.join(temporary, "native")
    writeFileSync(input, png)
    const child = Bun.spawn([process.execPath, "run", "--bun", "tauri", "icon", input, "--output", native], {
      cwd: path.join(rootDir, "packages", "client", "desktop"), env, stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`macOS ICNS generation failed (exit ${code}): ${stderr || stdout}`)
    const result = path.join(temporary, "result.icns")
    writeFileSync(result, canonicalizeIcns(readFileSync(path.join(native, "icon.icns"))))
    renameSync(result, outputIcns)
    return metrics
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
