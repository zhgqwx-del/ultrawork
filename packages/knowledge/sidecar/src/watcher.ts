import { watch, type FSWatcher } from "fs"
import { extname, join, relative } from "path"

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
  ".pdf", ".docx", ".xlsx", ".pptx",
])

const IGNORE_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", "vendor", ".idea", ".vscode",
  "target", "coverage", ".turbo", ".cache",
])

/** Per-file debounce delay (ms) */
const FILE_DEBOUNCE = 2000
/** Per-folder batch delay: after first change in a batch, wait this long before processing (ms) */
const FOLDER_BATCH_DELAY = 5000

export type WatchCallback = (folderPath: string, filePath: string, eventType: "change" | "delete") => void

/**
 * Watches indexed folders for file changes and triggers re-indexing.
 * Uses fs.watch with recursive mode + per-file debounce + per-folder batching.
 */
export class FileWatcher {
  private watchers = new Map<string, FSWatcher>()
  private fileTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private folderBatchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private folderBatches = new Map<string, Set<string>>()
  private callback: WatchCallback | null = null

  /** Set the callback for file change events */
  onChange(cb: WatchCallback): void {
    this.callback = cb
  }

  /** Start watching a folder */
  watchFolder(folderPath: string): void {
    if (this.watchers.has(folderPath)) return

    try {
      const watcher = watch(folderPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return
        this.handleEvent(folderPath, filename, eventType)
      })

      watcher.on("error", (err) => {
        console.error(`[watcher] Error watching ${folderPath}:`, err)
      })

      this.watchers.set(folderPath, watcher)
      console.log(`[watcher] Watching: ${folderPath}`)
    } catch (err) {
      console.error(`[watcher] Failed to watch ${folderPath}:`, err)
    }
  }

  /** Stop watching a folder */
  unwatchFolder(folderPath: string): void {
    const watcher = this.watchers.get(folderPath)
    if (watcher) {
      watcher.close()
      this.watchers.delete(folderPath)
      console.log(`[watcher] Unwatched: ${folderPath}`)
    }

    // Clean up pending timers for this folder
    const batchTimer = this.folderBatchTimers.get(folderPath)
    if (batchTimer) {
      clearTimeout(batchTimer)
      this.folderBatchTimers.delete(folderPath)
    }
    this.folderBatches.delete(folderPath)
  }

  /** Stop watching all folders */
  unwatchAll(): void {
    for (const [path] of this.watchers) {
      this.unwatchFolder(path)
    }
    // Clear all file timers
    for (const timer of this.fileTimers.values()) {
      clearTimeout(timer)
    }
    this.fileTimers.clear()
  }

  private handleEvent(folderPath: string, filename: string, eventType: string): void {
    const fullPath = join(folderPath, filename)
    const ext = extname(filename).toLowerCase()

    // Filter: only supported extensions
    if (!SUPPORTED_EXTENSIONS.has(ext)) return

    // Filter: ignore paths containing ignored segments
    const segments = filename.split("/")
    if (segments.some((s) => IGNORE_SEGMENTS.has(s) || s.startsWith("."))) return

    // Per-file debounce: cancel previous timer for this file
    const existingTimer = this.fileTimers.get(fullPath)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Set new timer — when it fires, add to folder batch
    this.fileTimers.set(
      fullPath,
      setTimeout(() => {
        this.fileTimers.delete(fullPath)
        this.addToBatch(folderPath, fullPath)
      }, FILE_DEBOUNCE),
    )
  }

  private addToBatch(folderPath: string, filePath: string): void {
    let batch = this.folderBatches.get(folderPath)
    if (!batch) {
      batch = new Set()
      this.folderBatches.set(folderPath, batch)
    }
    batch.add(filePath)

    // Start/restart folder batch timer
    const existing = this.folderBatchTimers.get(folderPath)
    if (!existing) {
      // First file in batch — set timer
      this.folderBatchTimers.set(
        folderPath,
        setTimeout(() => {
          this.flushBatch(folderPath)
        }, FOLDER_BATCH_DELAY),
      )
    }
    // If timer already exists, let it fire at its original time
    // (we don't reset it — this gives a maximum wait window)
  }

  private flushBatch(folderPath: string): void {
    this.folderBatchTimers.delete(folderPath)
    const batch = this.folderBatches.get(folderPath)
    this.folderBatches.delete(folderPath)

    if (!batch || batch.size === 0 || !this.callback) return

    console.log(`[watcher] ${batch.size} file(s) changed in ${folderPath}`)

    for (const filePath of batch) {
      this.callback(folderPath, filePath, "change")
    }
  }
}
