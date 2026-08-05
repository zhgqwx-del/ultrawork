import { describe, it, expect } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isBuiltinLocation } from "@/lib/use-skills"
import { BUILTIN_DEP_MAP, PIP_HINTS, missingDeps, type DepMap } from "@/lib/use-skill-deps"

describe("isBuiltinLocation", () => {
  it("classifies skills under skills/builtin as built-in", () => {
    expect(isBuiltinLocation("/Users/me/.config/ultrawork/skills/builtin/pdf/SKILL.md")).toBe(true)
    expect(isBuiltinLocation("/Users/me/.config/ultrawork/skills/builtin/pptx-edit/SKILL.md")).toBe(true)
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

  it("covers all eleven built-in skills", () => {
    // ppt-master was removed from the bundle in P3 (ADR-061 / discussions/043 §18.5);
    // it lives on only as a curated INSTALLABLE_SKILLS entry, not a builtin dep-map key.
    // `doc-edit` became `pptx-edit` in 059 S6 — same directory, four of its six
    // scripts dropped once `docx` and `xlsx` superseded them.
    expect(Object.keys(BUILTIN_DEP_MAP).sort()).toEqual(
      ["deckcraft", "dingtalk-assistant", "docx", "feishu-assistant", "markdown-exporter", "pdf", "pptx-edit", "skill-creator", "skill-installer", "wecom-assistant", "xlsx"].sort(),
    )
    // The old key must be gone, not merely shadowed: a stale `doc-edit` entry would
    // keep rendering a badge for a skill that is no longer in the bundle.
    expect(BUILTIN_DEP_MAP["doc-edit"]).toBeUndefined()
  })

  it("pptx-edit requires python-pptx — it stopped being optional when the docx/xlsx scripts left", () => {
    expect(missingDeps("pptx-edit", present("python3", "python-pptx"))).toEqual([])
    // Both remaining scripts import pptx unconditionally, so python3 alone is NOT
    // ready. As `doc-edit` the map declared only python3, which was defensible while
    // four of the six scripts ran on python-docx/openpyxl instead; with those gone,
    // a machine without python-pptx can run nothing in this skill.
    expect(missingDeps("pptx-edit", present("python3"))).toEqual(["python-pptx"])
    // python-pptx is optional for NOBODY here: deckcraft requires it too (image-type
    // pptx export), so it must not drift into OPTIONAL_DEPS as a bare name.
    expect(missingDeps("deckcraft", present("python3.10+", "pillow", "chrome-or-edge"))).toEqual(["python-pptx"])
  })

  it("xlsx requires openpyxl, lxml and LibreOffice — soffice is not optional", () => {
    expect(missingDeps("xlsx", present("python3", "openpyxl", "lxml", "soffice"))).toEqual([])
    // Recalculating formulas and rendering a preview both go through LibreOffice
    // (059 §7); without it the skill is genuinely not ready, so it must not be
    // silently tolerated the way OPTIONAL_DEPS tolerates a missing Node.
    expect(missingDeps("xlsx", present("python3", "openpyxl", "lxml"))).toEqual(["soffice"])
    expect(missingDeps("xlsx", present("python3", "openpyxl", "soffice"))).toEqual(["lxml"])
  })

  it("docx needs lxml and LibreOffice — and deliberately NOT python-docx", () => {
    expect(missingDeps("docx", present("python3", "lxml", "soffice"))).toEqual([])
    // The skill reads and writes WordprocessingML through lxml. Declaring
    // python-docx would put a red badge on a machine where the skill works fine,
    // and — worse — would suggest the skill is built the way every reference
    // implementation is built, which is exactly the claim 059 §六·补五 disproves.
    expect(BUILTIN_DEP_MAP.docx).not.toContain("python-docx")
    // Same standing as xlsx: a .docx cannot be previewed in-app, so the PDF route
    // through LibreOffice is not a nicety (059 §7).
    expect(missingDeps("docx", present("python3", "lxml"))).toEqual(["soffice"])
    expect(missingDeps("docx", present("python3", "soffice"))).toEqual(["lxml"])
  })

  it("deckcraft requires python 3.10+, python-pptx, Pillow and a Chromium export browser", () => {
    const core = ["python3.10+", "python-pptx", "pillow", "chrome-or-edge"]
    expect(missingDeps("deckcraft", present(...core))).toEqual([])
    expect(missingDeps("deckcraft", present("python3.10+", "python-pptx", "pillow"))).toEqual(["chrome-or-edge"])
    // export_deck.py imports PIL on the core path; it was absent from the dep map
    // entirely until 059 S3.5 went looking (§4·补 item 2).
    expect(missingDeps("deckcraft", present("python3.10+", "python-pptx", "chrome-or-edge"))).toEqual(["pillow"])
    // plain python3 is NOT enough — the copied converters need 3.10+ unions
    expect(missingDeps("deckcraft", present("python3", "python-pptx", "pillow", "chrome-or-edge"))).toEqual(["python3.10+"])
  })

  it("deckcraft's source readers are declared but do not gate readiness", () => {
    // Each one is imported only when that KIND of source document is fed in, so a
    // user who only ever builds decks from Markdown must not see "not ready"
    // because they have no nbconvert. Declared anyway so the badge can name the
    // format that is unavailable — before this the PDF reader was a hard,
    // completely unmentioned dependency (059 §4·补 item 2).
    const readers = ["pdfplumber", "pypdf", "pypdfium2", "openpyxl", "mammoth",
      "ebooklib", "nbconvert", "markdownify", "beautifulsoup4", "requests", "curl_cffi"]
    for (const r of readers) expect(BUILTIN_DEP_MAP.deckcraft).toContain(r)
    expect(missingDeps("deckcraft", present("python3.10+", "python-pptx", "pillow", "chrome-or-edge"))).toEqual([])
  })

  it("every declared dependency has install guidance — no bare names in the badge", () => {
    // The badge falls through to `DEP_HINTS[m] ?? m`, so a dependency nobody wrote
    // a hint for renders as its bare name ("缺少: pypdfium2, pypdf, pdfplumber,
    // reportlab") and the guide button hands those same bare names to the
    // assistant. That was the real state of every Python library on this list
    // until 059 S3.5 audited it, so this asserts the gap cannot come back.
    // Anything not pip-installable belongs in the platform-specific DEP_HINTS
    // branches in Settings.tsx and is listed here explicitly.
    const NON_PIP = new Set([
      "python3", "python3.10+", "node", "git", "pandoc", "soffice", "pdftoppm",
      "chrome-or-edge", "markdown-exporter", "lark-cli", "dws", "wecom-cli",
    ])
    const undocumented = [...new Set(Object.values(BUILTIN_DEP_MAP).flat())]
      .filter((d) => !NON_PIP.has(d) && !(d in PIP_HINTS))
    expect(undocumented).toEqual([])
  })

  it("a dep optional for deckcraft is still required for the skill built on it", () => {
    // OPTIONAL_DEPS is scoped `skill:dep` precisely for this: pdfplumber/pypdf/
    // pypdfium2 are what the whole pdf skill stands on, while for deckcraft they
    // only unlock reading a PDF *source*. A flat name-keyed set would have made
    // the pdf skill report ready with no PDF library at all.
    expect(missingDeps("pdf", present("python3", "pypdfium2", "pypdf", "pdfplumber", "reportlab"))).toEqual([])
    expect(missingDeps("pdf", present("python3", "pypdfium2", "pypdf", "reportlab"))).toEqual(["pdfplumber"])
    expect(missingDeps("pdf", present("python3", "pdfplumber", "reportlab"))).toEqual(["pypdfium2", "pypdf"])
    // ...and openpyxl stays required for xlsx while being optional for deckcraft.
    expect(missingDeps("xlsx", present("python3", "lxml", "soffice"))).toEqual(["openpyxl"])
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
    // pdf stands on four permissive libraries (059 S4, off AGPL PyMuPDF):
    // Poppler/pdftoppm is not a dependency, and all four are import probes rather
    // than PATH lookups.
    expect(missingDeps("pdf", present("python3", "pypdfium2", "pypdf", "pdfplumber",
                                      "reportlab"))).toEqual([])
    expect(missingDeps("pptx-edit", present("python3", "python-pptx"))).toEqual([])
  })

  it("lists exactly the missing tools", () => {
    expect(missingDeps("pdf", present("python3"))).toEqual(
      ["pypdfium2", "pypdf", "pdfplumber", "reportlab"])
    // Three of the four is NOT ready: each one answers a different question (pixels,
    // object model, text geometry, writing) and no other library in the set covers
    // for a missing one.
    expect(missingDeps("pdf", present("python3", "pypdfium2", "pypdf", "pdfplumber")))
      .toEqual(["reportlab"])
    // a machine with Poppler and nothing else is NOT ready — the pre-059 dep list
    // would have made this pass
    expect(missingDeps("pdf", present("python3", "pdftoppm"))).toEqual(
      ["pypdfium2", "pypdf", "pdfplumber", "reportlab"])
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

/**
 * gotchas §10 says a dependency change has to land in FOUR places: the skill's
 * `x-requires`, BUILTIN_DEP_MAP, PY_MODULES and this file's key set. Three of them
 * were already asserted somewhere; `x-requires` was not, and it rotted — deckcraft
 * declared 4 while the badge map declared 16 (059 S3.5 added the source readers and
 * only touched the map). A rule nobody checks is a rule that decays, which is the
 * same thing 059 S6 said about SKILL.md descriptions.
 *
 * Read from disk on purpose: BUILTIN_DEP_MAP is imported (no parsing, so no
 * prefix-matching regex to get wrong), and the frontmatter is the only thing parsed.
 */
describe("x-requires in SKILL.md mirrors BUILTIN_DEP_MAP", () => {
  const builtinDir = (() => {
    let d = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 12; i++) {
      const c = join(d, "skills", "builtin")
      if (existsSync(join(c, "docx", "SKILL.md"))) return c
      d = dirname(d)
    }
    throw new Error("skills/builtin not found walking up from the test file")
  })()

  /** `x-requires: [a, b]` -> ["a","b"]; null when the key is absent entirely. */
  const readXRequires = (skill: string): string[] | null => {
    const text = readFileSync(join(builtinDir, skill, "SKILL.md"), "utf8")
    const m = text.match(/^x-requires:\s*\[(.*?)\]\s*$/m)
    if (!m) return null
    return m[1].split(",").map((s) => s.trim()).filter(Boolean)
  }

  /** Both directions, so "declared but not required" is caught as well. */
  const drift = (declared: string[] | null, live: string[]) =>
    declared === null
      ? ["no x-requires at all"]
      : [
          ...live.filter((d) => !declared.includes(d)).map((d) => `missing from SKILL.md: ${d}`),
          ...declared.filter((d) => !live.includes(d)).map((d) => `extra in SKILL.md: ${d}`),
        ]

  it("finds the skills on disk — an empty sweep looks exactly like a pass", () => {
    const dirs = readdirSync(builtinDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(builtinDir, e.name, "SKILL.md")))
    expect(dirs.length).toBeGreaterThanOrEqual(11)
    // and every mapped skill must actually be one of them
    for (const name of Object.keys(BUILTIN_DEP_MAP)) {
      expect(dirs.map((d) => d.name)).toContain(name)
    }
  })

  it("every built-in skill declares exactly what the badge map requires", () => {
    const problems: string[] = []
    for (const [skill, live] of Object.entries(BUILTIN_DEP_MAP)) {
      for (const d of drift(readXRequires(skill), live)) problems.push(`${skill}: ${d}`)
    }
    expect(problems).toEqual([])
  })

  it("CONTROL: the comparison actually reports drift (both directions)", () => {
    // Replicates the shape that rotted — the map grew, the SKILL.md did not.
    const live = BUILTIN_DEP_MAP["deckcraft"]
    expect(drift(live.slice(0, 4), live)).toHaveLength(live.length - 4)
    expect(drift([...live, "invented-dep"], live)).toEqual(["extra in SKILL.md: invented-dep"])
    expect(drift(null, live)).toEqual(["no x-requires at all"])
    // and it stays silent when they agree, or the assertion above proves nothing
    expect(drift([...live], live)).toEqual([])
  })
})
