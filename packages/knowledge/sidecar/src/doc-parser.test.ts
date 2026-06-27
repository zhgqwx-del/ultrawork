import { describe, it, expect } from "bun:test"
import { convertDocument, BINARY_DOC_EXTENSIONS } from "./doc-parser"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, "__fixtures__")

// Tests that lazily import the heavy doc libs (unpdf/mammoth/xlsx/jszip) hang or
// throw under the vitest+vite-node toolchain on Windows (pdfjs/wasm internals).
// The sidecar runs as a bun binary at runtime, so this is a test-infra-only gap.
// Skip them on Windows; pure-logic tests still cover all platforms.
const itDoc = it.skipIf(process.platform === "win32")

describe("doc-parser", () => {
  describe("BINARY_DOC_EXTENSIONS", () => {
    it("includes all four formats", () => {
      expect(BINARY_DOC_EXTENSIONS.has(".pdf")).toBe(true)
      expect(BINARY_DOC_EXTENSIONS.has(".docx")).toBe(true)
      expect(BINARY_DOC_EXTENSIONS.has(".xlsx")).toBe(true)
      expect(BINARY_DOC_EXTENSIONS.has(".pptx")).toBe(true)
    })
  })

  describe("convertDocument", () => {
    it("returns failure for unsupported extension", async () => {
      const result = await convertDocument("/tmp/test.xyz")
      expect(result.success).toBe(false)
    })

    itDoc("returns failure for non-existent file", async () => {
      const result = await convertDocument("/tmp/nonexistent.pdf")
      expect(result.success).toBe(false)
    })

    itDoc("parses DOCX files", async () => {
      const result = await convertDocument(join(FIXTURES_DIR, "sample.docx"))
      expect(result.success).toBe(true)
      expect(result.content).toContain("Hello")
    })

    itDoc("parses XLSX files", async () => {
      const result = await convertDocument(join(FIXTURES_DIR, "sample.xlsx"))
      expect(result.success).toBe(true)
      expect(result.content).toContain("Sheet")
    })

    itDoc("parses PPTX files", async () => {
      const result = await convertDocument(join(FIXTURES_DIR, "sample.pptx"))
      expect(result.success).toBe(true)
      expect(result.content).toContain("Slide")
    })
  })
})
