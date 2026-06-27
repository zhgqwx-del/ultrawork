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

  it("covers all five built-in skills", () => {
    expect(Object.keys(BUILTIN_DEP_MAP).sort()).toEqual(
      ["doc-edit", "markdown-exporter", "pdf", "skill-creator", "skill-installer"].sort(),
    )
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

  it("returns no requirements for unknown skill names", () => {
    expect(missingDeps("totally-unknown", present())).toEqual([])
  })
})
