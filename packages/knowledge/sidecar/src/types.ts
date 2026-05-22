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

// ---------------------------------------------------------------------------
// Phase 3: Unified knowledge source registry
// ---------------------------------------------------------------------------

export type KnowledgeSourceType = "local_folder" | "ima" | "custom_api"

export interface KnowledgeSourceRow {
  id: number
  type: KnowledgeSourceType
  name: string
  config_json: string
  enabled: number
  status: string
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface LocalFolderConfig {
  folderPath: string
}

export interface IMAConfig {
  clientId: string
  apiKey: string
  baseUrl?: string // default: https://ima.qq.com
  /** "wiki" = knowledge base files (Phase 3), "notes" = IMA notes with full-text (Phase 4a) */
  module?: "wiki" | "notes"
  knowledgeBaseId?: string
  knowledgeBaseName?: string
  /** Notes module: selected notebook ID */
  notebookId?: string
  /** Notes module: selected notebook name */
  notebookName?: string
}

export interface CustomAPIConfig {
  endpoint: string
  method: "GET" | "POST"
  headers: Record<string, string>
  bodyTemplate?: Record<string, unknown>
  responseMapping?: {
    results: string
    title: string
    content: string
    url?: string
  }
}

/** Unified search result from any adapter */
export interface AdapterSearchResult {
  content: string
  score: number
  title?: string
  url?: string
  sourceId: number
  sourceLabel: string
  metadata?: Record<string, unknown>
}
