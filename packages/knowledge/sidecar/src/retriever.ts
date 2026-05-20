import type { KnowledgeStore } from "./store"
import type { Embedder, SearchResult, ChunkMetadata } from "./types"
import { cosineSimilarity } from "./embedder"

export interface SearchOptions {
  query: string
  limit?: number
  retrieval?: "hybrid" | "semantic" | "keyword"
}

const RRF_K = 60 // Standard RRF constant

/** Internal result type that tracks parent_id for enrichment */
interface InternalResult extends SearchResult {
  _parentId: number | null
}

/**
 * Create a retriever that performs hybrid search (BM25 + vector + RRF fusion).
 * Matches on child chunks, returns parent chunk content for richer LLM context.
 */
export function createRetriever(store: KnowledgeStore, embedder: Embedder) {
  return function search(options: SearchOptions): SearchResult[] {
    const { query, limit = 5, retrieval = "hybrid" } = options

    let rawResults: InternalResult[]
    if (retrieval === "keyword") {
      rawResults = ftsSearch(query, limit * 2)
    } else if (retrieval === "semantic") {
      rawResults = vectorSearch(query, limit * 2)
    } else {
      rawResults = hybridSearch(query, limit * 2)
    }

    // Enrich with parent content and deduplicate by parent
    return enrichWithParents(rawResults, limit)
  }

  function ftsSearch(query: string, limit: number): InternalResult[] {
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
              _parentId: row.parent_id,
            } as InternalResult
          } catch {
            return null
          }
        })
        .filter((r): r is InternalResult => r !== null)
    } catch {
      return []
    }
  }

  function vectorSearch(query: string, limit: number): InternalResult[] {
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
            _parentId: chunk.parent_id,
          } as InternalResult
        } catch {
          return null
        }
      })
      .filter((r): r is InternalResult => r !== null)
  }

  function hybridSearch(query: string, limit: number): InternalResult[] {
    // Fetch more candidates than needed for fusion
    const candidateCount = limit * 2

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
    const allResults = new Map<number, InternalResult>()
    for (const r of [...ftsResults, ...vecResults]) {
      if (!allResults.has(r.chunkId)) {
        allResults.set(r.chunkId, r as InternalResult)
      }
    }

    // Sort by fused score
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])

    return ranked
      .map(([chunkId, score]) => {
        const result = allResults.get(chunkId)
        if (!result) return null
        return { ...result, score }
      })
      .filter((r): r is InternalResult => r !== null)
  }

  /**
   * Enrich results with parent content and deduplicate.
   * When multiple children from the same parent match, keep only the highest-scoring one
   * but return the parent's full content for context.
   */
  function enrichWithParents(
    results: InternalResult[],
    limit: number,
  ): SearchResult[] {
    if (results.length === 0) return []

    // Collect unique parent IDs
    const parentIds = results
      .map((r) => r._parentId)
      .filter((id): id is number => id != null)

    const parentMap = store.getParentChunks(parentIds)

    // Deduplicate by parent: keep highest-scoring child per parent
    const seenParents = new Set<number>()
    const enriched: SearchResult[] = []

    for (const result of results) {
      if (enriched.length >= limit) break

      const { _parentId, ...searchResult } = result

      // Deduplicate by parent
      if (_parentId != null) {
        if (seenParents.has(_parentId)) continue
        seenParents.add(_parentId)

        // Enrich with parent content
        const parent = parentMap.get(_parentId)
        if (parent) {
          try {
            const parentMeta = JSON.parse(parent.metadata_json) as ChunkMetadata
            searchResult.parentContent = parent.content
            searchResult.parentStartLine = parentMeta.start_line
            searchResult.parentEndLine = parentMeta.end_line
          } catch {
            // Keep result without parent enrichment
          }
        }
      }

      enriched.push(searchResult)
    }

    return enriched
  }
}
