import { readdir, stat } from "fs/promises"
import { join, relative, extname } from "path"
import { KnowledgeStore } from "./store"
import type { Embedder, IndexStatus, ChunkMetadata, IndexProgressEvent } from "./types"
import { chunkText } from "./chunker"

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".log",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".json", ".yaml", ".yml", ".toml",
  ".html", ".css", ".scss",
  ".csv", ".xml",
  ".sh", ".bash", ".zsh",
  ".sql", ".graphql",
  ".env", ".ini", ".cfg",
  ".swift", ".kt", ".rb", ".php", ".lua",
])

const BINARY_DOC_EXTENSIONS = new Set([
  ".pdf", ".docx", ".xlsx", ".pptx",
])

const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...BINARY_DOC_EXTENSIONS])

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", "vendor", ".idea", ".vscode",
  "target", "coverage", ".turbo", ".cache",
])

const MAX_TEXT_FILE_SIZE = 1024 * 1024 // 1MB
const MAX_BINARY_FILE_SIZE = 50 * 1024 * 1024 // 50MB
const MAX_FILES = 10000

export type ProgressCallback = (event: IndexProgressEvent) => void

export class Indexer {
  private store: KnowledgeStore
  private embedder: Embedder
  private statuses = new Map<string, IndexStatus>()
  private markitdownConvert: ((filePath: string) => Promise<{ content: string; success: boolean }>) | null = null
  private progressListeners: ProgressCallback[] = []
  /** Guard against concurrent indexFolder() for the same path */
  private indexingInProgress = new Set<string>()

  constructor(store: KnowledgeStore, embedder: Embedder) {
    this.store = store
    this.embedder = embedder

    // Initialize statuses from existing indexed folders
    for (const folder of store.listFolders()) {
      this.statuses.set(folder.folderPath, {
        folderPath: folder.folderPath,
        totalFiles: folder.fileCount,
        indexedFiles: folder.fileCount,
        skippedFiles: 0,
        status: "complete",
      })
    }
  }

  /** Add a progress listener */
  addProgressListener(cb: ProgressCallback): () => void {
    this.progressListeners.push(cb)
    return () => {
      this.progressListeners = this.progressListeners.filter((l) => l !== cb)
    }
  }

  /** Set the MarkItDown conversion function (injected to avoid circular deps) */
  setMarkItDown(convert: (filePath: string) => Promise<{ content: string; success: boolean }>): void {
    this.markitdownConvert = convert
  }

  async indexFolder(folderPath: string): Promise<IndexStatus> {
    // Prevent concurrent indexing of the same folder
    if (this.indexingInProgress.has(folderPath)) {
      console.log(`[indexer] Already indexing ${folderPath}, skipping`)
      return this.getStatus(folderPath)
    }
    this.indexingInProgress.add(folderPath)

    const status: IndexStatus = {
      folderPath,
      totalFiles: 0,
      indexedFiles: 0,
      skippedFiles: 0,
      status: "indexing",
    }
    this.statuses.set(folderPath, status)
    this.emitProgress(status)

    try {
      // Discover files
      const files = await this.discoverFiles(folderPath)
      status.totalFiles = files.length
      this.emitProgress(status)

      // Track existing files to detect deletions
      const existingSources = this.store.listSources(folderPath)
      const discoveredPaths = new Set(files)

      // Remove deleted files
      for (const existing of existingSources) {
        if (!discoveredPaths.has(existing.file_path)) {
          this.store.removeSource(existing.file_path)
        }
      }

      // Index new and changed files
      for (const filePath of files) {
        const relPath = relative(folderPath, filePath)
        status.currentFile = relPath
        this.emitProgress(status)

        try {
          await this.indexFile(folderPath, filePath)
          status.indexedFiles++
        } catch (err) {
          console.error(`Failed to index ${filePath}:`, err)
          status.skippedFiles++
        }
      }

      status.status = "complete"
      status.currentFile = undefined
    } catch (err) {
      status.status = "error"
      status.error = err instanceof Error ? err.message : String(err)
      console.error(`Failed to index folder ${folderPath}:`, err)
    }

    this.indexingInProgress.delete(folderPath)
    this.statuses.set(folderPath, status)
    this.emitProgress(status)
    return status
  }

  /** Re-index a single file (used by file watcher) */
  async reindexFile(folderPath: string, filePath: string): Promise<void> {
    try {
      await this.indexFile(folderPath, filePath)
      // Update status
      const current = this.statuses.get(folderPath)
      if (current) {
        this.emitProgress({ ...current, currentFile: relative(folderPath, filePath) })
      }
    } catch (err) {
      console.error(`Failed to reindex ${filePath}:`, err)
    }
  }

  /** Remove a single file from the index (used by file watcher on delete) */
  removeFile(filePath: string): void {
    this.store.removeSource(filePath)
  }

