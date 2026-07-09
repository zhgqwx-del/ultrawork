import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SkillItem } from "@/lib/use-skills"

// t returns the key verbatim so we can assert on i18n keys directly. The
// interpolating overload is used by the shadow card / restore dialog.
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }))

// Stable module-level hook returns (gotchas §13).
const skillsApi = {
  groups: [] as unknown[],
  allItems: [] as SkillItem[],
  loading: false,
  error: null as string | null,
  totalCount: 0,
  skillsConfig: { paths: [] as string[], urls: [] as string[] },
  refresh: vi.fn(async () => {}),
  updateSkillsConfig: vi.fn(),
}
const shadowApi = {
  status: { bundled: [] as string[], shadowed: [] as string[], changed: false },
  loading: false,
  reconcile: vi.fn(async () => shadowApi.status),
  removeOverride: vi.fn(async () => shadowApi.status),
}
vi.mock("@/lib/use-skills", () => ({ useSkills: () => skillsApi }))
vi.mock("@/lib/use-builtin-shadow", () => ({ useBuiltinShadow: () => shadowApi }))
vi.mock("@/lib/use-skill-deps", () => ({
  useSkillDeps: () => ({ deps: {}, loading: false }),
  BUILTIN_DEP_MAP: {} as Record<string, string[]>,
  missingDeps: () => [] as string[],
}))

import { SkillsSection } from "@/pages/Settings"

const skill = (name: string, builtin: boolean): SkillItem => ({
  name,
  description: `${name} description`,
  source: "skill",
  builtin,
})

beforeEach(() => {
  vi.clearAllMocks()
  skillsApi.allItems = []
  skillsApi.totalCount = 0
  skillsApi.loading = false
  skillsApi.error = null
  shadowApi.status = { bundled: [], shadowed: [], changed: false }
})

describe("SkillsSection tabs", () => {
  it("renders no tab bar when no skills are discovered", () => {
    render(<SkillsSection />)
    expect(screen.queryAllByRole("tab")).toHaveLength(0)
    expect(screen.getByText("skills.empty")).toBeInTheDocument()
  })

  it("hides the tab bar while loading, even with skills already in hand", () => {
    skillsApi.allItems = [skill("ppt-master", true)]
    skillsApi.totalCount = 1
    skillsApi.loading = true
    render(<SkillsSection />)
    expect(screen.queryAllByRole("tab")).toHaveLength(0)
  })

  it("hides the tab bar on a fetch error and shows the error banner", () => {
    skillsApi.allItems = [skill("ppt-master", true)]
    skillsApi.totalCount = 1
    skillsApi.error = "boom"
    render(<SkillsSection />)
    expect(screen.queryAllByRole("tab")).toHaveLength(0)
    expect(screen.getByText("error.fetchSkills")).toBeInTheDocument()
  })

  it("shows the no-search-results hint inside a tab the query emptied", async () => {
    const user = userEvent.setup()
    skillsApi.allItems = [skill("ppt-master", true)]
    skillsApi.totalCount = 1
    render(<SkillsSection />)

    await user.type(screen.getByPlaceholderText("skills.searchPlaceholder"), "zzz-no-match")
    expect(screen.getByText("skills.noSearchResults")).toBeInTheDocument()
  })

  it("renders three tabs in registry order with entry-count badges", () => {
    skillsApi.allItems = [skill("ppt-master", true), skill("my-skill", false)]
    skillsApi.totalCount = 2
    render(<SkillsSection />)

    // installable = the 5-entry curated catalog, independent of the user's disk
    expect(screen.getAllByRole("tab").map((el) => el.textContent)).toEqual([
      "skills.zone.builtin1",
      "skills.zone.installable5",
      "skills.zone.custom1",
    ])
  })

  it("counts a shadowed builtin under the builtin tab, not just live items", () => {
    // A user copy shadows the builtin: it lives in customItems, while the
    // builtin tab shows an explanatory shadow card — both must be counted.
    skillsApi.allItems = [skill("ppt-master", false)]
    skillsApi.totalCount = 1
    shadowApi.status = { bundled: ["ppt-master"], shadowed: ["ppt-master"], changed: false }
    render(<SkillsSection />)

    const [builtinTab, , customTab] = screen.getAllByRole("tab")
    expect(builtinTab.textContent).toContain("1")
    expect(customTab.textContent).toContain("1")
  })

  // SettingsSkillCard renders the name slash-prefixed, as an invokable command.
  const cardName = (name: string) => `/${name}`

  it("defaults to the builtin tab; other panels stay unmounted", () => {
    skillsApi.allItems = [skill("ppt-master", true), skill("my-skill", false)]
    skillsApi.totalCount = 2
    render(<SkillsSection />)

    expect(screen.getByText(cardName("ppt-master"))).toBeInTheDocument()
    // No forceMount on this section: nothing here holds in-flight local state.
    expect(screen.queryByText(cardName("my-skill"))).toBeNull()
  })

  it("switches to the custom tab", async () => {
    const user = userEvent.setup()
    skillsApi.allItems = [skill("ppt-master", true), skill("my-skill", false)]
    skillsApi.totalCount = 2
    render(<SkillsSection />)

    await user.click(screen.getByRole("tab", { name: /zone\.custom/ }))
    expect(screen.getByText(cardName("my-skill"))).toBeInTheDocument()
    expect(screen.queryByText(cardName("ppt-master"))).toBeNull()
  })

  it("narrows every tab's count by the search query", async () => {
    const user = userEvent.setup()
    skillsApi.allItems = [skill("ppt-master", true), skill("my-skill", false)]
    skillsApi.totalCount = 2
    render(<SkillsSection />)

    // Query the full name: under the verbatim-`t` mock a bare "ppt" would also
    // match the catalog's `skills.catalog.webappTesting` key ("weba-ppt-esting").
    await user.type(screen.getByPlaceholderText("skills.searchPlaceholder"), "ppt-master")
    // builtin keeps its match; catalog keeps ppt-master; custom drops to 0
    const [builtinTab, installableTab, customTab] = screen.getAllByRole("tab")
    expect(builtinTab.textContent).toContain("1")
    expect(installableTab.textContent).toContain("1")
    expect(customTab.textContent).toContain("0")
  })
})
