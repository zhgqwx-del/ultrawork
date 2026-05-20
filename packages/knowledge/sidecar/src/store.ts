import { Database } from "bun:sqlite"
import type { SourceRow, ChunkRow, ChunkMetadata, KnowledgeSourceRow } from "./types"

export class KnowledgeStore {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode=WAL")
    this.db.exec("PRAGMA foreign_keys=ON")
    this.migrate()
  }

  // ---------------------------------------------------------------------------
  // Schema migration
  // ---------------------------------------------------------------------------

  private migrate(): void {
    // Ensure migrations table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)

    const currentVersion = this.getSchemaVersion()

    if (currentVersion < 1) this.migrateV1()
    if (currentVersion < 2) this.migrateV2()
    if (currentVersion < 3) this.migrateV3()
  }

  private getSchemaVersion(): number {
    const row = this.db
      .query("SELECT MAX(version) AS v FROM _migrations")
      .get() as { v: number | null } | null
    return row?.v ?? 0
  }

  /** V1: Original Phase 1 schema (for fresh installs) */
  private migrateV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_path TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        file_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        chunk_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_sources_folder ON sources(folder_path);

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL
      );
    `)

    // FTS5 virtual table
    const ftsExists = this.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'")
      .get()
    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          content,
          content='chunks',
          content_rowid='id'
        );

        CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;

        CREATE TRIGGER chunks_fts_au AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `)
    }

    this.db.query("INSERT INTO _migrations (version) VALUES (1)").run()
  }

  /** V2: Parent-Child chunking columns */
  private migrateV2(): void {
    // Add parent_id and chunk_type columns
    // SQLite ALTER TABLE ADD COLUMN is safe for existing data
    const hasParentId = this.db
      .query("SELECT 1 FROM pragma_table_info('chunks') WHERE name='parent_id'")
      .get()

    if (!hasParentId) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN parent_id INTEGER REFERENCES chunks(id)")
      this.db.exec("ALTER TABLE chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'child'")
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_id)")
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(chunk_type)")
    }

    this.db.query("INSERT INTO _migrations (version) VALUES (2)").run()
  }

  /** V3: Unified knowledge_sources registry + ks_id foreign key */
  private migrateV3(): void {
    const hasTable = this.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_sources'")
      .get()

    if (!hasTable) {
      this.db.exec(`
        CREATE TABLE knowledge_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL DEFAULT 'local_folder',
          name TEXT NOT NULL,
          config_json TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'idle',
          error_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)

      // Migrate existing local folder sources
      const folders = this.db
        .query("SELECT DISTINCT folder_path FROM sources")
        .all() as { folder_path: string }[]

      const insertKS = this.db.prepare(
        "INSERT INTO knowledge_sources (type, name, config_json, status) VALUES ('local_folder', ?, ?, 'complete') RETURNING id",
      )
      for (const { folder_path } of folders) {
        const name = folder_path.split("/").pop() || folder_path
        const configJson = JSON.stringify({ folderPath: folder_path })
        insertKS.get(name, configJson)
      }

      // Add ks_id column to sources table
      const hasKsId = this.db
        .query("SELECT 1 FROM pragma_table_info('sources') WHERE name='ks_id'")
        .get()

      if (!hasKsId) {
        this.db.exec("ALTER TABLE sources ADD COLUMN ks_id INTEGER REFERENCES knowledge_sources(id)")

        // Backfill ks_id
        this.db.exec(`
          UPDATE sources SET ks_id = (
            SELECT ks.id FROM knowledge_sources ks
            WHERE json_extract(ks.config_json, '$.folderPath') = sources.folder_path
          )
        `)

        this.db.exec("CREATE INDEX IF NOT EXISTS idx_sources_ks ON sources(ks_id)")
      }
    }

    this.db.query("INSERT INTO _migrations (version) VALUES (3)").run()
  }

  // ---------------------------------------------------------------------------
  // Knowledge Sources CRUD (Phase 3)
  // ---------------------------------------------------------------------------

  createKnowledgeSource(
    type: string,
    name: string,
    config: Record<string, unknown>,
  ): number {
    const result = this.db
      .query(
        "INSERT INTO knowledge_sources (type, name, config_json) VALUES (?, ?, ?) RETURNING id",
      )
      .get(type, name, JSON.stringify(config)) as { id: number }
    return result.id
  }

  getKnowledgeSource(id: number): KnowledgeSourceRow | null {
    return this.db
      .query("SELECT * FROM knowledge_sources WHERE id = ?")
      .get(id) as KnowledgeSourceRow | null
  }

  getKnowledgeSourceByFolderPath(folderPath: string): KnowledgeSourceRow | null {
    return this.db
      .query(
        "SELECT * FROM knowledge_sources WHERE type = 'local_folder' AND json_extract(config_json, '$.folderPath') = ?",
      )
      .get(folderPath) as KnowledgeSourceRow | null
  }

  listKnowledgeSources(): KnowledgeSourceRow[] {
    return this.db
      .query("SELECT * FROM knowledge_sources ORDER BY created_at DESC")
      .all() as KnowledgeSourceRow[]
  }

  updateKnowledgeSource(
    id: number,
    updates: Partial<{
      name: string
      config_json: string
      enabled: number
      status: string
      error_message: string | null
    }>,
  ): void {
    const fields: string[] = []
    const values: (string | number | null)[] = []

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`)
      values.push(value as string | number | null)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    this.db
      .query(`UPDATE knowledge_sources SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values)
  }

  deleteKnowledgeSource(id: number): void {
    // For local_folder type, also cascade delete from sources table
    const ks = this.getKnowledgeSource(id)
    if (ks && ks.type === "local_folder") {
      const config = JSON.parse(ks.config_json) as { folderPath?: string }
      if (config.folderPath) {
        this.removeFolder(config.folderPath)
      }
    }
    this.db.query("DELETE FROM knowledge_sources WHERE id = ?").run(id)
  }

  /**
   * Check if legacy data exists (Phase 1 chunks without parent-child structure).
   * Returns folder paths that need re-indexing.
   */
  needsReindex(): string[] {
    const rows = this.db
      .query(`
        SELECT DISTINCT s.folder_path
        FROM chunks c
        JOIN sources s ON s.id = c.source_id
        WHERE c.parent_id IS NULL AND c.chunk_type = 'child'
      `)
      .all() as { folder_path: string }[]
    return rows.map((r) => r.folder_path)
  }

  // ---------------------------------------------------------------------------
  // Source CRUD
  // ---------------------------------------------------------------------------

  addSource(folderPath: string, filePath: string, fileHash: string): number {
    // Link to knowledge_sources entry if exists
    const ks = this.getKnowledgeSourceByFolderPath(folderPath)
    const ksId = ks?.id ?? null
    const result = this.db
      .query(
        "INSERT INTO sources (folder_path, file_path, file_hash, ks_id) VALUES (?, ?, ?, ?) RETURNING id",
      )
      .get(folderPath, filePath, fileHash, ksId) as { id: number }
    return result.id
  }

  updateSourceHash(filePath: string, fileHash: string): void {
    this.db
      .query(
        "UPDATE sources SET file_hash = ?, indexed_at = datetime('now') WHERE file_path = ?",
      )
      .run(fileHash, filePath)
  }

  updateSourceChunkCount(sourceId: number, count: number): void {
    this.db
      .query("UPDATE sources SET chunk_count = ? WHERE id = ?")
      .run(count, sourceId)
  }

  getSourceByPath(filePath: string): SourceRow | null {
    return this.db
      .query("SELECT * FROM sources WHERE file_path = ?")
      .get(filePath) as SourceRow | null
  }

  listSources(folderPath?: string): SourceRow[] {
    if (folderPath) {
      return this.db
        .query("SELECT * FROM sources WHERE folder_path = ? ORDER BY file_path")
        .all(folderPath) as SourceRow[]
    }
    return this.db
      .query("SELECT * FROM sources ORDER BY folder_path, file_path")
      .all() as SourceRow[]
  }

  listFolders(): { folderPath: string; fileCount: number; totalChunks: number }[] {
    return this.db
      .query(`
        SELECT folder_path AS folderPath,
               COUNT(*) AS fileCount,
               SUM(chunk_count) AS totalChunks
        FROM sources
        GROUP BY folder_path
        ORDER BY folder_path
      `)
      .all() as { folderPath: string; fileCount: number; totalChunks: number }[]
  }

  removeSource(filePath: string): void {
    // CASCADE will delete chunks and chunk_embeddings
    this.db.query("DELETE FROM sources WHERE file_path = ?").run(filePath)
  }

  removeFolder(folderPath: string): void {
    this.db.query("DELETE FROM sources WHERE folder_path = ?").run(folderPath)
  }

  // ---------------------------------------------------------------------------
  // Chunk CRUD — Parent-Child aware
  // ---------------------------------------------------------------------------

  addChunks(
    sourceId: number,
    parents: { content: string; chunkIndex: number; metadata: ChunkMetadata }[],
    children: { content: string; chunkIndex: number; metadata: ChunkMetadata; parentIndex: number; embedding: Float32Array }[],
  ): void {
    const insertParent = this.db.prepare(
      "INSERT INTO chunks (source_id, content, chunk_index, metadata_json, parent_id, chunk_type) VALUES (?, ?, ?, ?, NULL, 'parent') RETURNING id",
    )
    const insertChild = this.db.prepare(
      "INSERT INTO chunks (source_id, content, chunk_index, metadata_json, parent_id, chunk_type) VALUES (?, ?, ?, ?, ?, 'child') RETURNING id",
    )
    const insertEmbed = this.db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)",
    )

    const transaction = this.db.transaction(() => {
      // Remove old chunks for this source
      this.db.query("DELETE FROM chunks WHERE source_id = ?").run(sourceId)

      // Insert parents first, record their row IDs
      const parentRowIds: number[] = []
      for (const parent of parents) {
        const row = insertParent.get(
          sourceId,
          parent.content,
          parent.chunkIndex,
          JSON.stringify(parent.metadata),
        ) as { id: number }
        parentRowIds.push(row.id)
      }

      // Insert children with parent references + embeddings
      for (const child of children) {
        const parentRowId = parentRowIds[child.parentIndex]
        const row = insertChild.get(
          sourceId,
          child.content,
          child.chunkIndex,
          JSON.stringify(child.metadata),
          parentRowId,
        ) as { id: number }
        insertEmbed.run(row.id, new Uint8Array(child.embedding.buffer))
      }
    })

    transaction()
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /** FTS5 search — only searches child chunks */
  searchFTS(query: string, limit: number = 10): (ChunkRow & { rank: number; folder_path: string })[] {
    return this.db
      .query(`
        SELECT c.*, f.rank, s.folder_path
        FROM chunks_fts f
        JOIN chunks c ON c.id = f.rowid
        JOIN sources s ON s.id = c.source_id
        WHERE chunks_fts MATCH ? AND c.chunk_type = 'child'
        ORDER BY f.rank
        LIMIT ?
      `)
      .all(query, limit) as (ChunkRow & { rank: number; folder_path: string })[]
  }

  /** Get all embeddings (only child chunks have embeddings) */
  getAllEmbeddings(): { chunkId: number; embedding: Float32Array }[] {
    const rows = this.db
      .query("SELECT chunk_id AS chunkId, embedding FROM chunk_embeddings")
      .all() as { chunkId: number; embedding: Uint8Array }[]

    return rows.map((row) => ({
      chunkId: row.chunkId,
      embedding: new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ),
    }))
  }

  getEmbeddingsByFolder(folderPath: string): { chunkId: number; embedding: Float32Array }[] {
    const rows = this.db
      .query(`
        SELECT ce.chunk_id AS chunkId, ce.embedding
        FROM chunk_embeddings ce
        JOIN chunks c ON c.id = ce.chunk_id
        JOIN sources s ON s.id = c.source_id
        WHERE s.folder_path = ?
      `)
      .all(folderPath) as { chunkId: number; embedding: Uint8Array }[]

    return rows.map((row) => ({
      chunkId: row.chunkId,
      embedding: new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ),
    }))
  }

  getChunkById(chunkId: number): (ChunkRow & { folder_path: string; file_path: string }) | null {
    return this.db
      .query(`
        SELECT c.*, s.folder_path, s.file_path
        FROM chunks c
        JOIN sources s ON s.id = c.source_id
        WHERE c.id = ?
      `)
      .get(chunkId) as (ChunkRow & { folder_path: string; file_path: string }) | null
  }

  getChunksByIds(chunkIds: number[]): (ChunkRow & { folder_path: string; file_path: string })[] {
    if (chunkIds.length === 0) return []
    const placeholders = chunkIds.map(() => "?").join(",")
    return this.db
      .query(`
        SELECT c.*, s.folder_path, s.file_path
        FROM chunks c
        JOIN sources s ON s.id = c.source_id
        WHERE c.id IN (${placeholders})
      `)
      .all(...chunkIds) as (ChunkRow & { folder_path: string; file_path: string })[]
  }

  /** Get parent chunk by child's parent_id */
  getParentChunk(parentId: number): (ChunkRow & { folder_path: string; file_path: string }) | null {
    return this.getChunkById(parentId)
  }

  /** Batch-fetch parent chunks for a set of parent IDs */
  getParentChunks(parentIds: number[]): Map<number, ChunkRow & { folder_path: string; file_path: string }> {
    const unique = [...new Set(parentIds)]
    const chunks = this.getChunksByIds(unique)
    return new Map(chunks.map((c) => [c.id, c]))
  }

  getStats(): { sourceCount: number; chunkCount: number; folderCount: number } {
    const row = this.db
      .query(`
        SELECT
          (SELECT COUNT(*) FROM sources) AS sourceCount,
          (SELECT COUNT(*) FROM chunks) AS chunkCount,
          (SELECT COUNT(DISTINCT folder_path) FROM sources) AS folderCount
      `)
      .get() as { sourceCount: number; chunkCount: number; folderCount: number }
    return row
  }

  close(): void {
    this.db.close()
  }
}
