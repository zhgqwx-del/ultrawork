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
  parent_id: number | null
  chunk_type: "parent" | "child"
}

export interface ChunkMetadata {
  file_path: string
  start_line: number
  end_line: number
}

/** A parent chunk produced by the chunker */
export interface Chunk {
  content: string
  startLine: number
  endLine: number
  chunkIndex: number
}

/** A child chunk that references its parent by index */
export interface ChildChunk extends Chunk {
  parentIndex: number
}

/** Result of dual-layer chunking */
export interface ChunkResult {
  parents: Chunk[]
  children: ChildChunk[]
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
  /** Parent chunk content (richer context for LLM) */
  parentContent?: string
  /** Parent chunk line range */
  parentStartLine?: number
  parentEndLine?: number
}

export interface IndexStatus {
  folderPath: string
  totalFiles: number
  indexedFiles: number
  skippedFiles: number
  status: "idle" | "indexing" | "complete" | "error"
  error?: string
  /** Currently processing file (relative path) */
  currentFile?: string
}

/** Progress event emitted during indexing */
export interface IndexProgressEvent {
  folderPath: string
  status: IndexStatus["status"]
  totalFiles: number
  indexedFiles: number
  skippedFiles: number
  currentFile?: string
  error?: string
}

export interface Embedder {
  embed(text: string): Float32Array
  embedBatch(texts: string[]): Float32Array[]
  readonly dimension: number
}
