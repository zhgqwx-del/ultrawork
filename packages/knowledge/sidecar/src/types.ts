export interface SourceRow {
  id: number
  folder_path: string
  file_path: string
  file_hash: string
  indexed_at: string
  chunk_count: number
}

export interface ChunkRow {
  id: number
  source_id: number
  content: string
  chunk_index: number
  metadata_json: string
}

export interface ChunkMetadata {
  file_path: string
  start_line: number
  end_line: number
}

export interface Chunk {
  content: string
  startLine: number
  endLine: number
  chunkIndex: number
}

export interface SearchResult {
  chunkId: number
  content: string
  score: number
  /** Relative path within the indexed folder */
  filePath: string
  /** Absolute path of the indexed folder */
  folderPath: string
  startLine: number
  endLine: number
}

export interface IndexStatus {
  folderPath: string
  totalFiles: number
  indexedFiles: number
  skippedFiles: number
  status: "idle" | "indexing" | "complete" | "error"
  error?: string
}

export interface Embedder {
  embed(text: string): Float32Array
  embedBatch(texts: string[]): Float32Array[]
  readonly dimension: number
}
