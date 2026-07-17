// ADR-060 guard: the "Add Agent" preset templates must survive the round-trip
// applyTemplate (object env/args → textarea strings) → fromForm (strings → the
// ACPAgentConfig persisted to agents.json and handed to ACPConnection). Codex is
// the first template with a TWO-line pre-filled env ({NO_BROWSER, INITIAL_AGENT_MODE}),
// so a dropped/garbled line would ship a codex agent that pops a browser login or
// runs in the wrong sandbox mode — invisible to typecheck. The 5 real-agent spikes
// validated the runtime with a hand-built config; this locks the UI serialization
// seam the spikes bypassed.

import { describe, it, expect } from "vitest"
import { AGENT_TEMPLATES } from "@/components/settings/agent-templates"
import { fromForm, type FormState } from "@/components/settings/agents-section"

// Mirror applyTemplate (agents-section.tsx): env object → "K=V\n…", args → space-joined.
function formFromTemplate(t: (typeof AGENT_TEMPLATES)[number]): FormState {
  return {
    id: t.id,
    label: t.label,
    description: t.description,
    command: t.command,
    args: t.args.join(" "),
    env: Object.entries(t.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    knowledgeMcp: false,
    orchestratorMcp: false,
    thoughtLevel: "default",
  }
}

describe("agent templates → applyTemplate → fromForm round-trip", () => {
  for (const template of AGENT_TEMPLATES) {
    it(`preserves command/args/env for "${template.key}"`, () => {
      const config = fromForm(formFromTemplate(template))
      expect(config.id).toBe(template.id)
      expect(config.label).toBe(template.label)
      expect(config.command).toBe(template.command)
      expect(config.args).toEqual(template.args)
      // env absent → fromForm yields {} (not undefined); normalize for compare.
      expect(config.env ?? {}).toEqual(template.env ?? {})
    })
  }

  it("codex ships both NO_BROWSER and INITIAL_AGENT_MODE=agent intact", () => {
    const codex = AGENT_TEMPLATES.find((t) => t.key === "codex")
    expect(codex).toBeDefined()
    const config = fromForm(formFromTemplate(codex!))
    // Two-line env must not lose either entry (the seam codex first exercises).
    expect(config.env).toEqual({ NO_BROWSER: "1", INITIAL_AGENT_MODE: "agent" })
    expect(config.command).toBe("bunx")
    expect(config.args).toEqual(["@agentclientprotocol/codex-acp"])
  })
})
