import { describe, it, expect } from "vitest"
import {
  groupBySource,
  isHiddenBuiltinCommand,
  rankEntries,
  toMenuEntries,
  commandsAvailableFor,
  GROUP_ORDER,
  RANK_NAME_PREFIX,
  RANK_NAME_SUBSTRING,
  RANK_DESCRIPTION,
  type CommandMenuEntry,
} from "@/lib/command-menu"
import type { Command } from "@agent/api-client"

const cmd = (name: string, description: string, source: string): Command => ({
  name,
  description,
  source,
  template: "",
  hints: [],
})

/** Abridged from the real SKILL.md frontmatter — these are written for the
 *  model's routing decision, which is why they are this long. */
const REAL: CommandMenuEntry[] = [
  { name: "deckcraft", source: "skill", description: "HTML-first presentation generator — the default skill for making slide decks. Use whenever the user wants 做PPT or create a presentation / slides / deck." },
  { name: "wecom-assistant", source: "skill", description: "Use when the user wants to operate WeCom (企业微信) — docs, smart sheets, online sheets, smart pages, messages, contacts, todos, meetings, schedules." },
  { name: "markdown-exporter", source: "skill", description: "Convert Markdown text to DOCX, PPTX, XLSX, PDF, HTML, IPYNB, MD, CSV, JSON files." },
  { name: "doc-edit", source: "skill", description: "Use when the user wants to READ or MODIFY existing Microsoft Office files (.docx Word, .xlsx Excel)." },
  { name: "pdf", source: "skill", description: "Use when tasks involve reading, creating, or reviewing PDF files where rendering matters." },
]

describe("isHiddenBuiltinCommand", () => {
  it("hides the developer-oriented builtins", () => {
    expect(isHiddenBuiltinCommand("init", "command")).toBe(true)
    expect(isHiddenBuiltinCommand("review", "command")).toBe(true)
    // Absent source means a plain config command
    expect(isHiddenBuiltinCommand("init", undefined)).toBe(true)
  })

  it("does not hide a user skill that happens to share the name", () => {
    expect(isHiddenBuiltinCommand("init", "skill")).toBe(false)
    expect(isHiddenBuiltinCommand("deckcraft", "skill")).toBe(false)
  })
})

describe("toMenuEntries", () => {
  it("drops hidden builtins and dedups by name, keeping first", () => {
    const entries = toMenuEntries([
      cmd("init", "guided AGENTS.md setup", "command"),
      cmd("review", "review changes", "command"),
      cmd("deckcraft", "decks", "skill"),
      cmd("deckcraft", "a duplicate", "skill"),
    ])
    expect(entries.map((e) => e.name)).toEqual(["deckcraft"])
    expect(entries[0].description).toBe("decks")
  })

  it("defaults an absent source to command", () => {
    const entries = toMenuEntries([{ name: "x", description: "d", template: "", hints: [] } as unknown as Command])
    expect(entries[0].source).toBe("command")
  })

  it("normalises an unrecognised source instead of letting it reach the UI", () => {
    // The group label is looked up as `command.group.<source>`, so an unknown
    // value would render the raw i18n key on screen.
    const entries = toMenuEntries([cmd("x", "d", "plugin")])
    expect(entries[0].source).toBe("command")
    expect(GROUP_ORDER).toContain(entries[0].source)
  })
})

// Q: does the `/` menu behave for single-agent AND team? The predicate both
// pages feed ChatInput lives here so the matrix is machine-checked rather than
// argued from reading the JSX.
describe("commandsAvailableFor", () => {
  const OPENCODE_DEFAULT = "opencode:default"
  const ACP_AGENT = "acp:claude-code"

  it("single agent + opencode → shown (the commands really do apply)", () => {
    expect(commandsAvailableFor(OPENCODE_DEFAULT)).toBe(true)
  })

  it("single agent + ACP → hidden (they never reach that backend)", () => {
    expect(commandsAvailableFor(ACP_AGENT)).toBe(false)
  })

  it("team + opencode leader → shown", () => {
    // Pages pass `teamEntry.leaderAgentId` — the backend that receives the message.
    expect(commandsAvailableFor(OPENCODE_DEFAULT)).toBe(true)
  })

  it("team + ACP leader → hidden", () => {
    expect(commandsAvailableFor(ACP_AGENT)).toBe(false)
  })

  it("no binding yet (undefined) falls back to the opencode default → shown", () => {
    expect(commandsAvailableFor(undefined)).toBe(true)
  })
})

