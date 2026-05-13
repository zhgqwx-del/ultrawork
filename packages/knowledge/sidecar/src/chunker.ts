import type { Chunk } from "./types"

export interface ChunkerOptions {
  /** Maximum lines per chunk (default: 40) */
  maxLines?: number
  /** Overlap lines between chunks (default: 10) */
  overlapLines?: number
}

const DEFAULT_MAX_LINES = 40
const DEFAULT_OVERLAP_LINES = 10

/**
 * Split text into overlapping chunks by line count.
 * Tries to break at natural boundaries (blank lines, headings) when possible.
 */
export function chunkText(text: string, options?: ChunkerOptions): Chunk[] {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES
  const overlapLines = options?.overlapLines ?? DEFAULT_OVERLAP_LINES

  const lines = text.split("\n")
  if (lines.length === 0) return []

  // If the whole file fits in one chunk, return it as-is
  if (lines.length <= maxLines) {
    return [
      {
        content: text,
        startLine: 1,
        endLine: lines.length,
        chunkIndex: 0,
      },
    ]
  }

  const chunks: Chunk[] = []
  let start = 0
  let chunkIndex = 0

  while (start < lines.length) {
    let end = Math.min(start + maxLines, lines.length)

    // Try to break at a natural boundary within the last 25% of the chunk
    if (end < lines.length) {
      const searchStart = start + Math.floor(maxLines * 0.75)
      let bestBreak = -1

      for (let i = end - 1; i >= searchStart; i--) {
        const line = lines[i]
        // Break after blank lines or before markdown headings
        if (line.trim() === "" || lines[i + 1]?.startsWith("## ") || lines[i + 1]?.startsWith("### ")) {
          bestBreak = i + 1
          break
        }
      }

      if (bestBreak > 0) {
        end = bestBreak
      }
    }

    const chunkLines = lines.slice(start, end)
    chunks.push({
      content: chunkLines.join("\n"),
      startLine: start + 1, // 1-based
      endLine: end,
      chunkIndex,
    })

    chunkIndex++
    // Advance with overlap
    const advance = end - start - overlapLines
    start += Math.max(advance, 1) // Ensure forward progress
  }

  return chunks
}
