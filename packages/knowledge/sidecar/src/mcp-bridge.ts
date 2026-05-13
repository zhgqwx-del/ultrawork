import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const KB_BASE = "http://localhost:4098"

async function kbFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${KB_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`KB API ${resp.status}: ${body}`)
  }
  return resp.json()
}

interface SourceInfo {
  folderPath: string
  totalFiles: number
  indexedFiles: number
  status: string
}

/** Build a summary of available knowledge sources (called on each search) */
async function getSourcesSummary(): Promise<string> {
  try {
    const { sources } = await kbFetch<{ sources: SourceInfo[] }>("/kb/sources")
    if (!sources || sources.length === 0) return ""
    const completed = sources.filter((s) => s.status === "complete")
    if (completed.length === 0) return ""
    return (
      "\n\nCurrently indexed knowledge sources:\n" +
      completed.map((s) => `- ${s.folderPath} (${s.indexedFiles} files)`).join("\n")
    )
  } catch {
    return ""
  }
}

export async function startMcpBridge(): Promise<void> {
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
      try {
        const { results } = await kbFetch<{
          results: {
            chunkId: number
            content: string
            score: number
            filePath: string
            startLine: number
            endLine: number
          }[]
        }>("/kb/search", {
          method: "POST",
          body: JSON.stringify({ query, limit: limit ?? 5 }),
        })

        // Always include current sources summary so AI knows what's available
        const sourcesSummary = await getSourcesSummary()

        if (!results || results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No relevant results found in the knowledge base.${sourcesSummary}`,
              },
            ],
          }
        }

        const text =
          results
            .map(
              (r, i) =>
                `### Result ${i + 1} — ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n\n${r.content}`,
            )
            .join("\n\n---\n\n") + sourcesSummary

        return { content: [{ type: "text" as const, text }] }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Knowledge base search failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
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
      try {
        const { sources } = await kbFetch<{ sources: SourceInfo[] }>("/kb/sources")

        if (!sources || sources.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No knowledge sources are currently indexed.",
              },
            ],
          }
        }

        const text = sources
          .map(
            (s) =>
              `- **${s.folderPath}**: ${s.indexedFiles}/${s.totalFiles} files indexed (${s.status})`,
          )
          .join("\n")

        return { content: [{ type: "text" as const, text }] }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list knowledge sources: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
