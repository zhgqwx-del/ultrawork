import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const h = vi.hoisted(() => ({ openUrl: vi.fn(() => Promise.resolve()) }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }))

import { MarkdownContent } from "@/components/chat/message-parts"

/**
 * Guards the transcript specifically, not just the shared MarkdownLink component.
 *
 * `markdown-link.test.tsx` renders MARKDOWN_LINK_ONLY directly, so it would stay
 * green if someone re-introduced a bare `target="_blank"` anchor in the
 * transcript's own component map — which is exactly the bug this change fixes.
 * The assertion has to go through `MarkdownContent` to actually hold that door shut.
 */
describe("transcript links (MarkdownContent)", () => {
  beforeEach(() => {
    h.openUrl.mockClear()
  })

  it("opens a link in the AI reply via the system browser", async () => {
    render(<MarkdownContent text="see [the docs](https://example.com/docs)" />)
    const link = screen.getByRole("link", { name: "the docs" })
    expect(link).not.toHaveAttribute("target")

    await userEvent.click(link)
    expect(h.openUrl).toHaveBeenCalledWith("https://example.com/docs")
  })

  it("opens a bare URL the model just typed (remark-gfm autolink)", async () => {
    render(<MarkdownContent text="ref: https://example.com/page" />)
    await userEvent.click(screen.getByRole("link", { name: "https://example.com/page" }))
    expect(h.openUrl).toHaveBeenCalledWith("https://example.com/page")
  })

  it("does not hand a file:/javascript: link in model output to the OS", async () => {
    render(<MarkdownContent text="[a](file:///etc/passwd) [b](javascript:alert(1))" />)
    for (const link of screen.queryAllByRole("link")) await userEvent.click(link)
    expect(h.openUrl).not.toHaveBeenCalled()
  })
})
