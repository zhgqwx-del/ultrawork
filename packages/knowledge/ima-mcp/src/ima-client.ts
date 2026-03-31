/**
 * IMA OpenAPI HTTP client
 * Base URL: https://ima.qq.com
 * Auth: ima-openapi-clientid + ima-openapi-apikey headers
 */

const BASE_URL = "https://ima.qq.com"

export interface IMACredentials {
  clientId: string
  apiKey: string
}

// --- Response types ---

interface IMAResponse<T> {
  code: number
  msg: string
  data: T
}

export interface AddableKnowledgeBase {
  id: string
  name: string
}

export interface SearchedKnowledgeInfo {
  media_id: string
  title: string
  parent_folder_id: string
  highlight_content: string
}

export interface SearchedDoc {
  doc: {
    basic_info: {
      docid: string
      title: string
      summary: string
      create_time: number
      modify_time: number
      folder_id: string
      folder_name: string
    }
  }
  highlight_info: Record<string, string>
}

export interface KnowledgeBaseInfo {
  id: string
  name: string
  cover_url: string
  description: string
  recommended_questions: string[]
}

// --- Client ---

export class IMAClient {
  private credentials: IMACredentials

  constructor(credentials: IMACredentials) {
    this.credentials = credentials
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${BASE_URL}${path}`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ima-openapi-clientid": this.credentials.clientId,
        "ima-openapi-apikey": this.credentials.apiKey,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      throw new Error(`IMA API HTTP ${res.status}: ${res.statusText}`)
    }

    const json = (await res.json()) as IMAResponse<T>
    if (json.code !== 0) {
      throw new Error(`IMA API error ${json.code}: ${json.msg}`)
    }

    return json.data
  }

  /** List knowledge bases the user can access */
  async listKnowledgeBases(): Promise<AddableKnowledgeBase[]> {
    const all: AddableKnowledgeBase[] = []
    let cursor = ""

    while (true) {
      const data = await this.request<{
        addable_knowledge_base_list: AddableKnowledgeBase[]
        next_cursor: string
        is_end: boolean
      }>("/openapi/wiki/v1/get_addable_knowledge_base_list", {
        cursor,
        limit: 50,
      })

      all.push(...data.addable_knowledge_base_list)
      if (data.is_end) break
      cursor = data.next_cursor
    }

    return all
  }

  /** Get knowledge base details */
  async getKnowledgeBase(ids: string[]): Promise<Record<string, KnowledgeBaseInfo>> {
    const data = await this.request<{
      infos: Record<string, KnowledgeBaseInfo>
    }>("/openapi/wiki/v1/get_knowledge_base", { ids })
    return data.infos
  }

  /** Search within a knowledge base */
  async searchKnowledge(
    knowledgeBaseId: string,
    query: string,
    cursor = ""
  ): Promise<{
    results: SearchedKnowledgeInfo[]
    nextCursor: string
    isEnd: boolean
  }> {
    const data = await this.request<{
      info_list: SearchedKnowledgeInfo[]
      next_cursor: string
      is_end: boolean
    }>("/openapi/wiki/v1/search_knowledge", {
      knowledge_base_id: knowledgeBaseId,
      query,
      cursor,
    })

    return {
      results: data.info_list ?? [],
      nextCursor: data.next_cursor,
      isEnd: data.is_end,
    }
  }

  /** Search notes by title or content */
  async searchNotes(
    query: string,
    options: { searchType?: 0 | 1; start?: number; end?: number } = {}
  ): Promise<{
    docs: SearchedDoc[]
    totalHits: number
    isEnd: boolean
  }> {
    const { searchType = 0, start = 0, end = 10 } = options

    const queryInfo =
      searchType === 0 ? { title: query } : { content: query }

    const data = await this.request<{
      docs: SearchedDoc[]
      is_end: boolean
      total_hit_num: string
    }>("/openapi/note/v1/search_note_book", {
      search_type: searchType,
      query_info: queryInfo,
      start,
      end,
    })

    return {
      docs: data.docs ?? [],
      totalHits: parseInt(data.total_hit_num ?? "0", 10),
      isEnd: data.is_end,
    }
  }

  /** Read a note's content */
  async getNoteContent(docId: string): Promise<string> {
    const data = await this.request<{
      content: string
    }>("/openapi/note/v1/get_doc_content", {
      doc_id: docId,
      target_content_format: 0, // plain text
    })
    return data.content
  }
}
