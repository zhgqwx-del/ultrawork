#!/usr/bin/env bun
/**
 * IMA MCP Server — exposes IMA knowledge base & notes as MCP tools
 *
 * Usage:
 *   bun run src/index.ts
 *
 * Environment variables:
 *   IMA_OPENAPI_CLIENTID — IMA Client ID
 *   IMA_OPENAPI_APIKEY   — IMA API Key
 *
 * Or pass via --clientId and --apiKey CLI args.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { IMAClient } from "./ima-client.js"

// --- Resolve credentials ---

function resolveCredentials(): { clientId: string; apiKey: string } {
  // CLI args take priority: --clientId xxx --apiKey yyy
  const args = process.argv.slice(2)
  let clientId = ""
  let apiKey = ""

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--clientId" && args[i + 1]) clientId = args[++i]
    if (args[i] === "--apiKey" && args[i + 1]) apiKey = args[++i]
  }

  // Fallback to env
  clientId = clientId || process.env.IMA_OPENAPI_CLIENTID || ""
  apiKey = apiKey || process.env.IMA_OPENAPI_APIKEY || ""

  if (!clientId || !apiKey) {
    console.error(
      "Missing IMA credentials. Set IMA_OPENAPI_CLIENTID & IMA_OPENAPI_APIKEY env vars, or pass --clientId and --apiKey."
    )
    process.exit(1)
  }

  return { clientId, apiKey }
}

// --- Main ---

const credentials = resolveCredentials()
const ima = new IMAClient(credentials)

const server = new McpServer({
  name: "ima-knowledge",
  version: "0.1.0",
})

// Error wrapper for tool handlers
function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const }
}

// Tool 1: List knowledge bases
server.tool(
  "list_knowledge_bases",
  "List all knowledge bases the user has access to in IMA",
  {},
  async () => {
    try {
      const kbs = await ima.listKnowledgeBases()
      const text = kbs.length === 0
        ? "No knowledge bases found."
        : kbs.map((kb) => `- ${kb.name} (id: ${kb.id})`).join("\n")

      return {
        content: [{ type: "text", text: `Found ${kbs.length} knowledge base(s):\n${text}` }],
      }
    } catch (err) {
      return errorResult(err)
    }
  }
)

// Tool 2: Search knowledge base content
server.tool(
  "search_knowledge",
  "Search for content within an IMA knowledge base. Returns matching documents with highlighted snippets.",
  {
    knowledge_base_id: z.string().describe("The knowledge base ID to search in"),
    query: z.string().describe("Search query keywords"),
  },
  async ({ knowledge_base_id, query }) => {
    try {
      const { results, isEnd } = await ima.searchKnowledge(knowledge_base_id, query)

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${query}" in knowledge base ${knowledge_base_id}.` }],
        }
      }

      const lines = results.map((r) => {
        const highlight = r.highlight_content ? `\n  Snippet: ${r.highlight_content}` : ""
        return `- ${r.title} (media_id: ${r.media_id})${highlight}`
      })

      const more = isEnd ? "" : "\n\n(More results available — refine your query for better results)"

      return {
        content: [{
          type: "text",
          text: `Found ${results.length} result(s) for "${query}":\n${lines.join("\n")}${more}`,
        }],
      }
    } catch (err) {
      return errorResult(err)
    }
  }
)

// Tool 3: Search notes
server.tool(
  "search_notes",
  "Search user's IMA notes by title or content. Returns matching notes with highlights.",
  {
    query: z.string().describe("Search query keywords"),
    search_type: z
      .enum(["title", "content"])
      .default("title")
      .describe("Search by title or content"),
  },
  async ({ query, search_type }) => {
    try {
      const searchType = search_type === "content" ? 1 : 0
      const { docs, totalHits } = await ima.searchNotes(query, { searchType })

      if (docs.length === 0) {
        return {
          content: [{ type: "text", text: `No notes found for "${query}".` }],
        }
      }

      const lines = docs.map((d) => {
        const info = d.doc.basic_info
        const highlight = d.highlight_info?.doc_title ?? ""
        return `- ${info.title} (id: ${info.docid}, folder: ${info.folder_name || "未分类"})${highlight ? `\n  Match: ${highlight}` : ""}`
      })

      return {
        content: [{
          type: "text",
          text: `Found ${totalHits} note(s) for "${query}":\n${lines.join("\n")}`,
        }],
      }
    } catch (err) {
      return errorResult(err)
    }
  }
)

// Tool 4: Read note content
server.tool(
  "read_note",
  "Read the full text content of an IMA note by its document ID.",
  {
    doc_id: z.string().describe("The note document ID (docid from search results)"),
  },
  async ({ doc_id }) => {
    try {
      const content = await ima.getNoteContent(doc_id)
      return {
        content: [{ type: "text", text: content || "(Empty note)" }],
      }
    } catch (err) {
      return errorResult(err)
    }
  }
)

// Start server
const transport = new StdioServerTransport()
await server.connect(transport)
