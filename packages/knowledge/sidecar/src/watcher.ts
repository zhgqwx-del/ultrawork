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

/**
 * Distinct files one folder may accumulate in a batch window before we stop
 * tracking them individually and re-walk the folder instead.
 *
 * This guards the BOOKKEEPING only — the timer map and the batch Set, both of
 * which were unbounded. Re-index concurrency is bounded separately, by the
 * sequential queue in index.ts; conflating the two would be a bad trade, because
 * `indexFile` reads and hashes every file it is given, so a folder-wide pass
 * over a large tree is far more I/O than the handful of files that actually
 * changed. Hence a threshold high enough that ordinary bulk edits (a big
 * checkout) stay incremental, and only a genuinely pathological burst escalates.
 */
const MAX_BATCH_FILES = 2000

export type WatchCallback = (
  folderPath: string,
  filePath: string,
  /** `rescan` carries the FOLDER path in both arguments — see MAX_BATCH_FILES. */
  eventType: "change" | "delete" | "rescan",
) => void

/**
 * Watches indexed folders for file changes and triggers re-indexing.
 * Uses fs.watch with recursive mode + per-file debounce + per-folder batching.
 */
export class FileWatcher {
  private watchers = new Map<string, FSWatcher>()
  private fileTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private folderBatchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private folderBatches = new Map<string, Set<string>>()
  /** Folders whose current window overflowed and will be re-walked wholesale. */
  private folderRescan = new Set<string>()
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
    this.folderRescan.delete(folderPath)
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
    // Already escalated: the whole folder gets re-walked, so per-file bookkeeping
    // for it is wasted work — and creating a timer per file is exactly the
    // unbounded growth the escalation exists to stop.
    if (this.folderRescan.has(folderPath)) return

    const fullPath = join(folderPath, filename)
    const ext = extname(filename).toLowerCase()

    // Filter: only supported extensions
    if (!SUPPORTED_EXTENSIONS.has(ext)) return

    // Filter: ignore paths containing ignored segments.
    // fs.watch yields backslash-separated paths on Windows — split on both.
    const segments = filename.split(/[\\/]/)
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
    if (this.folderRescan.has(folderPath)) return

    let batch = this.folderBatches.get(folderPath)
    if (!batch) {
      batch = new Set()
      this.folderBatches.set(folderPath, batch)
    }
    batch.add(filePath)

    if (batch.size >= MAX_BATCH_FILES) {
      // Hand the whole folder to one sequential pass and drop the per-file list.
      // The flush timer already scheduled below still fires and reads the flag.
      console.log(
        `[watcher] ${batch.size} files changed in ${folderPath} — escalating to a full re-index`,
      )
      this.folderRescan.add(folderPath)
      this.folderBatches.delete(folderPath)
    }

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
    const rescan = this.folderRescan.delete(folderPath)

    if (!this.callback) return

    if (rescan) {
      this.callback(folderPath, folderPath, "rescan")
      return
    }

    if (!batch || batch.size === 0) return

    console.log(`[watcher] ${batch.size} file(s) changed in ${folderPath}`)

    for (const filePath of batch) {
      this.callback(folderPath, filePath, "change")
    }
  }
}
