/**
 * Composer attachments — classification, limits, and the File/bytes → wire-part mapping.
 *
 * Pure helpers (no React, no Tauri) so they stay unit-testable. See
 * docs/discussions/039-multimodal-input-attachments.md.
 *
 * Two URLs per attachment, deliberately:
 *   - `wireUrl`    what we send.
 *                  IMAGES are always inlined as a downscaled `data:` URL, even when they
 *                  came off disk. Sending `file://` would be cheaper on the wire, but the
 *                  server then reads the ORIGINAL file — so a dragged-in 4K screenshot
 *                  would reach the model at full size and MAX_IMAGE_EDGE would be a lie.
 *                  We have to read the bytes for the thumbnail anyway, so we downscale
 *                  once and inline the result.
 *                  PDFs and text files on disk use `file://`: no preview is needed and no
 *                  resizing applies, so the server reads them off disk itself rather than us
 *                  shipping the bytes back out through the request body. Note this saves the
 *                  REQUEST body, not the model: for a PDF the server expands `file://` into a
 *                  base64 `data:` part anyway, so the model still pays for every byte — which
 *                  is why inlineBytesOf charges PDFs their full file size.
 *   - `previewUrl` what the composer and the optimistic bubble render. NEVER `file://`:
 *                  the WebView is served from http://localhost and refuses `file://`
 *                  subresources, so it would render as a broken image until the server's
 *                  reply arrives (the server rewrites `file://` into `data:` on persist).
 */

import { pathBasename } from "@/lib/path-utils"

export const MAX_ATTACHMENTS = 10

/** Screenshots are routinely 4K+. Images wider/taller than this are downscaled before
 *  sending: a 3840px screenshot costs a lot of tokens and no model needs that detail. */
export const MAX_IMAGE_EDGE = 1600

/**
 * Per-kind byte caps.
 *
 * A single 5 MB cap for everything was wrong in BOTH directions, because bytes are simply
 * not what bounds the cost:
 *   - images  → the cost is bounded by MAX_IMAGE_EDGE (we downscale), so the SOURCE can be
 *               large. A 12 MB phone photo becomes ~1 MB; rejecting it was a false negative.
 *   - text    → the server's Read tool reads at most 50 KB / 2000 lines and tells the model
 *               "use offset=N to continue", so a 20 MB log is genuinely harmless. Rejecting
 *               it was also a false negative.
 *   - pdf     → bytes say nothing: a 2 MB PDF can be 300 pages. The real bound is page count
 *               (MAX_INLINE_PDF_PAGES); this cap only stops us reading something absurd into
 *               memory in order to count them.
 *   - document→ copied into the workspace and read by the agent, never inlined.
 */
export const MAX_BYTES: Record<AttachmentKind, number> = {
  image: 30 * 1024 * 1024,
  text: 50 * 1024 * 1024,
  // NOT generous, unlike the others: an inlined PDF is read WHOLE by the server (it rewrites
  // `file://` into a base64 `data:` URL — verified against a live sidecar), so every one of
  // these bytes reaches the provider ×4/3. Anything bigger becomes a `document`.
  pdf: 8 * 1024 * 1024,
  document: 100 * 1024 * 1024,
}

/**
 * Ceiling on decoded pixels for an image we are willing to hand to the decoder.
 *
 * File size does not bound this: a 30000×30000 flat-colour PNG compresses to ~200 KB and
 * would sail through MAX_BYTES.image, then ask the decoder for 30000×30000×4 ≈ 3.6 GB of
 * RGBA and take the whole WebView down with it. Screens are ~8 MPix; 40 MPix is already
 * far beyond any real screenshot or phone photo.
 */
export const MAX_IMAGE_PIXELS = 40_000_000

/**
 * A PDF longer than this is NOT inlined. The server would otherwise base64 the whole file
 * into the prompt with no truncation whatsoever (vendor prompt.ts has no page limit), and a
 * multimodal model pays roughly 1.5–3k tokens per page — a 200-page PDF is a third of a
 * million tokens before the user has said anything. Past the limit it becomes a `document`:
 * copied into the workspace, path handed to the agent, read in pieces on demand.
 */
export const MAX_INLINE_PDF_PAGES = 20

/** Ceiling on what one prompt body may carry inline, across all attachments. */
export const MAX_INLINE_TOTAL_BYTES = 15 * 1024 * 1024