  private emitProgress(status: IndexStatus): void {
    const event: IndexProgressEvent = {
      folderPath: status.folderPath,
      status: status.status,
      totalFiles: status.totalFiles,
      indexedFiles: status.indexedFiles,
      skippedFiles: status.skippedFiles,
      currentFile: status.currentFile,
      error: status.error,
    }
    for (const listener of this.progressListeners) {
      try { listener(event) } catch { /* ignore */ }
    }
  }

  private async discoverFiles(folderPath: string): Promise<string[]> {
    const files: string[] = []

    const walk = async (dir: string) => {
      if (files.length >= MAX_FILES) return

      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return // Permission denied or unreadable
      }

      for (const entry of entries) {
        if (files.length >= MAX_FILES) break

        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
            await walk(join(dir, entry.name))
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase()
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            const fullPath = join(dir, entry.name)
            try {
              const info = await stat(fullPath)
              const maxSize = BINARY_DOC_EXTENSIONS.has(ext)
                ? MAX_BINARY_FILE_SIZE
                : MAX_TEXT_FILE_SIZE
              if (info.size <= maxSize && info.size > 0) {
                files.push(fullPath)
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      }
    }

    await walk(folderPath)
    return files
  }

  private async indexFile(folderPath: string, filePath: string): Promise<void> {
    const ext = extname(filePath).toLowerCase()
    let content: string

    if (BINARY_DOC_EXTENSIONS.has(ext)) {
      // Binary document — needs MarkItDown conversion
      if (!this.markitdownConvert) return // MarkItDown not available, skip
      const result = await this.markitdownConvert(filePath)
      if (!result.success || !result.content.trim()) return
      content = result.content
    } else {
      // Text file — read directly
      const file = Bun.file(filePath)
      content = await file.text()
    }

    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(content)
    const fileHash = hasher.digest("hex")

    // Check if file already indexed with same hash
    const existing = this.store.getSourceByPath(filePath)
    if (existing && existing.file_hash === fileHash) {
      return // Already up to date
    }

    // Chunk the content (parent-child dual-layer)
    const { parents, children } = chunkText(content)
    if (parents.length === 0) return

    // Generate embeddings for child chunks only
    const embeddings = this.embedder.embedBatch(children.map((c) => c.content))

    // Store
    let sourceId: number
    if (existing) {
      sourceId = existing.id
      this.store.updateSourceHash(filePath, fileHash)
    } else {
      sourceId = this.store.addSource(folderPath, filePath, fileHash)
    }

    const relPath = relative(folderPath, filePath)

    this.store.addChunks(
      sourceId,
      parents.map((p) => ({
        content: p.content,
        chunkIndex: p.chunkIndex,
        metadata: {
          file_path: relPath,
          start_line: p.startLine,
          end_line: p.endLine,
        } satisfies ChunkMetadata,
      })),
      children.map((child, i) => ({
        content: child.content,
        chunkIndex: child.chunkIndex,
        metadata: {
          file_path: relPath,
          start_line: child.startLine,
          end_line: child.endLine,
        } satisfies ChunkMetadata,
        parentIndex: child.parentIndex,
        embedding: embeddings[i],
      })),
    )

    const totalChunks = parents.length + children.length
    this.store.updateSourceChunkCount(sourceId, totalChunks)
  }

  async removeFolder(folderPath: string): Promise<void> {
    this.store.removeFolder(folderPath)
    this.statuses.delete(folderPath)
  }

  getStatus(folderPath: string): IndexStatus {
    return (
      this.statuses.get(folderPath) ?? {
        folderPath,
        totalFiles: 0,
        indexedFiles: 0,
        skippedFiles: 0,
        status: "idle",
      }
    )
  }

  listFolders(): IndexStatus[] {
    // Merge DB state with runtime statuses
    const dbFolders = this.store.listFolders()
    const result: IndexStatus[] = []

    const seen = new Set<string>()
    for (const [path, status] of this.statuses) {
      result.push(status)
      seen.add(path)
    }
    for (const folder of dbFolders) {
      if (!seen.has(folder.folderPath)) {
        result.push({
          folderPath: folder.folderPath,
          totalFiles: folder.fileCount,
          indexedFiles: folder.fileCount,
          skippedFiles: 0,
          status: "complete",
        })
      }
    }

    return result
  }

  /** Check if legacy data needs re-indexing and trigger it */
  async autoMigrate(): Promise<void> {
    const folders = this.store.needsReindex()
    if (folders.length === 0) return

    console.log(`[indexer] Auto-migrating ${folders.length} folder(s) to parent-child chunks...`)
    for (const folderPath of folders) {
      try {
        await this.indexFolder(folderPath)
        console.log(`[indexer] Migrated: ${folderPath}`)
      } catch (err) {
        console.error(`[indexer] Failed to migrate ${folderPath}:`, err)
      }
    }
  }
}
