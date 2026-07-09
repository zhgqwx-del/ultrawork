import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { KBSource } from "@/lib/use-knowledge-base"

// t returns the key verbatim so we can assert on i18n keys directly.
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))
vi.mock("@/components/knowledge/add-source-dialog", () => ({
  AddSourceDialog: () => null,
}))

// Stable module-level hook return (gotchas §13): fields mutated per test, the
// object identity never changes.
const kbApi = {
  sources: [] as KBSource[],
  loading: false,
  error: null as string | null,
  actionLoading: null as string | null,
  addFolder: vi.fn(),
  removeSource: vi.fn(),
  reindexSource: vi.fn(),
  testConnection: vi.fn(),
  refresh: vi.fn(async () => {}),
}
vi.mock("@/lib/use-knowledge-base", () => ({ useKnowledgeBase: () => kbApi }))

import { KnowledgeSection } from "@/pages/Settings"

const src = (id: number, type: KBSource["type"], name: string): KBSource => ({
  id,
  type,
  name,
  config: {},
  enabled: true,
  status: "complete",
})

beforeEach(() => {
  vi.clearAllMocks()
  kbApi.sources = []
  kbApi.loading = false
  kbApi.error = null
})

describe("KnowledgeSection tabs", () => {
  it("renders no tab bar when there are no sources (empty state only)", () => {
    render(<KnowledgeSection />)
    expect(screen.queryAllByRole("tab")).toHaveLength(0)
    expect(screen.getByText("knowledge.noSources")).toBeInTheDocument()
  })

  it("hides the tab bar while loading, even with sources already in hand", () => {
    kbApi.sources = [src(1, "local_folder", "docs")]
    kbApi.loading = true
    render(<KnowledgeSection />)
    expect(screen.queryAllByRole("tab")).toHaveLength(0)
    expect(screen.queryByText("docs")).toBeNull()
  })

  it("hides the tab bar on a fetch error and shows the error banner", () => {
    kbApi.sources = [src(1, "local_folder", "docs")]
    kbApi.error = "boom"
    render(<KnowledgeSection />)
    expect(screen.queryAllByRole("tab")).toHaveLength(0)
    expect(screen.getByText("knowledge.fetchError")).toBeInTheDocument()
  })

  it("renders four tabs in registry order with entry-count badges", () => {
    kbApi.sources = [
      src(1, "local_folder", "docs"),
      src(2, "local_folder", "notes"),
      src(3, "ima", "ima-wiki"),
      src(4, "custom_api", "my-api"),
    ]
    render(<KnowledgeSection />)

    expect(screen.getAllByRole("tab").map((el) => el.textContent)).toEqual([
      "knowledge.filterAll4",
      "knowledge.filterLocal2",
      "knowledge.filterPlatform1",
      "knowledge.filterApi1",
    ])
  })

  it("defaults to the All tab, showing every source exactly once", () => {
    kbApi.sources = [src(1, "local_folder", "docs"), src(2, "ima", "ima-wiki")]
    render(<KnowledgeSection />)

    // Exactly once: the per-type panels must stay unmounted, or a source that
    // belongs to both "all" and its type tab would render a duplicate card
    // (and a duplicate indexing-progress timer). This is why the Knowledge
    // panels must never forceMount — unlike the Connectors MCP panel.
    expect(screen.getAllByText("docs")).toHaveLength(1)
    expect(screen.getAllByText("ima-wiki")).toHaveLength(1)
  })

  it("filters to local folders, unmounting the other types' cards", async () => {
    const user = userEvent.setup()
    kbApi.sources = [src(1, "local_folder", "docs"), src(2, "ima", "ima-wiki")]
    render(<KnowledgeSection />)

    await user.click(screen.getByRole("tab", { name: /filterLocal/ }))
    expect(screen.getByText("docs")).toBeInTheDocument()
    expect(screen.queryByText("ima-wiki")).toBeNull()
  })

  it("maps the 'platform' tab onto the ima source type", async () => {
    const user = userEvent.setup()
    kbApi.sources = [src(1, "ima", "ima-wiki"), src(2, "custom_api", "my-api")]
    render(<KnowledgeSection />)

    await user.click(screen.getByRole("tab", { name: /filterPlatform/ }))
    expect(screen.getByText("ima-wiki")).toBeInTheDocument()
    expect(screen.queryByText("my-api")).toBeNull()
  })

  it("shows the empty hint inside a tab whose type has no sources", async () => {
    const user = userEvent.setup()
    kbApi.sources = [src(1, "local_folder", "docs")]
    render(<KnowledgeSection />)

    await user.click(screen.getByRole("tab", { name: /filterApi/ }))
    expect(screen.getByText("knowledge.noSources")).toBeInTheDocument()
    expect(screen.queryByText("docs")).toBeNull()
  })
})
