// thoughtLevel → session/set_config_option, against the mock ACP agent.
// The mock echoes a set effort into the next answer (" [effort=<level>]"),
// so application is observable end-to-end; agents without the option and
// unknown values must degrade to a silent skip (effort is a tuning knob,
// never a session blocker).

import { describe, it, expect } from "bun:test"
import { join } from "node:path"
import { ACPConnection } from "../acp-connection.js"
import type { ACPAgentConfig, UwSSEEvent } from "../types.js"

const MOCK_AGENT = join(import.meta.dir, "..", "..", "scripts", "mock-acp-agent.ts")

function mockConfig(overrides: Partial<ACPAgentConfig> = {}): ACPAgentConfig {
  return {
    id: "mock",
    label: "Mock Agent",
    command: process.execPath,
    args: ["run", MOCK_AGENT],
    ...overrides,
  }
}

/** All answer text the shaper emitted (part text + appended deltas). */
function collectText(events: UwSSEEvent[]): string {
  let text = ""
  for (const event of events) {
    if (event.type === "message.part.updated" && event.properties.part.type === "text") {
      text += event.properties.part.text
    }
    if (event.type === "message.part.delta") text += event.properties.delta
  }
  return text
}

async function runTurn(config: ACPAgentConfig, viaLoad = false): Promise<UwSSEEvent[]> {
  const events: UwSSEEvent[] = []
  const conn = new ACPConnection(config, (_sid, event) => {
    events.push(event)
    if (event.type === "permission.asked") {
      setTimeout(() => conn.replyPermission(event.properties.id, "once"), 10)
    }
  })
  try {
    await conn.connect()
    if (viaLoad) {
      await conn.loadSession("mock-session-1", "/tmp", "ses_pub")
    } else {
      await conn.newSession("/tmp", "ses_pub")
    }
    const stopReason = await conn.prompt("mock-session-1", "list the files")
    expect(stopReason).toBe("end_turn")
  } finally {
    await conn.disconnect()
  }
  return events
}

describe("thoughtLevel via session/set_config_option", () => {
  it("applies the configured level after session/new", async () => {
    const events = await runTurn(mockConfig({ thoughtLevel: "high" }))
    expect(collectText(events)).toContain("[effort=high]")
  }, 20_000)

  it("re-applies after session/load (restored sessions keep the knob)", async () => {
    const events = await runTurn(mockConfig({ thoughtLevel: "medium" }), true)
    expect(collectText(events)).toContain("[effort=medium]")
  }, 20_000)

  it("leaves the agent default alone when unset or 'default'", async () => {
    const events = await runTurn(mockConfig({ thoughtLevel: "default" }))
    expect(collectText(events)).not.toContain("[effort=")
  }, 20_000)

  it("skips silently when the agent offers no config options", async () => {
    const events = await runTurn(
      mockConfig({ thoughtLevel: "high", env: { MOCK_ACP_NO_CONFIG_OPTIONS: "1" } }),
    )
    const text = collectText(events)
    expect(text).toContain("two files.")
    expect(text).not.toContain("[effort=")
  }, 20_000)

  it("skips an unknown value instead of failing the session", async () => {
    const events = await runTurn(mockConfig({ thoughtLevel: "ultra" }))
    const text = collectText(events)
    expect(text).toContain("two files.")
    expect(text).not.toContain("[effort=")
  }, 20_000)
})
