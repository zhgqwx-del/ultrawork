/**
 * Pure TypeScript document parsers for PDF, DOCX, XLSX, and PPTX.
 * No Python dependency — uses unpdf, mammoth, xlsx, and jszip.
 */

import { extname } from "path"

const CONVERT_TIMEOUT = 30_000

type ParseResult = { content: string; success: boolean }

/** Supported binary document extensions */
export const BINARY_DOC_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"])

/**
 * Convert a binary document to plain text / Markdown.
 * Dispatches to the appropriate parser based on file extension.
 */
export async function convertDocument(filePath: string): Promise<ParseResult> {
  const ext = extname(filePath).toLowerCase()

  try {
    let timer: ReturnType<typeof setTimeout>
    const result = await Promise.race([
      parseByExtension(ext, filePath),
      new Promise<ParseResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Conversion timeout")), CONVERT_TIMEOUT)
      }),
    ])
    clearTimeout(timer!)

    if (!result.content.trim()) {
      console.warn(`[doc-parser] Empty output for ${filePath}`)
      return { content: "", success: false }
    }

    return result
  } catch (err) {
    console.error(`[doc-parser] Error converting ${filePath}:`, err)
    return { content: "", success: false }
  }
}

async function parseByExtension(ext: string, filePath: string): Promise<ParseResult> {
  switch (ext) {
    case ".pdf":
      return parsePdf(filePath)
    case ".docx":
      return parseDocx(filePath)
    case ".xlsx":
      return parseXlsx(filePath)
    case ".pptx":
      return parsePptx(filePath)
    default:
      return { content: "", success: false }
  }
}

async function parsePdf(filePath: string): Promise<ParseResult> {
  const { extractText } = await import("unpdf")
  const buffer = await Bun.file(filePath).arrayBuffer()
  const { text } = await extractText(buffer)
  // text is string[] (one per page)
  const content = Array.isArray(text) ? text.join("\n\n") : String(text)
  return { content, success: true }
}

async function parseDocx(filePath: string): Promise<ParseResult> {
  const mammoth = await import("mammoth")
  const buffer = Buffer.from(await Bun.file(filePath).arrayBuffer())
  const result = await mammoth.extractRawText({ buffer })
  return { content: result.value, success: true }
}

async function parseXlsx(filePath: string): Promise<ParseResult> {
  const XLSX = await import("xlsx")
  const buffer = await Bun.file(filePath).arrayBuffer()
  const workbook = XLSX.read(buffer, { type: "array" })

  const parts: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue

    parts.push(`## ${sheetName}\n`)
    const csv = XLSX.utils.sheet_to_csv(sheet)
    if (csv.trim()) {
      parts.push(csv)
    }
  }

  return { content: parts.join("\n"), success: true }
}

async function parsePptx(filePath: string): Promise<ParseResult> {
  const JSZip = (await import("jszip")).default
  const buffer = await Bun.file(filePath).arrayBuffer()
  const zip = await JSZip.loadAsync(buffer)

  // Collect slide files sorted by number
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] ?? "0")
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] ?? "0")
      return numA - numB
    })

  const parts: string[] = []
  for (const slidePath of slideFiles) {
    const xml = await zip.files[slidePath].async("text")
    const texts = extractTextFromXml(xml)
    if (texts.length > 0) {
      const slideNum = slidePath.match(/slide(\d+)/)?.[1] ?? "?"
      parts.push(`## Slide ${slideNum}\n`)
      parts.push(texts.join("\n"))
      parts.push("")
    }
  }

  return { content: parts.join("\n"), success: true }
}

/** Extract text content from PowerPoint XML (<a:t> elements) */
function extractTextFromXml(xml: string): string[] {
  const texts: string[] = []
  // Match all <a:t>...</a:t> elements, handling potential attributes
  const regex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g
  let match: RegExpExecArray | null

  let currentParagraph: string[] = []
  // Split by paragraph markers to preserve structure
  const paragraphs = xml.split(/<\/a:p>/g)

  for (const para of paragraphs) {
    currentParagraph = []
    regex.lastIndex = 0
    while ((match = regex.exec(para)) !== null) {
      const text = match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
      if (text.trim()) {
        currentParagraph.push(text)
      }
    }
    if (currentParagraph.length > 0) {
      texts.push(currentParagraph.join(""))
    }
  }

  return texts
}
