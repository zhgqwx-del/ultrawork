import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { basename } from "node:path"
import type { SearchOptions } from "./retriever"
import type { SearchResult, AdapterSearchResult } from "./types"
import type { Indexer } from "./indexer"
import type { KnowledgeStore } from "./store"
import { getAdapter } from "./adapters/registry"

interface McpBridgeDeps {
  search: (options: SearchOptions) => SearchResult[]
  indexer: Indexer
  store: KnowledgeStore
}

/**
 * Start the MCP server in stdio mode, querying the store in-process.
 *
 * There used to be a second "proxy" mode that reached the sidecar over HTTP on a
 * hardcoded port. It was unreachable — `mcp-stdio` has always constructed the
 * deps itself — and a baked-in port is exactly what the runtime port registry
 * exists to eliminate. Removed rather than parameterised (discussions/029 §10.1).
 */
export async function startMcpBridge(deps: McpBridgeDeps): Promise<void> {
  console.error("[mcp-bridge] Starting MCP stdio bridge...")

  const server = new McpServer({
    name: "knowledge-base",
    version: "0.4.0",
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

        // Search across all enabled sources
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
            const folderName = folderPath ? basename(folderPath) : folderPath
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
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to list knowledge sources: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    "knowledge_save_note",
    "Save content as a note to the user's IMA knowledge platform. Use this when the user asks to save, record, or write something to their notes (e.g. '帮我记一下', '保存为笔记', 'save this to my notes'). Can create a new note or append to an existing one. Only works with IMA Notes sources that are connected.",
    {
      content: z.string().describe("Markdown content to save"),
      title: z.string().optional().describe("Title for a new note (ignored when appending). If omitted, the first line of content is used."),
      note_id: z.string().optional().describe("If provided, append to this existing note instead of creating a new one. Get note_id from a previous knowledge_search result's metadata.noteId field."),
      source_id: z.number().optional().describe("ID of the IMA Notes source to use. Omit to auto-select the first connected IMA Notes source."),
    },
    async ({ content, title, note_id, source_id }) => {
      console.error(`[mcp-bridge] knowledge_save_note called: note_id=${note_id ?? "new"}, source_id=${source_id ?? "auto"}, ${content.length} chars`)
      try {
        // Find the IMA Notes source and call its adapter
        const ksSources = deps.store.listKnowledgeSources()
        const notesSource = ksSources.find((ks) => {
          if (ks.type !== "ima" || ks.enabled !== 1) return false
          if (source_id) return ks.id === source_id
          const config = JSON.parse(ks.config_json)
          return config.module === "notes"
        })

        if (!notesSource) {
          return {
            content: [{ type: "text" as const, text: "No connected IMA Notes source found. Please add one in Settings → Knowledge Base first." }],
            isError: true,
          }
        }

        const config = JSON.parse(notesSource.config_json)
        const adapter = getAdapter(notesSource.type)

        let result
        if (note_id) {
          if (!adapter?.appendNote) {
            return {
              content: [{ type: "text" as const, text: `Adapter ${notesSource.type} does not support appending to notes.` }],
              isError: true,
            }
          }
          result = await adapter.appendNote(config, note_id, content)
        } else {
          if (!adapter?.createNote) {
            return {
              content: [{ type: "text" as const, text: `Adapter ${notesSource.type} does not support creating notes.` }],
              isError: true,
            }
          }
          result = await adapter.createNote(config, content, {
            title,
            folderId: config.notebookId,
          })
        }

        const action = note_id ? "Appended to" : "Created"
        console.error(`[mcp-bridge] ${action} note: ${result.noteId}`)
        return {
          content: [{ type: "text" as const, text: `${action} note successfully.\n\n- **note_id**: ${result.noteId}\n- **source**: ${notesSource.name}` }],
        }
      } catch (err) {
        console.error(`[mcp-bridge] knowledge_save_note error:`, err)
        return {
          content: [{ type: "text" as const, text: `Failed to save note: ${err instanceof Error ? err.message : String(err)}` }],
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