/**
 * What the server will do with this file (vendor `session/prompt.ts` `resolvePart`).
 * The mime we put on the wire follows from this, and getting it wrong fails loudly:
 * a real mime on a .docx makes the server hand raw base64 to the provider.
 */
export type AttachmentKind =
  | "image" // true multimodal — needs the model's capabilities.input.image
  | "pdf" // true multimodal — needs capabilities.input.pdf
  | "text" // sent as mime text/plain; the server inlines it via its Read tool
  | "document" // docx/xlsx/… — NOT inlinable; copied into the workspace, path handed to the agent

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif"])
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml",
  "html", "htm", "css", "scss", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "swift", "sh", "bash", "zsh", "sql", "log", "env", "conf",
  // SVG is markup, and the server explicitly excludes it from images (vendor read.ts) — if we
  // sent it as image/svg+xml the model would get a file part it cannot decode.
  "svg",
])

export function extensionOf(filename: string): string {
  const base = pathBasename(filename)
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase()
}

export function classify(filename: string, mime?: string): AttachmentKind {
  const ext = extensionOf(filename)
  // Trust the extension over the OS-provided mime: browsers hand us "" or
  // "application/octet-stream" often enough that mime alone misroutes files.
  if (IMAGE_EXTS.has(ext)) return "image"
  if (ext === "pdf") return "pdf"
  if (TEXT_EXTS.has(ext)) return "text"
  if (!ext && mime?.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  if (mime?.startsWith("text/")) return "text"
  return "document"
}

/** The mime to put on the wire — NOT necessarily the file's real mime. */
export function wireMime(kind: AttachmentKind, realMime: string, filename: string): string {
  switch (kind) {
    case "image":
      // A real image mime is required; fall back by extension when the OS gave us nothing.
      if (realMime.startsWith("image/")) return realMime
      return `image/${extensionOf(filename) === "jpg" ? "jpeg" : extensionOf(filename) || "png"}`
    case "pdf":
      return "application/pdf"
    case "text":
      // Always text/plain — this is what routes the file through the server's Read tool.
      return "text/plain"
    case "document":
      // Never sent as a file part. Callers must route documents through the workspace copy.
      return "application/octet-stream"
  }
}

export interface Attachment {
  id: string
  kind: AttachmentKind
  /** mime as it will be sent (see wireMime). */
  mime: string
  filename: string
  /** `data:` or `file://` — what goes to the server. */
  wireUrl: string
  /** `data:`/`blob:` for local rendering only. Absent for non-previewable kinds. */
  previewUrl?: string
  size: number
  /**
   * The source file on disk, for every attachment that has one.
   *
   * Needed at send time, not just at attach time: a `file://` attachment is a promise about a
   * file that the user can still eject, move or truncate before hitting send, and the server's
   * failure to read a missing `file://` part is an `Effect.die` defect rather than an error we
   * could surface. Documents also copy FROM here.
   */
  srcPath?: string
}

export function isImage(a: Attachment): boolean {
  return a.kind === "image"
}

/**
 * Human-facing reason this file can't be attached, or null when it's fine.
 * Returns an i18n key plus params so callers can localise.
 */
export function rejectionOf(
  file: { name: string; size: number },
  kind: AttachmentKind,
  existing: number,
): { key: string; params?: Record<string, string | number> } | null {
  if (existing >= MAX_ATTACHMENTS) {
    return { key: "attachment.tooMany", params: { max: MAX_ATTACHMENTS } }
  }
  const cap = MAX_BYTES[kind]
  if (file.size > cap) {
    return {
      key: "attachment.tooLarge",
      params: { name: pathBasename(file.name), max: Math.round(cap / 1024 / 1024) },
    }
  }
  return null
}

/**
 * The mime a data URL actually carries.
 *
 * Needed because the mime we GUESS from the filename and the mime we PRODUCE can differ:
 * downscaling re-encodes, so a .webp comes out as PNG. Persisting the guess would put a lie
 * in the message record (`FilePart.mime: image/webp` on PNG bytes).
 */
export function mimeOfDataUrl(url: string): string | null {
  const m = /^data:([^;,]+)[;,]/.exec(url)
  return m ? m[1] : null
}

/** What the server's Read tool will inline for a text file, whatever its real size. */
const TEXT_INLINE_CEILING = 50 * 1024

/**
 * Bytes this attachment will actually cost the model.
 *
 * `file://` does NOT mean free. The server reads the file and rewrites the part into a
 * base64 `data:` URL before it ever reaches the provider (verified against a live sidecar) —
 * so for a PDF, every byte on disk is a byte the model pays for. Charging `file://` zero was
 * the same mistake as classifying by extension: a wire-format detail mistaken for a cost
 * model, letting a 49 MB scanned PDF through a budget that read "0 / 15 MB used".
 *
 * Text is the one genuinely cheap case, and only because the Read tool truncates it.
 */
export function inlineBytesOf(a: Pick<Attachment, "kind" | "wireUrl" | "size">): number {
  if (a.kind === "document") return 0 // path only — the agent opens it itself
  if (a.wireUrl.startsWith("data:")) {
    // A base64 payload is ~4/3 of the bytes it encodes; close enough for a budget.
    return Math.floor((a.wireUrl.length * 3) / 4)
  }
  if (a.kind === "pdf") return a.size // file:// — the server inlines the whole thing
  return Math.min(a.size, TEXT_INLINE_CEILING) // text — capped by the Read tool
}

/** Thrown when an attachment must be refused; the message is an i18n key. */
export class AttachmentRejected extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(key)
  }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"))
    fr.readAsDataURL(blob)
  })
}

