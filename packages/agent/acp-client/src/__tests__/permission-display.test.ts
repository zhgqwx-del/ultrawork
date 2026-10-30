import { describe, it, expect } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ACPConnection } from "../acp-connection"
import type { UwSSEEvent } from "../types"

const fixture = join(import.meta.dir, "../../scripts/mock-permission-acp-agent.ts")
describe("sparse Codex MCP permission (actual stdio RPC)", () => {
  for (const reply of ["once", "always", "reject"] as const) {
    it(`shows MCP context and preserves the exact ${reply} option mapping`, async () => {
      const events: UwSSEEvent[] = []
      let beforeReplyToolCompleted = false
      const connection = new ACPConnection({ id: "permission-fixture", label: "Permission fixture", command: process.execPath, args: ["run", "--bun", fixture] }, (_sessionId, event) => {
        events.push(event)
        if (event.type === "permission.asked") {
          beforeReplyToolCompleted = events.some((e) => e.type === "message.part.updated" && e.properties.part.type === "tool" && e.properties.part.state.status === "completed")
          setTimeout(() => connection.replyPermission(event.properties.id, reply), 15)
        }
      })
      try {
        await connection.connect()
        const session = await connection.newSession(tmpdir(), "public-permission-session")
        await connection.prompt(session, "Permission presentation only")
        const asked = events.find((event) => event.type === "permission.asked")
        expect(asked?.type).toBe("permission.asked")
        if (asked?.type === "permission.asked") {
          expect(asked.properties.sessionID).toBe("public-permission-session")
          expect(asked.properties.permission).toBe("mcp")
          expect(asked.properties.patterns[0]).toContain("mcp.orchestrator.delegate\n{")
          expect(asked.properties.metadata).toMatchObject({ toolCallId: "exec-permission-fixture", mcp: { server: "orchestrator", tool: "delegate" } })
        }
        const answer = events.flatMap((event) => event.type === "message.part.updated" && event.properties.part.type === "text" ? [event.properties.part.text] : []).at(-1)
        expect(JSON.parse(answer!)).toEqual({ selected: reply === "once" ? "one-exact-option" : reply === "always" ? "always-exact-option" : "reject-exact-option", allowed: reply !== "reject" })
        expect(beforeReplyToolCompleted).toBe(false)
        expect(events.filter((event) => event.type === "permission.asked")).toHaveLength(1)
        expect(events.filter((event) => event.type === "permission.replied")).toHaveLength(1)
      } finally { await connection.disconnect() }
    }, 15_000)
  }

  it("keeps a real command as bash despite an MCP-like title/envelope", async () => {
    const events: UwSSEEvent[] = []
    const connection = new ACPConnection({ id: "permission-shell-fixture", label: "Shell fixture", command: process.execPath, args: ["run", "--bun", fixture], env: { MOCK_PERMISSION_SCENARIO: "shell" } }, (_sessionId, event) => {
      events.push(event)
      if (event.type === "permission.asked") setTimeout(() => connection.replyPermission(event.properties.id, "reject"), 15)
    })
    try {
      await connection.connect()
      const session = await connection.newSession(tmpdir(), "public-shell-session")
      await connection.prompt(session, "Permission presentation only")
      const asked = events.find((event) => event.type === "permission.asked")
      if (asked?.type !== "permission.asked") throw new Error("Missing approval")
      expect(asked.properties.permission).toBe("bash")
      expect(asked.properties.patterns).toEqual(["echo fixture-only"])
      expect(asked.properties.metadata).toEqual({})
    } finally { await connection.disconnect() }
  }, 15_000)
})
