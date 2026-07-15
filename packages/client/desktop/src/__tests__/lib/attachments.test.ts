import { describe, it, expect } from "vitest"
import {
  classify, wireMime, rejectionOf, extensionOf, toFileUrl, inlineBytesOf,
  MAX_ATTACHMENTS, MAX_BYTES,
} from "@/lib/attachments"

/**
 * The mime we put on the wire decides which server path the file takes. Getting it wrong
 * doesn't throw — it silently hands raw base64 to the provider, or makes the Read tool
 * choke on a binary. These tests pin the routing table (discussions/039 §3).
 */
describe("attachments — classify", () => {
  it("routes images by extension", () => {
    expect(classify("shot.png")).toBe("image")
    expect(classify("photo.JPG")).toBe("image")
    expect(classify("anim.webp")).toBe("image")
  })

  it("routes PDFs to their own kind (multimodal, but a different capability gate)", () => {
    expect(classify("spec.pdf")).toBe("pdf")
  })

  it("routes text-ish files to text, including source code", () => {
    expect(classify("notes.md")).toBe("text")
    expect(classify("data.csv")).toBe("text")
    expect(classify("main.rs")).toBe("text")
    expect(classify("index.tsx")).toBe("text")
  })

  it("treats SVG as text, not an image", () => {
    // The server explicitly excludes SVG from images (vendor read.ts). Sent as
    // image/svg+xml the model would receive a file part it cannot decode.
    expect(classify("logo.svg")).toBe("text")
  })

  it("routes Office/binary files to document (never inlined)", () => {
    expect(classify("report.docx")).toBe("document")
    expect(classify("sheet.xlsx")).toBe("document")
    expect(classify("deck.pptx")).toBe("document")
    expect(classify("bundle.zip")).toBe("document")
  })

  it("prefers the extension over an unhelpful OS mime", () => {
    // Browsers hand us "" or application/octet-stream often enough that trusting mime
    // alone misroutes ordinary files.
    expect(classify("shot.png", "application/octet-stream")).toBe("image")
    expect(classify("notes.md", "")).toBe("text")
  })

  it("falls back to mime when there is no extension", () => {
    expect(classify("clipboard", "image/png")).toBe("image")
    expect(classify("blob", "application/pdf")).toBe("pdf")
  })
})

describe("attachments — wireMime", () => {
  it("sends text-ish files as text/plain so the server inlines them via its Read tool", () => {
    expect(wireMime("text", "text/markdown", "notes.md")).toBe("text/plain")
    expect(wireMime("text", "image/svg+xml", "logo.svg")).toBe("text/plain")
  })

  it("keeps the real mime for images and normalises jpg", () => {
    expect(wireMime("image", "image/png", "a.png")).toBe("image/png")
    expect(wireMime("image", "", "a.jpg")).toBe("image/jpeg")
  })

  it("always sends application/pdf for PDFs", () => {
    expect(wireMime("pdf", "", "a.pdf")).toBe("application/pdf")
  })
})

describe("attachments — limits", () => {
  it("rejects once the attachment count is at the cap", () => {
    expect(rejectionOf({ name: "a.png", size: 10 }, "image", MAX_ATTACHMENTS)?.key).toBe("attachment.tooMany")
    expect(rejectionOf({ name: "a.png", size: 10 }, "image", MAX_ATTACHMENTS - 1)).toBeNull()
  })

  it("caps by KIND, because bytes mean different things per kind", () => {
    // A 12 MB phone photo is fine: we downscale to MAX_IMAGE_EDGE, so the source size does
    // not bound the cost. The old single 5 MB cap rejected it for nothing.
    expect(rejectionOf({ name: "photo.jpg", size: 12 * 1024 * 1024 }, "image", 0)).toBeNull()
    // A 20 MB log is fine too: the server's Read tool only ever inlines 50 KB of it.
    expect(rejectionOf({ name: "big.log", size: 20 * 1024 * 1024 }, "text", 0)).toBeNull()
    // Absurd sizes are still refused, per kind.
    expect(rejectionOf({ name: "huge.png", size: MAX_BYTES.image + 1 }, "image", 0)?.key).toBe("attachment.tooLarge")
    expect(rejectionOf({ name: "huge.log", size: MAX_BYTES.text + 1 }, "text", 0)?.key).toBe("attachment.tooLarge")
  })
})