describe("groupBySource", () => {
  it("orders command → mcp → skill and skips empty groups", () => {
    const groups = groupBySource([
      { name: "s", description: "", source: "skill" },
      { name: "c", description: "", source: "command" },
      { name: "s2", description: "", source: "skill" },
    ])
    expect(groups.map((g) => g.key)).toEqual(["command", "skill"]) // no empty "mcp"
    expect(groups[1].items.map((i) => i.name)).toEqual(["s", "s2"])
  })
})

describe("rankEntries", () => {
  it("empty query keeps the incoming order untouched", () => {
    const { entries, descriptionMatchStart } = rankEntries(REAL, "")
    expect(entries.map((e) => e.name)).toEqual(REAL.map((e) => e.name))
    expect(descriptionMatchStart).toBe(-1)
  })

  it("puts every name hit ahead of every description hit", () => {
    const { entries } = rankEntries(REAL, "doc")
    // name hit
    expect(entries[0].name).toBe("doc-edit")
    expect(entries[0].rank).toBe(RANK_NAME_PREFIX)
    // the rest are description-only hits, and they come after
    expect(entries.slice(1).every((e) => e.rank === RANK_DESCRIPTION)).toBe(true)
  })

  it("ranks a prefix above a mid-name substring", () => {
    const { entries } = rankEntries(
      [
        { name: "markdown-exporter", description: "", source: "skill" },
        { name: "doc-edit", description: "", source: "skill" },
      ],
      "do"
    )
    expect(entries[0].name).toBe("doc-edit")
    expect(entries[0].rank).toBe(RANK_NAME_PREFIX)
    expect(entries[1].rank).toBe(RANK_NAME_SUBSTRING)
  })

  it("entries[0] is the best match — the contract Enter depends on", () => {
    // "de" is a perfect prefix for deckcraft but only appears mid-description
    // for the others; a group-first ordering would have buried it.
    const { entries } = rankEntries(REAL, "de")
    expect(entries[0].name).toBe("deckcraft")
  })

  it("a single letter does not match descriptions", () => {
    // Measured on the real built-ins: one-letter description matching returned
    // 9 of 9 for d/p/s/w/m/f — the filter stopped narrowing anything.
    const single = rankEntries(REAL, "d")
    expect(single.entries.every((e) => e.rank !== RANK_DESCRIPTION)).toBe(true)
    // prefix hits first, then the two name-substring hits ("markdown", "pdf")
    expect(single.entries.map((e) => e.name)).toEqual(["deckcraft", "doc-edit", "markdown-exporter", "pdf"])
    // 4 of 5 rather than 5 of 5 — and every survivor earned it on the name.
    expect(single.entries).toHaveLength(4)

    // Two letters re-enables it, which is what keeps /md → markdown-exporter alive.
    const double = rankEntries(REAL, "md")
    expect(double.entries.some((e) => e.rank === RANK_DESCRIPTION)).toBe(true)
  })

  it("keeps description-only hits that users actually want", () => {
    // /ppt has no name hit at all; dropping description matching would make the
    // menu vanish instead of offering deckcraft.
    const { entries } = rankEntries(REAL, "ppt")
    expect(entries.map((e) => e.name)).toContain("deckcraft")
  })

  it("reports where the description-match divider goes", () => {
    const { entries, descriptionMatchStart } = rankEntries(REAL, "doc")
    expect(descriptionMatchStart).toBe(1)
    expect(entries[descriptionMatchStart].rank).toBe(RANK_DESCRIPTION)
    expect(entries[descriptionMatchStart - 1].rank).not.toBe(RANK_DESCRIPTION)
  })

  it("matching is case-insensitive and ignores surrounding space", () => {
    const { entries } = rankEntries(REAL, "  DECK ")
    expect(entries[0].name).toBe("deckcraft")
  })

  it("returns an empty list when nothing matches", () => {
    const { entries, descriptionMatchStart } = rankEntries(REAL, "zzzzz")
    expect(entries).toEqual([])
    expect(descriptionMatchStart).toBe(-1)
  })
})
