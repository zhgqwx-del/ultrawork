import type { Embedder } from "./types"

/**
 * Pure TypeScript TF-IDF embedder using the hashing trick.
 * Maps tokens to a fixed-dimension vector via hash(token) % dimension.
 * No external dependencies — safe for `bun build --compile`.
 *
 * Quality is sufficient for Phase 1 when combined with FTS5 BM25.
 * Phase 2 will upgrade to neural embeddings (ONNX).
 */
export function createTfIdfEmbedder(options?: { dimension?: number }): Embedder {
  const dimension = options?.dimension ?? 384

  function tokenize(text: string): string[] {
    // Lowercase, split on non-alphanumeric, filter short tokens
    return text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+/)
      .filter((t) => t.length > 1)
  }

  function hashToken(token: string): number {
    // Simple FNV-1a hash for consistent mapping
    let hash = 2166136261
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i)
      hash = (hash * 16777619) >>> 0
    }
    return hash
  }

  function embed(text: string): Float32Array {
    const tokens = tokenize(text)
    const vec = new Float32Array(dimension)

    if (tokens.length === 0) return vec

    // Count term frequency
    const tf = new Map<string, number>()
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1)
    }

    // Hash tokens into vector dimensions with TF weight
    for (const [token, count] of tf) {
      const idx = hashToken(token) % dimension
      // Use sign hash to reduce collision impact
      const sign = hashToken(token + "_sign") % 2 === 0 ? 1 : -1
      // TF weight: log(1 + count) to dampen frequency
      vec[idx] += sign * Math.log(1 + count)

      // Also hash bigrams for better quality
      // (implicit via subword: hash first 3 chars and last 3 chars separately)
      if (token.length > 3) {
        const prefix = token.slice(0, 3)
        const suffix = token.slice(-3)
        const prefixIdx = hashToken("pre_" + prefix) % dimension
        const suffixIdx = hashToken("suf_" + suffix) % dimension
        vec[prefixIdx] += sign * Math.log(1 + count) * 0.3
        vec[suffixIdx] += sign * Math.log(1 + count) * 0.3
      }
    }

    // L2 normalize
    let norm = 0
    for (let i = 0; i < dimension; i++) {
      norm += vec[i] * vec[i]
    }
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (let i = 0; i < dimension; i++) {
        vec[i] /= norm
      }
    }

    return vec
  }

  function embedBatch(texts: string[]): Float32Array[] {
    return texts.map(embed)
  }

  return { embed, embedBatch, dimension }
}

/** Compute cosine similarity between two normalized vectors */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
  }
  return dot
}
