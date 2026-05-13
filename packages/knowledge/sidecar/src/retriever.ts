import type { KnowledgeStore } from "./store"
import type { Embedder, SearchResult, ChunkMetadata } from "./types"
import { cosineSimilarity } from "./embedder"

export interface SearchOptions {
  query: string
  limit?: number
  retrieval?: "hybrid" | "semantic" | "keyword"
}

const RRF_K = 60 // Standard RRF constant

/**
 * Create a retriever that performs hybrid search (BM25 + vector + RRF fusion).
 */
export function createRetriever(store: KnowledgeStore, embedder: Embedder) {
  return function search(options: SearchOptions): SearchResult[] {
    const { query, limit = 5, retrieval = "hybrid" } = options

    if (retrieval === "keyword") {
      return ftsSearch(query, limit)
    }
    if (retrieval === "semantic") {
      return vectorSearch(query, limit)
    }
    // hybrid: BM25 + vector + RRF
    return hybridSearch(query, limit)
  }

  function ftsSearch(query: string, limit: number): SearchResult[] {
    try {
      const rows = store.searchFTS(query, limit)
      return rows
        .map((row) => {
          try {
            const meta = JSON.parse(row.metadata_json) as ChunkMetadata
            return {
              chunkId: row.id,
              content: row.content,
              score: -row.rank, // FTS5 rank is negative (lower = better)
              filePath: meta.file_path,
              folderPath: row.folder_path,
              startLine: meta.start_line,
              endLine: meta.end_line,
            }
          } catch {
            return null // Skip chunks with corrupted metadata
          }
        })
        .filter((r): r is SearchResult => r !== null)
    } catch {
      // FTS5 query syntax error — return empty
      return []
    }
  }

  function vectorSearch(query: string, limit: number): SearchResult[] {
    const queryEmbedding = embedder.embed(query)
    const allEmbeddings = store.getAllEmbeddings()

    if (allEmbeddings.length === 0) return []

    // Compute cosine similarity for all chunks
    const scored = allEmbeddings.map((row) => ({
      chunkId: row.chunkId,
      score: cosineSimilarity(queryEmbedding, row.embedding),
    }))

    // Sort by score descending, take top-K
    scored.sort((a, b) => b.score - a.score)
    const topK = scored.slice(0, limit)

    // Fetch chunk details
    const chunkIds = topK.map((s) => s.chunkId)
    const chunks = store.getChunksByIds(chunkIds)
    const chunkMap = new Map(chunks.map((c) => [c.id, c]))

    return topK
      .map((s) => {
        const chunk = chunkMap.get(s.chunkId)
        if (!chunk) return null
        try {
          const meta = JSON.parse(chunk.metadata_json) as ChunkMetadata
          return {
            chunkId: s.chunkId,
            content: chunk.content,
            score: s.score,
            filePath: meta.file_path,
            folderPath: chunk.folder_path,
            startLine: meta.start_line,
            endLine: meta.end_line,
          }
        } catch {
          return null
        }
      })
      .filter((r): r is SearchResult => r !== null)
  }

  function hybridSearch(query: string, limit: number): SearchResult[] {
    // Fetch more candidates than needed for fusion
    const candidateCount = limit * 3

    const ftsResults = ftsSearch(query, candidateCount)
    const vecResults = vectorSearch(query, candidateCount)

    // RRF fusion
    const scores = new Map<number, number>()

    for (let i = 0; i < ftsResults.length; i++) {
      const id = ftsResults[i].chunkId
      scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + i + 1))
    }

    for (let i = 0; i < vecResults.length; i++) {
      const id = vecResults[i].chunkId
      scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + i + 1))
    }

    // Merge result details
    const allResults = new Map<number, SearchResult>()
    for (const r of [...ftsResults, ...vecResults]) {
      if (!allResults.has(r.chunkId)) {
        allResults.set(r.chunkId, r)
      }
    }

    // Sort by fused score, take top-K
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)

    return ranked
      .map(([chunkId, score]) => {
        const result = allResults.get(chunkId)
        if (!result) return null
        return { ...result, score }
      })
      .filter((r): r is SearchResult => r !== null)
  }
}
