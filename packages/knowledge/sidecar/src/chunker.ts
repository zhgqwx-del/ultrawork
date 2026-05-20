import type { Chunk, ChildChunk, ChunkResult } from "./types"

export interface ChunkerOptions {
  /** Maximum lines per parent chunk (default: 60) */
  parentMaxLines?: number
  /** Maximum lines per child chunk (default: 12) */
  childMaxLines?: number
  /** Overlap lines between child chunks (default: 2) */
  childOverlapLines?: number
}

const DEFAULT_PARENT_MAX_LINES = 60
const DEFAULT_CHILD_MAX_LINES = 12
const DEFAULT_CHILD_OVERLAP_LINES = 2

/**
 * Split text into parent-child dual-layer chunks.
 *
 * Parent chunks (~60 lines) provide rich context for LLM reasoning.
 * Child chunks (~12 lines) are small, precise units for embedding and retrieval.
 * When a child chunk matches a query, its parent chunk is returned to the LLM.
 *
 * Small files (<= childMaxLines) produce a single chunk that is both parent and child.
 */
export function chunkText(text: string, options?: ChunkerOptions): ChunkResult {
  const parentMaxLines = options?.parentMaxLines ?? DEFAULT_PARENT_MAX_LINES
  const childMaxLines = options?.childMaxLines ?? DEFAULT_CHILD_MAX_LINES
  const childOverlapLines = options?.childOverlapLines ?? DEFAULT_CHILD_OVERLAP_LINES

  const lines = text.split("\n")
  if (lines.length === 0) return { parents: [], children: [] }

  // Small files: single chunk acts as both parent and child
  if (lines.length <= childMaxLines) {
    const chunk: Chunk = {
      content: text,
      startLine: 1,
      endLine: lines.length,
      chunkIndex: 0,
    }
    return {
      parents: [chunk],
      children: [{ ...chunk, parentIndex: 0 }],
    }
  }

  // Step 1: Create parent chunks by splitting at natural boundaries
  const parents = createParentChunks(lines, parentMaxLines)

  // Step 2: For each parent, create child chunks
  const children: ChildChunk[] = []
  let childIndex = 0

  for (let pi = 0; pi < parents.length; pi++) {
    const parent = parents[pi]
    const parentLines = parent.content.split("\n")

    if (parentLines.length <= childMaxLines) {
      // Parent is small enough to be its own child
      children.push({
        content: parent.content,
        startLine: parent.startLine,
        endLine: parent.endLine,
        chunkIndex: childIndex++,
        parentIndex: pi,
      })
      continue
    }

    // Split parent into overlapping child chunks
    let start = 0
    while (start < parentLines.length) {
      let end = Math.min(start + childMaxLines, parentLines.length)

      // Try to break at a natural boundary (blank line or heading)
      if (end < parentLines.length) {
        const searchStart = start + Math.floor(childMaxLines * 0.6)
        for (let i = end - 1; i >= searchStart; i--) {
          const line = parentLines[i]
          if (
            line.trim() === "" ||
            parentLines[i + 1]?.startsWith("## ") ||
            parentLines[i + 1]?.startsWith("### ") ||
            parentLines[i + 1]?.startsWith("#### ")
          ) {
            end = i + 1
            break
          }
        }
      }

      const childLines = parentLines.slice(start, end)
      children.push({
        content: childLines.join("\n"),
        startLine: parent.startLine + start,
        endLine: parent.startLine + end - 1,
        chunkIndex: childIndex++,
        parentIndex: pi,
      })

      const advance = end - start - childOverlapLines
      start += Math.max(advance, 1)
    }
  }

  return { parents, children }
}

/**
 * Create parent chunks by splitting lines at natural boundaries.
 * Prefers to break at markdown headings, blank lines, or section separators.
 */
function createParentChunks(lines: string[], maxLines: number): Chunk[] {
  if (lines.length <= maxLines) {
    return [
      {
        content: lines.join("\n"),
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

    // Try to break at a major boundary within the last 30% of the chunk
    if (end < lines.length) {
      const searchStart = start + Math.floor(maxLines * 0.7)
      let bestBreak = -1

      for (let i = end - 1; i >= searchStart; i--) {
        const line = lines[i]
        const nextLine = lines[i + 1]

        // Priority 1: Before a top-level heading
        if (nextLine?.startsWith("# ") || nextLine?.startsWith("## ")) {
          bestBreak = i + 1
          break
        }
        // Priority 2: Before a sub-heading
        if (nextLine?.startsWith("### ") || nextLine?.startsWith("#### ")) {
          if (bestBreak < 0) bestBreak = i + 1
        }
        // Priority 3: After a blank line
        if (line.trim() === "" && bestBreak < 0) {
          bestBreak = i + 1
        }
      }

      if (bestBreak > start) {
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
    start = end
  }

  return chunks
}
