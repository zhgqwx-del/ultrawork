import type { KnowledgeAdapter, TestConnectionResult, RemoteKnowledgeBase } from "./types"
import type { AdapterSearchResult, IMAConfig } from "../types"

const DEFAULT_BASE_URL = "https://ima.qq.com"
const REQUEST_TIMEOUT = 15_000

interface IMAResponse<T> {
  retcode?: number
  code?: number
  errmsg?: string
  msg?: string
  data?: T
}

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
  ): Promise<IMAResponse<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

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

  async testConnection(config: unknown): Promise<TestConnectionResult> {
    const imaConfig = config as IMAConfig
    if (!imaConfig.clientId || !imaConfig.apiKey) {
      return { ok: false, message: "Client ID and API Key are required" }
    }

    const resp = await this.imaFetch<{
      addable_knowledge_base_list: IMAKnowledgeBase[]
      is_end: boolean
      next_cursor: string
    }>(imaConfig, "/openapi/wiki/v1/get_addable_knowledge_base_list", {
      cursor: "",
      limit: 50,
    })

    const code = this.responseCode(resp)
    if (code !== 0) {
      const errMsg = code === 20004
        ? "API Key authentication failed"
        : code === 110030
          ? "No permission"
          : code === 110021
            ? "Rate limited, please try again later"
            : this.responseMsg(resp) || `Error code: ${code}`
      return { ok: false, message: errMsg }
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

  async listBases(config: unknown): Promise<RemoteKnowledgeBase[]> {
    const result = await this.testConnection(config)
    return result.bases ?? []
  }

  async search(
    query: string,
    config: unknown,
    options?: { limit?: number },
  ): Promise<AdapterSearchResult[]> {
    const imaConfig = config as IMAConfig
    const kbId = imaConfig.knowledgeBaseId
    if (!kbId) {
      throw new Error("No knowledge base ID configured for IMA source")
    }

    const resp = await this.imaFetch<{
      info_list: IMASearchItem[]
      is_end: boolean
      next_cursor: string
    }>(imaConfig, "/openapi/wiki/v1/search_knowledge", {
      query,
      cursor: "",
      knowledge_base_id: kbId,
    })

    const code = this.responseCode(resp)
    if (code !== 0) {
      throw new Error(`IMA search failed: ${this.responseMsg(resp) || code}`)
    }

    const items = resp.data?.info_list ?? []
    const kbName = imaConfig.knowledgeBaseName || kbId
    const limit = options?.limit ?? 5

    return items.slice(0, limit).map((item, index) => ({
      content: item.highlight_content || item.title,
      score: 1 - index * 0.05, // IMA returns sorted by relevance, approximate score
      title: item.title,
      sourceId: 0, // filled by caller
      sourceLabel: `IMA: ${kbName}`,
      metadata: {
        mediaId: item.media_id,
        folderId: item.parent_folder_id,
      },
    }))
  }
}
