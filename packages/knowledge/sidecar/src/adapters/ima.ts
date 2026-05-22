import type { KnowledgeAdapter, TestConnectionResult, RemoteKnowledgeBase } from "./types"
import type { AdapterSearchResult, IMAConfig } from "../types"

const DEFAULT_BASE_URL = "https://ima.qq.com"
const REQUEST_TIMEOUT = 15_000
/** Timeout for get_doc_content which may return large documents */
const DOC_CONTENT_TIMEOUT = 30_000

interface IMAResponse<T> {
  retcode?: number
  code?: number
  errmsg?: string
  msg?: string
  data?: T
}

// --- Wiki types ---

interface IMAKnowledgeBase {
  id: string
  name: string
  cover_url?: string
  description?: string
}

interface IMASearchItem {
  media_id: string
  title: string
  parent_folder_id?: string
  highlight_content?: string
}

// --- Notes types (aligned with official ima-skill v1.1.7 API) ---

/** NoteFolderInfo from list_notebook response */
interface IMANotebook {
  folder_id: string
  name: string
  note_number?: number
  folder_type?: number // 0=user-created, 1=all-notes, 2=uncategorized
}

/** SearchNoteInfo from search_note response — nested structure */
interface IMASearchNoteInfo {
  note_book_info: {
    note_id: string
    title: string
    summary?: string
    note_ext_info?: {
      folder_id?: string
      folder_name?: string
    }
  }
  highlightInfo?: Record<string, string>
}

/** GetNoteContentRsp */
interface IMADocContent {
  content: string
}

export class IMAAdapter implements KnowledgeAdapter {
  readonly type = "ima"

  /** IMA API returns either `code`/`msg` or `retcode`/`errmsg` depending on endpoint */
  private responseCode(resp: IMAResponse<unknown>): number {
    return resp.code ?? resp.retcode ?? -1
  }

  private responseMsg(resp: IMAResponse<unknown>): string {
    return resp.msg ?? resp.errmsg ?? ""
  }

  private baseUrl(config: IMAConfig): string {
    return config.baseUrl || DEFAULT_BASE_URL
  }

  private headers(config: IMAConfig): Record<string, string> {
    return {
      "ima-openapi-clientid": config.clientId,
      "ima-openapi-apikey": config.apiKey,
      "Content-Type": "application/json",
    }
  }

