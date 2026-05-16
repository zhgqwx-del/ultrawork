import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { SearchOptions } from "./retriever"
import type { SearchResult } from "./types"
import type { Indexer } from "./indexer"

const KB_BASE = "http://localhost:4098"

interface McpBridgeDeps {
  search: (options: SearchOptions) => SearchResult[]
  indexer: Indexer
}

/**
 * Start MCP server in stdio mode.
 * Can operate in two modes:
 * - "direct": search/indexer injected directly (same process)
 * - "proxy": fetch from HTTP API (separate process, used by compiled binary)
 */
export async function startMcpBridge(deps?: McpBridgeDeps): Promise<void> {
  console.error("[mcp-bridge] Starting MCP stdio bridge...")

  const server = new McpServer({
    name: "knowledge-base",
    version: "0.1.0",
  })

  server.tool(
    "knowledge_search",
    "Search the user's local knowledge base for relevant documents and code. Use this tool when the user asks questions that might be answered by their indexed files and folders. The search uses hybrid retrieval (keyword + semantic) for best results.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results to return (default 5)"),
    },
    async ({ query, limit }) => {
      console.error(`[mcp-bridge] knowledge_search called: query="${query}", limit=${limit}`)
      try {
        let results: SearchResult[]
        let sourceSummary = ""

        if (deps) {
          // Direct mode
          results = deps.search({ query, limit: limit ?? 5 })
          const sources = deps.indexer.listFolders()
          if (sources.length > 0) {
            sourceSummary = "\n\nCurrently indexed knowledge sources:\n" +
              sources.filter((s) => s.status === "complete")
                .map((s) => `- ${s.folderPath} (${s.indexedFiles} files)`)
                .join("\n")
          }
        } else {
          // Proxy mode — fetch from HTTP API
          const resp = await fetch(`${KB_BASE}/kb/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, limit: limit ?? 5 }),
          })
          if (!resp.ok) throw new Error(`KB API ${resp.status}`)
          const data = await resp.json() as { results: SearchResult[] }
          results = data.results

          try {
            const srcResp = await fetch(`${KB_BASE}/kb/sources`)
            if (srcResp.ok) {
              const srcData = await srcResp.json() as { sources: { folderPath: string; indexedFiles: number; status: string }[] }
              if (srcData.sources.length > 0) {
                sourceSummary = "\n\nCurrently indexed knowledge sources:\n" +
                  srcData.sources.filter((s) => s.status === "complete")
                    .map((s) => `- ${s.folderPath} (${s.indexedFiles} files)`)
                    .join("\n")
              }
            }
          } catch { /* ignore */ }
        }

        if (!results || results.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No relevant results found in the knowledge base.${sourceSummary}` }],
          }
        }

        const text = results
          .map((r, i) => `### Result ${i + 1} — ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n\n${r.content}`)
          .join("\n\n---\n\n") + sourceSummary

        console.error(`[mcp-bridge] Returning ${results.length} results`)
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
    "List all indexed knowledge sources (folders) and their status.",
    {},
    async () => {
      console.error("[mcp-bridge] knowledge_list_sources called")
      try {
        let sources: { folderPath: string; totalFiles: number; indexedFiles: number; status: string }[]

        if (deps) {
          sources = deps.indexer.listFolders()
        } else {
          const resp = await fetch(`${KB_BASE}/kb/sources`)
          if (!resp.ok) throw new Error(`KB API ${resp.status}`)
          const data = await resp.json() as { sources: typeof sources }
          sources = data.sources
        }

        if (!sources || sources.length === 0) {
          return { content: [{ type: "text" as const, text: "No knowledge sources are currently indexed." }] }
        }

        const text = sources
          .map((s) => `- **${s.folderPath}**: ${s.indexedFiles}/${s.totalFiles} files indexed (${s.status})`)
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