/**
 * Pixel dimensions read from the file HEADER — without decoding.
 *
 * This is the only order that is safe: asking the decoder first is what a decompression bomb
 * is designed to exploit (a 30000×30000 flat PNG is ~200 KB on disk and 3.6 GB decoded).
 * Returns null for formats we don't parse; callers then fall back to a guarded decode.
 */
export async function imageHeaderSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  const head = new DataView(await blob.slice(0, 64).arrayBuffer())
  const u8 = new Uint8Array(head.buffer)
  const has = (i: number, sig: number[]) => sig.every((b, k) => u8[i + k] === b)

  // PNG: 8-byte signature, then IHDR whose width/height are big-endian u32 at 16 and 20.
  if (head.byteLength >= 24 && has(0, [0x89, 0x50, 0x4e, 0x47])) {
    return { width: head.getUint32(16), height: head.getUint32(20) }
  }
  // GIF: little-endian u16 at 6 and 8.
  if (head.byteLength >= 10 && has(0, [0x47, 0x49, 0x46])) {
    return { width: head.getUint16(6, true), height: head.getUint16(8, true) }
  }
  // WebP (VP8X lossy/lossless share the RIFF container; VP8X carries canvas size at 24).
  if (head.byteLength >= 30 && has(0, [0x52, 0x49, 0x46, 0x46]) && has(8, [0x57, 0x45, 0x42, 0x50])) {
    if (has(12, [0x56, 0x50, 0x38, 0x58])) {
      const w = 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16))
      const h = 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16))
      return { width: w, height: h }
    }
    return null // plain VP8/VP8L — let the guarded decode handle it
  }
  // JPEG: walk the marker chain to the SOFn frame header.
  if (has(0, [0xff, 0xd8])) {
    const buf = new DataView(await blob.slice(0, 1024 * 1024).arrayBuffer())
    let i = 2
    while (i + 9 < buf.byteLength) {
      if (buf.getUint8(i) !== 0xff) break
      const marker = buf.getUint8(i + 1)
      const len = buf.getUint16(i + 2)
      // SOF0..SOF15, excluding the DHT/JPG/DAC markers that share the range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.getUint16(i + 5), width: buf.getUint16(i + 7) }
      }
      if (len <= 0) break
      i += 2 + len
    }
  }
  return null
}

