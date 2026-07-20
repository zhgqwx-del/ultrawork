import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// i18n: identity so assertions read on stable keys (mirrors other settings tests).
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))
const openExternal = vi.fn()
vi.mock("@/lib/external-url", () => ({ openExternal: (u: string) => openExternal(u), isOpenableUrl: () => true }))
// MarkdownContent pulls in react-markdown; stub it (LegalDocView isn't under test here).
vi.mock("@/components/chat/message-parts", () => ({
  MarkdownContent: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
}))

// Build a deterministic manifest: 85 components so the 80-row page + "load more"
// path is exercised, plus one MODIFIED entry and one searchable name.
const components = Array.from({ length: 85 }, (_, i) => ({
  id: i + 1,
  name: i === 0 ? "opencode" : `pkg-${i}`,
  version: "1.0.0",
  license: i === 0 ? "MIT" : "Apache-2.0",
  modified: i === 0,
  source: i === 0 ? "vendored" : "npm",
  url: `https://example.com/${i}`,
}))
vi.mock("@/generated/licenses.json", () => ({
  default: { generatedAt: "2026-07-20", counts: { npm: 84, opencode: 0, cargo: 0, vendored: 1, total: 85, withText: 1 }, components },
}))
vi.mock("@/generated/license-texts.json", () => ({ default: { 1: "MIT License — full text here" } }))

import { OssLicensesView } from "@/components/settings/about-legal"

describe("OssLicensesView", () => {
  beforeEach(() => openExternal.mockClear())

  it("renders the manifest and flags the MODIFIED component", async () => {
    render(<OssLicensesView onBack={vi.fn()} />)
    expect(await screen.findByText("opencode")).toBeInTheDocument()
    // The modified badge (about.oss.modifiedYes) appears exactly once (opencode).
    expect(screen.getAllByText("about.oss.modifiedYes")).toHaveLength(1)
  })

  it("paginates: Next/Previous move a bounded window (page size 50)", async () => {
    render(<OssLicensesView onBack={vi.fn()} />)
    await screen.findByText("opencode")
    // Page 1 = rows 1..50 (opencode + pkg-1..pkg-49); pkg-49 in, pkg-50 out.
    expect(screen.getByText("pkg-49")).toBeInTheDocument()
    expect(screen.queryByText("pkg-50")).not.toBeInTheDocument()
    // Previous is disabled on the first page.
    expect(screen.getByRole("button", { name: "about.oss.prev" })).toBeDisabled()
    // Next → page 2 (rows 51..85 = pkg-50..pkg-84); opencode gone, pkg-84 in.
    fireEvent.click(screen.getByRole("button", { name: "about.oss.next" }))
    expect(await screen.findByText("pkg-84")).toBeInTheDocument()
    expect(screen.queryByText("opencode")).not.toBeInTheDocument()
    // Last page → Next disabled; Previous returns to page 1.
    expect(screen.getByRole("button", { name: "about.oss.next" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "about.oss.prev" }))
    expect(await screen.findByText("opencode")).toBeInTheDocument()
  })

  it("filters by query", async () => {
    render(<OssLicensesView onBack={vi.fn()} />)
    await screen.findByText("opencode")
    fireEvent.change(screen.getByPlaceholderText("about.oss.searchPlaceholder"), { target: { value: "opencode" } })
    await waitFor(() => expect(screen.queryByText("pkg-1")).not.toBeInTheDocument())
    expect(screen.getByText("opencode")).toBeInTheDocument()
  })

  it("source filter chips scope the table by origin", async () => {
    render(<OssLicensesView onBack={vi.fn()} />)
    await screen.findByText("opencode")
    // Mock counts: npm 84, vendored 1. Chips carry the count in their name
    // (rows show the source label WITHOUT a count) → exact name hits only the chip.
    fireEvent.click(screen.getByRole("button", { name: "about.oss.source.npm 84" }))
    await waitFor(() => expect(screen.queryByText("opencode")).not.toBeInTheDocument())
    expect(screen.getByText("pkg-1")).toBeInTheDocument()
    // Click "vendored" → only opencode remains, npm rows gone.
    fireEvent.click(screen.getByRole("button", { name: "about.oss.source.vendored 1" }))
    await waitFor(() => expect(screen.queryByText("pkg-1")).not.toBeInTheDocument())
    expect(screen.getByText("opencode")).toBeInTheDocument()
  })

  it("empty result: shows no-results and hides pagination controls", async () => {
    render(<OssLicensesView onBack={vi.fn()} />)
    await screen.findByText("opencode")
    fireEvent.change(screen.getByPlaceholderText("about.oss.searchPlaceholder"), { target: { value: "zzz-nonexistent" } })
    expect(await screen.findByText("about.oss.noResults")).toBeInTheDocument()
    // single (empty) page → no Prev/Next controls
    expect(screen.queryByRole("button", { name: "about.oss.prev" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "about.oss.next" })).not.toBeInTheDocument()
  })

  it("lazily reveals license full text on row expand", async () => {
    render(<OssLicensesView onBack={vi.fn()} />)
    fireEvent.click(await screen.findByText("opencode"))
    expect(await screen.findByText("MIT License — full text here")).toBeInTheDocument()
  })

  it("back button invokes onBack", async () => {
    const onBack = vi.fn()
    render(<OssLicensesView onBack={onBack} />)
    fireEvent.click(await screen.findByText("about.back"))
    expect(onBack).toHaveBeenCalledOnce()
  })
})
