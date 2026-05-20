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
}
