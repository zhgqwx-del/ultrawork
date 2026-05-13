import { Database } from "bun:sqlite"
import type { SourceRow, ChunkRow, ChunkMetadata } from "./types"

export class KnowledgeStore {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode=WAL")
    this.db.exec("PRAGMA foreign_keys=ON")
    this.initSchema()
  }

  private initSchema(): void {
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
    `)

    // FTS5 virtual table for full-text search
    // Check if it already exists before creating
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

    // Embeddings table — simple float blob storage for cosine similarity
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL
      );
    `)
  }

  addSource(folderPath: string, filePath: string, fileHash: string): number {
    const result = this.db
      .query(
        "INSERT INTO sources (folder_path, file_path, file_hash) VALUES (?, ?, ?) RETURNING id",
      )
      .get(folderPath, filePath, fileHash) as { id: number }
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

  addChunks(
    sourceId: number,
    chunks: { content: string; chunkIndex: number; metadata: ChunkMetadata; embedding: Float32Array }[],
  ): void {
    const insertChunk = this.db.prepare(
      "INSERT INTO chunks (source_id, content, chunk_index, metadata_json) VALUES (?, ?, ?, ?) RETURNING id",
    )
    const insertEmbed = this.db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)",
    )

    const transaction = this.db.transaction(() => {
      // Remove old chunks for this source
      this.db.query("DELETE FROM chunks WHERE source_id = ?").run(sourceId)

      for (const chunk of chunks) {
        const row = insertChunk.get(
          sourceId,
          chunk.content,
          chunk.chunkIndex,
          JSON.stringify(chunk.metadata),
        ) as { id: number }
        // Store embedding as raw Float32Array buffer
        insertEmbed.run(row.id, new Uint8Array(chunk.embedding.buffer))
      }
    })

    transaction()
  }

  searchFTS(query: string, limit: number = 10): (ChunkRow & { rank: number; folder_path: string })[] {
    return this.db
      .query(`
        SELECT c.*, f.rank, s.folder_path
        FROM chunks_fts f
        JOIN chunks c ON c.id = f.rowid
        JOIN sources s ON s.id = c.source_id
        WHERE chunks_fts MATCH ?
        ORDER BY f.rank
        LIMIT ?
      `)
      .all(query, limit) as (ChunkRow & { rank: number; folder_path: string })[]
  }

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
