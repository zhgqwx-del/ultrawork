/** Bounded PNG validation using the built-in zlib decoder; no native dependency.
 * Decode scanlines (including Adam7 and indexed pixels), rather than trusting IHDR.
 */
import { inflateSync } from "node:zlib"

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c)
  return da <= db && da <= dc ? a : db <= dc ? b : c
}

export function validatePng(bytes: Buffer, name = "PNG"): { width: number; height: number } {
  const invalid = (reason: string): never => { throw new Error(`Invalid PNG (${reason}): ${name}`) }
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) invalid("signature/header")
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0, palette = 0
  let offset = 8, header = false, ended = false, dataStarted = false, dataEnded = false
  let paletteSeen = false, transparencySeen = false
  const compressed: Buffer[] = []
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid("truncated chunk")
    const size = bytes.readUInt32BE(offset)
    if (size > bytes.length - offset - 12) invalid("truncated chunk payload")
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) invalid("chunk type")
    const data = bytes.subarray(offset + 8, offset + 8 + size)
    const checksum = bytes.readUInt32BE(offset + 8 + size)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== checksum) invalid(`${type} CRC`)
    if (!header && type !== "IHDR") invalid("IHDR must be first")
    if (dataStarted && type !== "IDAT") dataEnded = true
    if (type === "IHDR") {
      if (header || size !== 13) invalid("IHDR")
      header = true
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      depth = data[8]; color = data[9]; interlace = data[12]
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!width || !height || width > 8192 || height > 8192 || !depths[color]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || interlace > 1) invalid("dimensions/color/encoding")
    } else if (type === "PLTE") {
      if (paletteSeen || dataStarted || !size || size % 3 || size > 768 || color === 0 || color === 4) invalid("palette")
      paletteSeen = true; palette = size / 3
      if (color === 3 && palette > 2 ** depth) invalid("palette depth")
    } else if (type === "tRNS") {
      if (transparencySeen || dataStarted || (color === 0 ? size !== 2 : color === 2 ? size !== 6 : color === 3 ? !paletteSeen || !size || size > palette : true)) invalid("transparency")
      transparencySeen = true
    } else if (type === "IDAT") {
      if (dataEnded || (color === 3 && !paletteSeen)) invalid("IDAT order")
      dataStarted = true; compressed.push(data)
    } else if (type === "IEND") {
      if (size !== 0 || !dataStarted) invalid("IEND")
      offset += 12
      if (offset !== bytes.length) invalid("data after IEND")
      ended = true
      break
    } else if ((bytes[offset + 4] & 32) === 0) {
      invalid(`unsupported critical chunk ${type}`)
    }
    offset += size + 12
  }
  if (!ended) invalid("missing IEND")

  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const bitsPerPixel = channels[color] * depth
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const steps = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]]
  const passes = steps.map(([x, y, dx, dy]) => {
    const w = width <= x ? 0 : Math.ceil((width - x) / dx)
    const h = height <= y ? 0 : Math.ceil((height - y) / dy)
    return { width: w, height: h, rowBytes: Math.ceil(w * bitsPerPixel / 8) }
  }).filter((pass) => pass.width > 0 && pass.height > 0)
  const expected = passes.reduce((sum, pass) => sum + (pass.rowBytes + 1) * pass.height, 0)
  if (expected > 128 * 1024 * 1024) invalid("decoded image exceeds 128 MiB")
  let decoded: Buffer
  try { decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }) } catch { return invalid("compressed pixel data") }
  if (decoded.length !== expected) invalid("scanline length")
  let cursor = 0
  for (const pass of passes) {
    let previous = Buffer.alloc(pass.rowBytes)
    for (let y = 0; y < pass.height; y++) {
      const filter = decoded[cursor++]
      if (filter > 4) invalid("scanline filter")
      const row = Buffer.allocUnsafe(pass.rowBytes)
      for (let x = 0; x < row.length; x++) {
        const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0
        const up = previous[x]
        const corner = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0
        const prediction = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, corner) : 0
        row[x] = (decoded[cursor++] + prediction) & 255
      }
      if (color === 3) for (let x = 0; x < pass.width; x++) {
        const bit = x * depth
        const index = (row[Math.floor(bit / 8)] >>> (8 - depth - bit % 8)) & ((1 << depth) - 1)
        if (index >= palette) invalid("palette index")
      }
      previous = row
    }
  }
  return { width, height }
}