/** Decode to something drawable, preferring createImageBitmap, falling back to <img>. */
async function decodeImage(
  blob: Blob,
): Promise<{ src: CanvasImageSource; width: number; height: number; release: () => void }> {
  // `createImageBitmap` is absent on older webkit2gtk (Linux), and calling a missing global
  // throws SYNCHRONOUSLY — a `.catch()` would not save us.
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob).catch(() => null)
    if (bitmap) {
      return { src: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    }
  }
  // Universally available fallback: an <img> off an object URL.
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error("image decode failed"))
      el.src = url
    })
    return {
      src: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

/**
 * Bytes → data URL, downscaling images so the longest edge is <= MAX_IMAGE_EDGE.
 *
 * Images that cannot be decoded are REFUSED, never passed through untouched: the old
 * fall-back-to-original path meant that exactly the inputs we most needed to shrink (a
 * decode bomb, an image on a webview with no createImageBitmap) were the ones sent at full
 * size, which made MAX_IMAGE_EDGE a lie precisely when it mattered.
 *
 * Throws AttachmentRejected (with an i18n key) rather than returning a bad value.
 */
export async function toDataUrl(blob: Blob, kind: AttachmentKind, filename = ""): Promise<string> {
  if (kind !== "image") return readAsDataUrl(blob)

  // Refuse bombs BEFORE the decoder sees them.
  const header = await imageHeaderSize(blob).catch(() => null)
  if (header && header.width * header.height > MAX_IMAGE_PIXELS) {
    throw new AttachmentRejected("attachment.imageTooManyPixels", {
      name: pathBasename(filename),
      mp: Math.round(MAX_IMAGE_PIXELS / 1_000_000),
    })
  }

  let decoded: Awaited<ReturnType<typeof decodeImage>>
  try {
    decoded = await decodeImage(blob)
  } catch {
    throw new AttachmentRejected("attachment.imageUndecodable", { name: pathBasename(filename) })
  }

  try {
    // A format we couldn't parse a header for could still be huge — check post-decode too.
    if (decoded.width * decoded.height > MAX_IMAGE_PIXELS) {
      throw new AttachmentRejected("attachment.imageTooManyPixels", {
        name: pathBasename(filename),
        mp: Math.round(MAX_IMAGE_PIXELS / 1_000_000),
      })
    }

    const longest = Math.max(decoded.width, decoded.height)
    const scale = longest > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longest : 1
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(decoded.width * scale))
    canvas.height = Math.max(1, Math.round(decoded.height * scale))
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new AttachmentRejected("attachment.imageUndecodable", { name: pathBasename(filename) })
    ctx.drawImage(decoded.src, 0, 0, canvas.width, canvas.height)

    // PNG keeps screenshot text crisp, but re-encoding a PHOTO as PNG is what made a 12 MB
    // JPEG come out at 4-7 MB — high-entropy pixels don't compress losslessly. Keep photos
    // as JPEG; keep everything else (screenshots, diagrams, anything with alpha) as PNG.
    const isPhoto = blob.type === "image/jpeg" || /\.jpe?g$/i.test(filename)
    return isPhoto ? canvas.toDataURL("image/jpeg", 0.9) : canvas.toDataURL("image/png")
  } finally {
    decoded.release()
  }
}

/**
 * Absolute OS path → a `file://` URL the server can parse.
 *
 * Naive `file://${encodeURI(path)}` is wrong on two counts:
 *   - Windows. `C:\a\b` would become `file://C:\a\b`, where the server's `new URL()` reads
 *     "C:" as the HOST and `fileURLToPath` then fails or resolves somewhere else entirely.
 *     A file URL needs three slashes and forward slashes: `file:///C:/a/b`.
 *   - `#` and `?`. encodeURI leaves both alone, and both terminate the path component — a
 *     file called `draft#2.md` would silently become `draft`.
 */
export function toFileUrl(absPath: string): string {
  // Only a Windows path may contain backslash SEPARATORS. On POSIX a backslash is a perfectly
  // legal character IN a filename, so normalising it unconditionally turned `/x/we\ird.txt`
  // into `/x/we/ird.txt` — a different (nonexistent) path, silently.
  const looksWindows = /^[A-Za-z]:[\\/]/.test(absPath) || absPath.startsWith("\\\\")
  const normalized = looksWindows ? absPath.replace(/\\/g, "/") : absPath

  // encodeURI leaves `#` and `?` alone and both terminate the path component — a file named
  // `draft#2.md` would silently become `draft`. (`%` IS escaped by encodeURI, to %25.)
  const enc = (s: string) => encodeURI(s).replace(/#/g, "%23").replace(/\?/g, "%3F")

  if (normalized.startsWith("//")) {
    // UNC: `\\server\share\x` → `file://server/share/x`. The server name belongs in the HOST
    // slot; emitting `file:////server/...` (empty host) makes Node's fileURLToPath throw
    // ERR_INVALID_FILE_URL_PATH, so a file on a network share would fail to attach.
    return `file://${enc(normalized.slice(2))}`
  }
  const rooted = normalized.startsWith("/") ? normalized : `/${normalized}`
  return `file://${enc(rooted)}`
}

let seq = 0
export function nextAttachmentId(): string {
  return `att-${Date.now().toString(36)}-${seq++}`
}
