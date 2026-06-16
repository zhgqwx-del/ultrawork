import { describe, it, expect } from "vitest"
import { isBinaryFile } from "@/components/ui/file-icon"

// Routing invariant for the preview: PDFs must NOT be classified as binary, so
// they reach the in-app PdfView branch instead of the BinaryFileCard / empty
// "no content" state (the original blank-PDF bug). Office docs stay binary →
// system-app card by design.
describe("isBinaryFile — preview routing", () => {
  it("does not treat PDF as binary (routes to in-app pdf.js view)", () => {
    expect(isBinaryFile("report.pdf")).toBe(false)
    expect(isBinaryFile("REPORT.PDF")).toBe(false)
  })

  it("keeps Office docs binary (system-app card)", () => {
    expect(isBinaryFile("notes.docx")).toBe(true)
    expect(isBinaryFile("sheet.xlsx")).toBe(true)
    expect(isBinaryFile("deck.pptx")).toBe(true)
  })

  it("text/code stays previewable", () => {
    expect(isBinaryFile("main.py")).toBe(false)
    expect(isBinaryFile("README.md")).toBe(false)
  })
})
