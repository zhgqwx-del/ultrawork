import { readdir, stat } from "fs/promises"
import { join, relative, extname } from "path"
import { KnowledgeStore } from "./store"
import type { Embedder, IndexStatus, ChunkMetadata } from "./types"
import { chunkText } from "./chunker"

const SUPPORTED_EXTENSIONS = new Set([
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

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", "vendor", ".idea", ".vscode",
  "target", "coverage", ".turbo", ".cache",
])

const MAX_FILE_SIZE = 1024 * 1024 // 1MB
const MAX_FILES = 10000

export class Indexer {
  private store: KnowledgeStore
  private embedder: Embedder
  private statuses = new Map<string, IndexStatus>()

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

  async indexFolder(folderPath: string): Promise<IndexStatus> {
    const status: IndexStatus = {
      folderPath,
      totalFiles: 0,
      indexedFiles: 0,
      skippedFiles: 0,
      status: "indexing",
    }
    this.statuses.set(folderPath, status)

    try {
      // Discover files
      const files = await this.discoverFiles(folderPath)
      status.totalFiles = files.length

      // Track existing files to detect deletions
      const existingSources = this.store.listSources(folderPath)
      const existingPaths = new Set(existingSources.map((s) => s.file_path))
      const discoveredPaths = new Set(files)

      // Remove deleted files
      for (const existing of existingSources) {
        if (!discoveredPaths.has(existing.file_path)) {
          this.store.removeSource(existing.file_path)
        }
      }

      // Index new and changed files
      for (const filePath of files) {
        try {
          await this.indexFile(folderPath, filePath)
          status.indexedFiles++
        } catch (err) {
          console.error(`Failed to index ${filePath}:`, err)
          status.skippedFiles++
        }
      }

      status.status = "complete"
    } catch (err) {
      status.status = "error"
      status.error = err instanceof Error ? err.message : String(err)
      console.error(`Failed to index folder ${folderPath}:`, err)
    }

    this.statuses.set(folderPath, status)
    return status
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
              if (info.size <= MAX_FILE_SIZE && info.size > 0) {
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
    const file = Bun.file(filePath)
    const content = await file.text()
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(content)
    const fileHash = hasher.digest("hex")

    // Check if file already indexed with same hash
    const existing = this.store.getSourceByPath(filePath)
    if (existing && existing.file_hash === fileHash) {
      return // Already up to date
    }

    // Chunk the content
    const chunks = chunkText(content)
    if (chunks.length === 0) return

    // Generate embeddings
    const embeddings = this.embedder.embedBatch(chunks.map((c) => c.content))

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
      chunks.map((chunk, i) => ({
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        metadata: {
          file_path: relPath,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
        } satisfies ChunkMetadata,
        embedding: embeddings[i],
      })),
    )

    this.store.updateSourceChunkCount(sourceId, chunks.length)
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
}
