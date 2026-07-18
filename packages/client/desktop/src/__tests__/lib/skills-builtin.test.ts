import { describe, it, expect } from "vitest"
import { isBuiltinLocation } from "@/lib/use-skills"
import { BUILTIN_DEP_MAP, missingDeps, type DepMap } from "@/lib/use-skill-deps"

describe("isBuiltinLocation", () => {
  it("classifies skills under skills/builtin as built-in", () => {
    expect(isBuiltinLocation("/Users/me/.config/ultrawork/skills/builtin/pdf/SKILL.md")).toBe(true)
    expect(isBuiltinLocation("/Users/me/.config/ultrawork/skills/builtin/doc-edit/SKILL.md")).toBe(true)
  })

  it("treats user-installed / project skills as not built-in", () => {
    // A sibling user-installed skill (skill-installer drops here) is NOT built-in.
    expect(isBuiltinLocation("/Users/me/.config/ultrawork/skills/my-skill/SKILL.md")).toBe(false)
    expect(isBuiltinLocation("/Users/me/project/.claude/skills/foo/SKILL.md")).toBe(false)
    expect(isBuiltinLocation(undefined)).toBe(false)
    expect(isBuiltinLocation("")).toBe(false)
  })

  it("recognizes Windows backslash locations (opencode reports native separators)", () => {
    expect(isBuiltinLocation("C:\\Users\\me\\AppData\\Roaming\\ultrawork\\skills\\builtin\\pdf\\SKILL.md")).toBe(true)
    expect(isBuiltinLocation("C:\\Users\\me\\ultrawork\\skills\\my-skill\\SKILL.md")).toBe(false)
  })
})

describe("BUILTIN_DEP_MAP + missingDeps", () => {
  const present = (...names: string[]): DepMap =>
    Object.fromEntries(names.map((n) => [n, { name: n, available: true }]))

  it("covers all nine built-in skills", () => {
    // ppt-master was removed from the bundle in P3 (ADR-061 / discussions/043 §18.5);
    // it lives on only as a curated INSTALLABLE_SKILLS entry, not a builtin dep-map key.
    expect(Object.keys(BUILTIN_DEP_MAP).sort()).toEqual(
      ["deckcraft", "dingtalk-assistant", "doc-edit", "feishu-assistant", "markdown-exporter", "pdf", "skill-creator", "skill-installer", "wecom-assistant"].sort(),
    )
  })

  it("deckcraft requires python 3.10+, python-pptx and a Chromium export browser", () => {
    expect(missingDeps("deckcraft", present("python3.10+", "python-pptx", "chrome-or-edge"))).toEqual([])
    expect(missingDeps("deckcraft", present("python3.10+", "python-pptx"))).toEqual(["chrome-or-edge"])
    // plain python3 is NOT enough — the copied converters need 3.10+ unions
    expect(missingDeps("deckcraft", present("python3", "python-pptx", "chrome-or-edge"))).toEqual(["python3.10+"])
  })

  it("feishu-assistant requires only the lark-cli binary (auth state lives in the connector card)", () => {
    expect(missingDeps("feishu-assistant", present("lark-cli"))).toEqual([])
    expect(missingDeps("feishu-assistant", present("python3"))).toEqual(["lark-cli"])
  })

  it("dingtalk-assistant requires only the dws binary (same connector-managed model)", () => {
    expect(missingDeps("dingtalk-assistant", present("dws"))).toEqual([])
    expect(missingDeps("dingtalk-assistant", present("lark-cli"))).toEqual(["dws"])
  })

  it("wecom-assistant requires only the wecom-cli binary (same connector-managed model)", () => {
    expect(missingDeps("wecom-assistant", present("wecom-cli"))).toEqual([])
    expect(missingDeps("wecom-assistant", present("dws"))).toEqual(["wecom-cli"])
  })

  it("reports ready when every required tool is present", () => {
    expect(missingDeps("pdf", present("python3", "pdftoppm"))).toEqual([])
    expect(missingDeps("doc-edit", present("python3"))).toEqual([])
  })

  it("lists exactly the missing tools", () => {
    expect(missingDeps("pdf", present("python3"))).toEqual(["pdftoppm"])
    expect(missingDeps("skill-installer", present())).toEqual(["python3", "git"])
    expect(missingDeps("markdown-exporter", present("pandoc"))).toEqual(["markdown-exporter"])
  })

  it("returns no requirements for unknown skill names (incl. the removed builtin ppt-master)", () => {
    expect(missingDeps("totally-unknown", present())).toEqual([])
    // ppt-master is no longer in BUILTIN_DEP_MAP — the dep-badge machinery treats it
    // as unknown (its curated-catalog install carries its own deps at install time).
    expect(missingDeps("ppt-master", present())).toEqual([])
  })
})
