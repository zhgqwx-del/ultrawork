import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

const h = vi.hoisted(() => ({ openUrl: vi.fn(() => Promise.resolve()) }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }))

import { MARKDOWN_LINK_ONLY } from "@/components/ui/markdown-link"

function renderMd(md: string) {
  return render(
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_LINK_ONLY}>
      {md}
    </ReactMarkdown>
  )
}

describe("MarkdownLink", () => {
  beforeEach(() => {
    h.openUrl.mockClear()
  })

  it("opens a markdown link in the system browser instead of navigating", async () => {
    renderMd("see [the docs](https://example.com/docs)")
    const link = screen.getByRole("link", { name: "the docs" })

    // `target="_blank"` is what the transcript used to do: the WebView swallows the
    // new-window request and the click does nothing at all. A bare anchor is worse —
    // it navigates in place and the app is gone. Neither may come back.
    expect(link).not.toHaveAttribute("target")

    await userEvent.click(link)
    expect(h.openUrl).toHaveBeenCalledWith("https://example.com/docs")
  })

  // remark-gfm autolinks bare URLs, so the most common case in a chat reply — the
  // model just typing a URL — goes through the same renderer.
  it("opens a bare autolinked URL too", async () => {
    renderMd("go to https://example.com/page for details")
    await userEvent.click(screen.getByRole("link", { name: "https://example.com/page" }))
    expect(h.openUrl).toHaveBeenCalledWith("https://example.com/page")
  })

  it("shows the destination on hover, so a mislabelled link is inspectable", () => {
    renderMd("[click here](https://example.com/real-destination)")
    expect(screen.getByRole("link", { name: "click here" })).toHaveAttribute(
      "title",
      "https://example.com/real-destination"
    )
  })

  it("renders a relative link as inert text rather than a dead link", async () => {
    renderMd("see [the report](./report.pdf)")
    // Not a link at all — a link that visibly does nothing is worse than text that
    // never promised to do anything.
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("the report")).toBeInTheDocument()

    await userEvent.click(screen.getByText("the report"))
    expect(h.openUrl).not.toHaveBeenCalled()
  })

  it("renders an anchor link as inert text", () => {
    renderMd("jump to [section](#results)")
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("section")).toBeInTheDocument()
  })

  // Belt and braces: react-markdown's defaultUrlTransform already strips these
  // before we see them, so this asserts the two layers agree rather than that
  // either one alone is load-bearing.
  it("never hands a javascript:/file: URL to the OS", async () => {
    renderMd("[x](javascript:alert(1)) [y](file:///etc/passwd)")
    for (const link of screen.queryAllByRole("link")) await userEvent.click(link)
    expect(h.openUrl).not.toHaveBeenCalled()
  })
})