  private async imaFetch<T>(
    config: IMAConfig,
    path: string,
    body: Record<string, unknown>,
    timeout: number = REQUEST_TIMEOUT,
  ): Promise<IMAResponse<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const resp = await fetch(`${this.baseUrl(config)}${path}`, {
        method: "POST",
        headers: this.headers(config),
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        return { retcode: resp.status, errmsg: `HTTP ${resp.status}: ${text}` }
      }

      return (await resp.json()) as IMAResponse<T>
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { retcode: -1, errmsg: "Request timed out" }
      }
      return { retcode: -1, errmsg: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------------------------------------------------------------------------
  // Public interface — dispatches by config.module
  // ---------------------------------------------------------------------------

  async testConnection(config: unknown): Promise<TestConnectionResult> {
    const imaConfig = config as IMAConfig
    if (!imaConfig.clientId || !imaConfig.apiKey) {
      return { ok: false, message: "Client ID and API Key are required" }
    }

    console.log(`[ima] testConnection module=${imaConfig.module ?? "wiki(default)"}`)
    if (imaConfig.module === "notes") {
      return this.testConnectionNotes(imaConfig)
    }
    return this.testConnectionWiki(imaConfig)
  }

  async listBases(config: unknown): Promise<RemoteKnowledgeBase[]> {
    const imaConfig = config as IMAConfig
    if (imaConfig.module === "notes") {
      return this.listNotebooks(imaConfig)
    }
    const result = await this.testConnectionWiki(imaConfig)
    return result.bases ?? []
  }

  async search(
    query: string,
    config: unknown,
    options?: { limit?: number },
  ): Promise<AdapterSearchResult[]> {
    const imaConfig = config as IMAConfig
    if (imaConfig.module === "notes") {
      return this.searchNotes(query, imaConfig, options)
    }
    return this.searchWiki(query, imaConfig, options)
  }

  // ---------------------------------------------------------------------------
  // Wiki module (Phase 3 — existing)
  // ---------------------------------------------------------------------------

  private async testConnectionWiki(config: IMAConfig): Promise<TestConnectionResult> {
    const resp = await this.imaFetch<{
      addable_knowledge_base_list: IMAKnowledgeBase[]
      is_end: boolean
      next_cursor: string
    }>(config, "/openapi/wiki/v1/get_addable_knowledge_base_list", {
      cursor: "",
      limit: 50,
    })

    const code = this.responseCode(resp)
    if (code !== 0) {
      return { ok: false, message: this.formatErrorMessage(code, resp) }
    }

    const bases: RemoteKnowledgeBase[] = (
      resp.data?.addable_knowledge_base_list ?? []
    ).map((kb) => ({
      id: kb.id,
      name: kb.name,
      description: kb.description,
    }))

    return { ok: true, bases }
  }

  private async searchWiki(
    query: string,
    config: IMAConfig,
    options?: { limit?: number },
  ): Promise<AdapterSearchResult[]> {
    const kbId = config.knowledgeBaseId
    if (!kbId) {
      throw new Error("No knowledge base ID configured for IMA source")
    }

    const resp = await this.imaFetch<{
      info_list: IMASearchItem[]
      is_end: boolean
      next_cursor: string
    }>(config, "/openapi/wiki/v1/search_knowledge", {
      query,
      cursor: "",
      knowledge_base_id: kbId,
    })

    const code = this.responseCode(resp)
    if (code !== 0) {
      throw new Error(`IMA Wiki search failed: ${this.responseMsg(resp) || code}`)
    }

    const items = resp.data?.info_list ?? []
    const kbName = config.knowledgeBaseName || kbId
    const limit = options?.limit ?? 5
    const topItems = items.slice(0, limit)

    // Try to enrich results: for note-type media (media_type=11), fetch full content
    // via get_media_info → get_doc_content cross-module chain
    const results = await Promise.all(
      topItems.map(async (item, index): Promise<AdapterSearchResult> => {
        let content = item.highlight_content || item.title
        let hasFullContent = false

        // Attempt to get full content via get_media_info for richer results
        const fullContent = await this.getMediaFullContent(config, item.media_id)
        if (fullContent) {
          content = fullContent
          hasFullContent = true
        }

        return {
          content,
          score: 1 - index * 0.05,
          title: item.title,
          sourceId: 0, // filled by caller
          sourceLabel: `IMA Wiki: ${kbName}`,
          metadata: {
            mediaId: item.media_id,
            folderId: item.parent_folder_id,
            hasFullContent,
          },
        }
      }),
    )

    return results
  }

  /**
   * Try to get full content for a Wiki knowledge item via get_media_info.
   * For note-type items (media_type=11), chains to get_doc_content.
   * Returns null on any failure — caller falls back to highlight_content.
   */
  private async getMediaFullContent(config: IMAConfig, mediaId: string): Promise<string | null> {
    try {
      const resp = await this.imaFetch<{
        media_type?: number
        url_info?: { url?: string; headers?: Record<string, string> }
        notebook_ext_info?: { notebook_id?: string }
      }>(config, "/openapi/wiki/v1/get_media_info", { media_id: mediaId })

      const code = this.responseCode(resp)
      if (code !== 0) {
        console.log(`[ima] get_media_info ${mediaId}: code=${code} (skipping full content)`)
        return null
      }

      const data = resp.data
      if (!data) return null

      // Note-type media: chain to notes module get_doc_content
      if (data.media_type === 11 && data.notebook_ext_info?.notebook_id) {
        console.log(`[ima] get_media_info ${mediaId}: note-type, chaining to get_doc_content (notebook_id=${data.notebook_ext_info.notebook_id})`)
        return this.getDocContent(config, data.notebook_ext_info.notebook_id)
      }

      // URL-type media: could fetch content, but that's expensive and may be binary
      console.log(`[ima] get_media_info ${mediaId}: media_type=${data.media_type} (no full content available)`)
      return null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Notes module (Phase 4a — new)
  // ---------------------------------------------------------------------------

  private async testConnectionNotes(config: IMAConfig): Promise<TestConnectionResult> {
    // Official endpoint: POST /openapi/note/v1/list_notebook
    // cursor starts at "0" (not ""), limit max 20
    console.log(`[ima] testConnectionNotes: calling list_notebook`)
    const resp = await this.imaFetch<{
      note_folder_infos: IMANotebook[]
      is_end: boolean
      next_cursor: string
    }>(config, "/openapi/note/v1/list_notebook", {
      cursor: "0",
      limit: 20,
    })

    const code = this.responseCode(resp)
    console.log(`[ima] list_notebook response: code=${code} folders=${resp.data?.note_folder_infos?.length ?? 0}`)
    if (code !== 0) {
      console.error(`[ima] list_notebook failed: ${this.responseMsg(resp)}`)
      return { ok: false, message: this.formatErrorMessage(code, resp) }
    }

    const allFolders = resp.data?.note_folder_infos ?? []
    const userFolders = allFolders.filter((nb) => nb.folder_type === 0)
    console.log(`[ima] notebooks: total=${allFolders.length} userCreated=${userFolders.length}`)

    const bases: RemoteKnowledgeBase[] = []

    // Always offer "All Notes" as first option — search_note searches all notes
    // regardless of folder, so this is the most useful default.
    // list_notebook may not return system folders, so we always synthesize this entry.
    bases.push({
      id: "__all_notes__",
      name: "全部笔记 / All Notes",
      description: "Search across all your notes",
    })

    // Then list user-created notebooks (if any)
    for (const nb of userFolders) {
      bases.push({
        id: nb.folder_id,
        name: nb.name,
        documentCount: nb.note_number,
      })
    }

    return { ok: true, bases }
  }

  private async listNotebooks(config: IMAConfig): Promise<RemoteKnowledgeBase[]> {
    const result = await this.testConnectionNotes(config)
    return result.bases ?? []
  }

  /**
   * Search notes via `search_note` (official endpoint), then fetch full content
   * via `get_doc_content`. This gives much higher quality results than Wiki search.
   *
   * Official API: POST /openapi/note/v1/search_note
   * - search_type: 0=title, 1=content (full-text body search)
   * - query_info: { title?: string, content?: string }
   * - Pagination: offset-based (start/end), not cursor-based
   * - Response: search_note_infos[].note_book_info.note_id
   */
  private async searchNotes(
    query: string,
    config: IMAConfig,
    options?: { limit?: number },
  ): Promise<AdapterSearchResult[]> {
    const limit = options?.limit ?? 5

    // Note: search_note has no folder_id filter — it searches ALL user notes.
    // config.notebookId is only used for the sourceLabel display, not for API filtering.
    // Step 1: Search notes by content (search_type=1)
    console.log(`[ima] searchNotes: query="${query}" limit=${limit}`)
    const searchResp = await this.imaFetch<{
      search_note_infos: IMASearchNoteInfo[]
      is_end: boolean
      total_hit_num?: number
    }>(config, "/openapi/note/v1/search_note", {
      search_type: 1, // 1 = DOC_CONTENT (full-text body search)
      query_info: { content: query },
      start: 0,
      end: limit,
    })

    const code = this.responseCode(searchResp)
    if (code !== 0) {
      console.error(`[ima] search_note failed: code=${code} msg=${this.responseMsg(searchResp)}`)
      throw new Error(`IMA Notes search failed: ${this.responseMsg(searchResp) || code}`)
    }

    const items = searchResp.data?.search_note_infos ?? []
    console.log(`[ima] search_note returned ${items.length} results (total_hit=${searchResp.data?.total_hit_num ?? "?"})`)
    if (items.length === 0) return []

    const nbName = config.notebookName || config.notebookId || "Notes"

    // Step 2: Fetch full content for each matched note (parallel, with timeout)
    const results = await Promise.all(
      items.slice(0, limit).map(async (item, index): Promise<AdapterSearchResult> => {
        const noteInfo = item.note_book_info
        const noteId = noteInfo.note_id
        console.log(`[ima] fetching full content for note "${noteInfo.title}" (id=${noteId})`)
        const fullContent = await this.getDocContent(config, noteId)
        console.log(`[ima] get_doc_content for ${noteId}: ${fullContent ? `${fullContent.length} chars` : "FAILED (fallback to summary)"}`)
        return {
          content: fullContent || noteInfo.summary || noteInfo.title,
          score: 1 - index * 0.05,
          title: noteInfo.title,
          sourceId: 0, // filled by caller
          sourceLabel: `IMA Notes: ${nbName}`,
          metadata: {
            noteId,
            folderId: noteInfo.note_ext_info?.folder_id,
            folderName: noteInfo.note_ext_info?.folder_name,
            hasFullContent: !!fullContent,
          },
        }
      }),
    )

    return results
  }

  /**
   * Fetch full document content via `get_doc_content`.
   * Returns plain text content or null on failure.
   *
   * Official API: POST /openapi/note/v1/get_doc_content
   * - note_id (not doc_id): the note's unique ID
   * - target_content_format: 0=PLAINTEXT (recommended), 1=MARKDOWN (not supported), 2=JSON
   * - Error 210005: not the note's author — gracefully degrade
   */
  private async getDocContent(config: IMAConfig, noteId: string): Promise<string | null> {
    try {
      const resp = await this.imaFetch<IMADocContent>(
        config,
        "/openapi/note/v1/get_doc_content",
        { note_id: noteId, target_content_format: 0 },
        DOC_CONTENT_TIMEOUT,
      )

      const code = this.responseCode(resp)
      if (code !== 0) {
        // 210005 = not author — expected for shared/subscribed notes
        const level = code === 210005 ? "warn" : "error"
        console[level](`[ima] get_doc_content ${code} for ${noteId}: ${this.responseMsg(resp)}`)
        return null
      }

      return resp.data?.content ?? null
    } catch (err) {
      console.error(`[ima] get_doc_content error for ${noteId}:`, err)
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private formatErrorMessage(code: number, resp: IMAResponse<unknown>): string {
    switch (code) {
      case 20004: return "API Key authentication failed"
      case 110030: return "No permission"
      case 110021: return "Rate limited, please try again later"
      default: return this.responseMsg(resp) || `Error code: ${code}`
    }
  }
}
