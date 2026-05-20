import type { KnowledgeAdapter, TestConnectionResult } from "./types"
import type { AdapterSearchResult, LocalFolderConfig } from "../types"
import type { SearchOptions } from "../retriever"
import type { SearchResult } from "../types"

export class LocalFolderAdapter implements KnowledgeAdapter {
  readonly type = "local_folder"

  private searchFn: (options: SearchOptions) => SearchResult[]

  constructor(searchFn: (options: SearchOptions) => SearchResult[]) {
    this.searchFn = searchFn
  }

  async testConnection(config: unknown): Promise<TestConnectionResult> {
    const { folderPath } = config as LocalFolderConfig
    try {
      const fs = await import("fs")
      fs.accessSync(folderPath, fs.constants.R_OK)
      return { ok: true, message: `Directory accessible: ${folderPath}` }
    } catch {
      return { ok: false, message: `Cannot access directory: ${folderPath}` }
    }
  }

  async search(
    query: string,
    config: unknown,
    options?: { limit?: number },
  ): Promise<AdapterSearchResult[]> {
    const { folderPath } = config as LocalFolderConfig
    const results = this.searchFn({
      query,
      limit: (options?.limit ?? 5) * 2, // fetch more to filter
    })

    const folderName = folderPath.split("/").pop() || folderPath

    return results
      .filter((r) => r.folderPath === folderPath)
      .slice(0, options?.limit ?? 5)
      .map((r) => ({
        content: r.parentContent ?? r.content,
        score: r.score,
        title: r.filePath,
        sourceId: 0, // filled by caller
        sourceLabel: `Local: ${folderName}`,
        metadata: {
          filePath: r.filePath,
          folderPath: r.folderPath,
          startLine: r.startLine,
          endLine: r.endLine,
          parentStartLine: r.parentStartLine,
          parentEndLine: r.parentEndLine,
        },
      }))
  }
}