describe("attachments — inline budget accounting", () => {
  it("counts data: bytes, and ignores what the server reads off disk itself", () => {
    // Only `data:` payloads travel in the request body. A file:// text/pdf attachment and a
    // path-only document cost the prompt nothing, so charging them to the budget would
    // wrongly refuse perfectly cheap attachments.
    const dataUrl = "data:image/png;base64," + "A".repeat(400)
    expect(inlineBytesOf({ kind: "image", wireUrl: dataUrl, size: 0 })).toBe(
      Math.floor((dataUrl.length * 3) / 4),
    )
    // A path-only document costs the prompt nothing — the agent opens it itself.
    expect(inlineBytesOf({ kind: "document", wireUrl: "", size: 99_000_000 })).toBe(0)
  })

  it("charges a file:// PDF its FULL size — file:// is not free", () => {
    // The regression this pins: the server rewrites a file:// PDF into a base64 data: part
    // before it reaches the provider, so every byte on disk is a byte the model pays for.
    // Charging it zero let a 49 MB scanned PDF through a budget reading "0 / 15 MB used" —
    // the same "wire-format detail mistaken for a cost model" bug as classifying by extension.
    expect(inlineBytesOf({ kind: "pdf", wireUrl: "file:///tmp/a.pdf", size: 7_000_000 })).toBe(7_000_000)
  })

  it("charges a file:// text file only what the server's Read tool will actually inline", () => {
    // Text is the one genuinely cheap case, and only because Read truncates at 50 KB.
    expect(inlineBytesOf({ kind: "text", wireUrl: "file:///tmp/big.log", size: 20_000_000 })).toBe(50 * 1024)
    expect(inlineBytesOf({ kind: "text", wireUrl: "file:///tmp/tiny.md", size: 300 })).toBe(300)
  })
})

describe("attachments — toFileUrl (cross-platform, ADR-037)", () => {
  it("builds a valid file URL from a Windows path", () => {
    // `file://C:\a\b` would make the server's `new URL()` read "C:" as the HOST and
    // fileURLToPath then fails — PDFs/text files would break on Windows only, where I
    // cannot reproduce locally. Three slashes, forward slashes.
    expect(toFileUrl("C:\\Users\\zhang\\notes.md")).toBe("file:///C:/Users/zhang/notes.md")
  })

  it("builds a valid file URL from a POSIX path", () => {
    expect(toFileUrl("/tmp/a/notes.md")).toBe("file:///tmp/a/notes.md")
  })

  it("escapes # and ?, which encodeURI leaves alone and which truncate the path", () => {
    // A file literally named `draft#2.md` would otherwise arrive at the server as `draft`.
    expect(toFileUrl("/tmp/draft#2.md")).toBe("file:///tmp/draft%232.md")
    expect(toFileUrl("/tmp/what?.md")).toBe("file:///tmp/what%3F.md")
  })

  it("escapes spaces and non-ASCII", () => {
    expect(toFileUrl("/tmp/my notes.md")).toBe("file:///tmp/my%20notes.md")
    expect(toFileUrl("/tmp/笔记.md")).toBe("file:///tmp/%E7%AC%94%E8%AE%B0.md")
  })
})

describe("attachments — extensionOf", () => {
  it("handles dotfiles and paths", () => {
    expect(extensionOf("/a/b/c.png")).toBe("png")
    expect(extensionOf(".gitignore")).toBe("") // leading dot is not an extension
    expect(extensionOf("noext")).toBe("")
  })
})
