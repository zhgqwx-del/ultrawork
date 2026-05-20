import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { SearchOptions } from "./retriever"
import type { SearchResult, AdapterSearchResult } from "./types"
import type { Indexer } from "./indexer"
import type { KnowledgeStore } from "./store"
import { getAdapter } from "./adapters/registry"

const KB_BASE = "http://localhost:4098"

interface McpBridgeDeps {
  search: (options: SearchOptions) => SearchResult[]
  indexer: Indexer
  store: KnowledgeStore
}

/**
 * Start MCP server in stdio mode.
 * Can operate in two modes:
 * - "direct": search/indexer/store injected directly (same process)
 * - "proxy": fetch from HTTP API (separate process, used by compiled binary)
 */
export async function startMcpBridge(deps?: McpBridgeDeps): Promise<void> {
  console.error("[mcp-bridge] Starting MCP stdio bridge...")

  const server = new McpServer({
    name: "knowledge-base",
    version: "0.3.0",
  })

  server.tool(
    "knowledge_search",
    "Search the user's knowledge base for relevant documents and code. Supports local folders (RAG) and remote knowledge platforms (e.g. Tencent IMA). Use this tool when the user asks questions that might be answered by their indexed files, documents, or connected knowledge bases. Results include matched content with source attribution.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results to return (default 5)"),
      source_ids: z.array(z.number()).optional().describe("Optional: limit search to specific source IDs as shown by knowledge_list_sources. Omit to search ALL enabled sources (recommended)."),
    },
    async ({ query, limit, source_ids }) => {
      console.error(`[mcp-bridge] knowledge_search called: query="${query}", limit=${limit}, source_ids=${source_ids}`)
      try {
        const maxResults = limit ?? 5
        let allResults: AdapterSearchResult[] = []
        let sourceSummary = ""

        if (deps) {
          // Direct mode — search across all enabled sources
          const ksSources = deps.store.listKnowledgeSources()
          const enabledSources = ksSources.filter((ks) => {
            if (ks.enabled !== 1) return false
            if (source_ids && source_ids.length > 0) return source_ids.includes(ks.id)
            return true
          })

          // Search each source via its adapter
          const searchErrors: string[] = []
          const searchPromises = enabledSources.map(async (ks) => {
            const config = JSON.parse(ks.config_json)

            if (ks.type === "local_folder") {
              // Use existing retriever for local folders
              const results = deps.search({ query, limit: maxResults })
              const folderPath = config.folderPath as string
              const folderName = folderPath?.split("/").pop() || folderPath
              return results
                .filter((r) => r.folderPath === folderPath)
                .slice(0, maxResults)
                .map((r): AdapterSearchResult => ({
                  content: r.parentContent ?? r.content,
                  score: r.score,
                  title: r.filePath,
                  sourceId: ks.id,
                  sourceLabel: `Local: ${folderName}`,
                  metadata: {
                    filePath: r.filePath,
                    startLine: r.startLine,
                    endLine: r.endLine,
                    parentStartLine: r.parentStartLine,
                    parentEndLine: r.parentEndLine,
                  },
                }))
            }

            // Remote adapter
            const adapter = getAdapter(ks.type)
            if (!adapter) return []
            try {
              const results = await adapter.search(query, config, { limit: maxResults })
              return results.map((r) => ({ ...r, sourceId: ks.id }))
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              console.error(`[mcp-bridge] Adapter ${ks.type} search error:`, err)
              searchErrors.push(`${ks.name} (${ks.type}): ${msg}`)
              return []
            }
          })

          const resultArrays = await Promise.all(searchPromises)
          allResults = resultArrays.flat()

          // Source summary
          if (enabledSources.length > 0) {
            sourceSummary = "\n\nSearched knowledge sources:\n" +
              enabledSources.map((s) => {
                const config = JSON.parse(s.config_json)
                if (s.type === "local_folder") {
                  const folderSources = deps.indexer.listFolders()
                  const status = folderSources.find((f) => f.folderPath === config.folderPath)
                  return `- [Local] ${s.name} (${status?.indexedFiles ?? "?"} files)`
                }
                return `- [${s.type.toUpperCase()}] ${s.name} (${s.status})`
              }).join("\n")
            if (searchErrors.length > 0) {
              sourceSummary += "\n\nSearch errors:\n" +
                searchErrors.map((e) => `- ${e}`).join("\n")
            }
          }
        } else {
          // Proxy mode — fetch from HTTP API (includes both local + remote results)
          const resp = await fetch(`${KB_BASE}/kb/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, limit: maxResults }),
          })
          if (!resp.ok) throw new Error(`KB API ${resp.status}`)
          const data = await resp.json() as { results: SearchResult[]; remoteResults?: AdapterSearchResult[] }

          // Local results
          allResults = (data.results ?? []).map((r): AdapterSearchResult => ({
            content: r.parentContent ?? r.content,
            score: r.score,
            title: r.filePath,
            sourceId: 0,
            sourceLabel: `Local: ${r.folderPath?.split("/").pop()}`,
            metadata: { filePath: r.filePath, startLine: r.startLine, endLine: r.endLine },
          }))

          // Remote results (IMA etc.)
          if (data.remoteResults && data.remoteResults.length > 0) {
            allResults.push(...data.remoteResults)
          }

          try {
            const srcResp = await fetch(`${KB_BASE}/kb/sources`)
            if (srcResp.ok) {
              const srcData = await srcResp.json() as { sources: { name: string; type: string; status: string }[] }
              if (srcData.sources.length > 0) {
                sourceSummary = "\n\nSearched knowledge sources:\n" +
                  srcData.sources.map((s) => `- [${s.type}] ${s.name} (${s.status})`).join("\n")
              }
            }
          } catch { /* ignore */ }
        }

        // Sort by score and take top-K
        allResults.sort((a, b) => b.score - a.score)
        const topResults = allResults.slice(0, maxResults)

        if (topResults.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No relevant results found in the knowledge base.${sourceSummary}` }],
          }
        }

        const text = topResults
          .map((r, i) => formatAdapterResult(r, i + 1))
          .join("\n\n---\n\n") + sourceSummary

        console.error(`[mcp-bridge] Returning ${topResults.length} results`)
        return { content: [{ type: "text" as const, text }] }
      } catch (err) {
        console.error(`[mcp-bridge] Search error:`, err)
        return {
          content: [{ type: "text" as const, text: `Knowledge base search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    "knowledge_list_sources",
    "List all configured knowledge sources and their status. Shows both local folder indexes and connected remote platforms.",
    {},
    async () => {
      console.error("[mcp-bridge] knowledge_list_sources called")
      try {
        if (deps) {
          const ksSources = deps.store.listKnowledgeSources()
          if (ksSources.length === 0) {
            return { content: [{ type: "text" as const, text: "No knowledge sources are currently configured." }] }
          }

          const lines = ksSources.map((ks) => {
            const config = JSON.parse(ks.config_json)
            const enabled = ks.enabled === 1 ? "✓" : "✗"
            if (ks.type === "local_folder") {
              const folderStatus = deps.indexer.listFolders().find((f) => f.folderPath === config.folderPath)
              return `- ${enabled} [id=${ks.id}] **${ks.name}** [Local Folder] ${config.folderPath} — ${folderStatus?.indexedFiles ?? "?"} files (${ks.status})`
            }
            return `- ${enabled} [id=${ks.id}] **${ks.name}** [${ks.type.toUpperCase()}] — ${ks.status}${ks.error_message ? ` (${ks.error_message})` : ""}`
          })

          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        // Proxy mode
        const resp = await fetch(`${KB_BASE}/kb/sources`)
        if (!resp.ok) throw new Error(`KB API ${resp.status}`)
        const data = await resp.json() as { sources: { name: string; type: string; status: string; enabled: boolean }[] }

        if (!data.sources || data.sources.length === 0) {
          return { content: [{ type: "text" as const, text: "No knowledge sources are currently configured." }] }
        }

        const text = data.sources
          .map((s: any) => `- ${s.enabled ? "✓" : "✗"} [id=${s.id}] **${s.name}** [${s.type}] (${s.status})`)
          .join("\n")

        return { content: [{ type: "text" as const, text }] }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to list knowledge sources: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )

  const transport = new StdioServerTransport()
  console.error("[mcp-bridge] Connecting stdio transport...")
  await server.connect(transport)
  console.error("[mcp-bridge] Connected, waiting for messages")
}

function formatAdapterResult(r: AdapterSearchResult, index: number): string {
  const meta = r.metadata ?? {}
  const location = meta.filePath
    ? `${meta.filePath}:${meta.startLine ?? "?"}-${meta.endLine ?? "?"}`
    : r.title ?? "unknown"
  const header = `### Result ${index} — ${location} (score: ${r.score.toFixed(3)}) [${r.sourceLabel}]`

  return `${header}\n\n${r.content}`
}
