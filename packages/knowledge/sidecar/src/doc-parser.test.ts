import { describe, it, expect } from "vitest"
import { convertDocument, BINARY_DOC_EXTENSIONS } from "./doc-parser"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, "__fixtures__")

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

    it("returns failure for non-existent file", async () => {
      const result = await convertDocument("/tmp/nonexistent.pdf")
      expect(result.success).toBe(false)
    })

    it("parses DOCX files", async () => {
      const result = await convertDocument(join(FIXTURES_DIR, "sample.docx"))
      expect(result.success).toBe(true)
      expect(result.content).toContain("Hello")
    })

    it("parses XLSX files", async () => {
      const result = await convertDocument(join(FIXTURES_DIR, "sample.xlsx"))
      expect(result.success).toBe(true)
      expect(result.content).toContain("Sheet")
    })

    it("parses PPTX files", async () => {
      const result = await convertDocument(join(FIXTURES_DIR, "sample.pptx"))
      expect(result.success).toBe(true)
      expect(result.content).toContain("Slide")
    })
  })
})
