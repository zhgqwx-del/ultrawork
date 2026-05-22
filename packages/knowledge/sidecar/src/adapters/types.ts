import type { AdapterSearchResult } from "../types"

export interface TestConnectionResult {
  ok: boolean
  message?: string
  bases?: RemoteKnowledgeBase[]
}

export interface RemoteKnowledgeBase {
  id: string
  name: string
  description?: string
  documentCount?: number
}

/** Result of a note write operation (create or append) */
export interface WriteNoteResult {
  noteId: string
}

export interface KnowledgeAdapter {
  readonly type: string

  /** Verify credentials / connectivity. Returns ok + optional base list. */
  testConnection(config: unknown): Promise<TestConnectionResult>

  /** Search this knowledge source. Returns unified results. */
  search(
    query: string,
    config: unknown,
    options?: { limit?: number },
  ): Promise<AdapterSearchResult[]>

  /** Optional: list available sub-bases (e.g. IMA has multiple knowledge bases) */
  listBases?(config: unknown): Promise<RemoteKnowledgeBase[]>

  /** Optional: create a new note with Markdown content */
  createNote?(config: unknown, content: string, options?: { title?: string; folderId?: string }): Promise<WriteNoteResult>

  /** Optional: append Markdown content to an existing note */
  appendNote?(config: unknown, noteId: string, content: string): Promise<WriteNoteResult>
}
