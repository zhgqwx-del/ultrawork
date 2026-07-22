// End-to-end through the REAL chat markdown pipeline (MarkdownContent →
// ReactMarkdown → MARKDOWN_COMPONENTS.img → MarkdownImage), not MarkdownImage in
// isolation. This guards the two things a unit test on MarkdownImage cannot:
//   1. that `img` is actually wired into the component map, and
//   2. that MarkdownContent's custom `urlTransform` preserves `data:` image URIs
//      and Windows drive paths — react-markdown's DEFAULT transform blanks both
//      to "" before the component runs (verified), which would silently break
//      base64 images and all Windows-local images.
// See discussions/049 / ADR-065.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"
import { MarkdownContent } from "@/components/chat/message-parts"
import { __clearMarkdownImageCache } from "@/components/chat/markdown-image"

const getFileContent = vi.fn()
// Return a STABLE api object (the real useApi is memoized by the connector).
// A fresh object per call would change the resolve effect's `api` dep every
// render → refetch → re-render loop.
const apiStub = { getFileContent }
vi.mock("@/lib/use-api", () => ({ useApi: () => apiStub }))
// MarkdownLink pulls in the tauri opener; stub it so links don't explode.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

const WS = "/Users/z/.ultrawork/workspace"

beforeEach(() => __clearMarkdownImageCache())
afterEach(() => {
  cleanup()
  getFileContent.mockReset()
})

describe("MarkdownContent — inline image wiring", () => {
  it("resolves a local relative image the model wrote (![orca](orca_preview.png))", async () => {
    getFileContent.mockResolvedValue({ content: "AAAA", mimeType: "image/png" })
    render(<MarkdownContent text="done ![orca](orca_preview.png)" workspaceDir={WS} />)
    await waitFor(() => {
      const img = screen.getByAltText("orca") as HTMLImageElement
      expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA")
    })
    expect(getFileContent).toHaveBeenCalledWith("orca_preview.png")
  })

  it("resolves a workspace-ABSOLUTE path the model wrote (survives urlTransform)", async () => {
    getFileContent.mockResolvedValue({ content: "PHN2Zz4=", mimeType: "image/svg+xml" })
    render(<MarkdownContent text={`![octo](${WS}/octopus.svg)`} workspaceDir={WS} />)
    await waitFor(() => expect(screen.getByAltText("octo")).toBeTruthy())
    expect(getFileContent).toHaveBeenCalledWith("octopus.svg")
  })

  it("passes a base64 data:image URI straight through (NOT blanked by urlTransform)", () => {
    const data = "data:image/png;base64,iVBORw0KGgo="
    render(<MarkdownContent text={`![b64](${data})`} workspaceDir={WS} />)
    const img = screen.getByAltText("b64") as HTMLImageElement
    expect(img.getAttribute("src")).toBe(data)
    expect(getFileContent).not.toHaveBeenCalled()
  })

  // Windows: markdown treats "\" as its escape char, so a backslash path in
  // `![](…)` is mangled upstream of us (`C:\…` → "" after parsing) — an inherent
  // markdown limitation, not a renderer bug. The realistic, survivable forms are
  // forward-slash / relative, which the rich-output prompt steers the model to.
  it("resolves a forward-slash Windows drive path (C:/…)", async () => {
    const win = "C:/Users/z/ws"
    getFileContent.mockResolvedValue({ content: "AAAA", mimeType: "image/png" })
    render(<MarkdownContent text={`![w](${win}/chart.png)`} workspaceDir={win} />)
    await waitFor(() => expect(screen.getByAltText("w")).toBeTruthy())
    expect(getFileContent).toHaveBeenCalledWith("chart.png")
  })

  it("degrades a backslash Windows path to a fallback chip (no crash, no broken glyph)", () => {
    render(<MarkdownContent text="![w](C:\\Users\\z\\ws\\chart.png)" workspaceDir="C:\\Users\\z\\ws" />)
    // markdown blanks the mangled src → no <img>, just inert text; never throws.
    expect(screen.queryByAltText("w")).toBeNull()
    expect(getFileContent).not.toHaveBeenCalled()
  })

  it("passes a remote https image through", () => {
    render(<MarkdownContent text="![r](https://example.com/a.png)" workspaceDir={WS} />)
    expect((screen.getByAltText("r") as HTMLImageElement).getAttribute("src")).toBe("https://example.com/a.png")
    expect(getFileContent).not.toHaveBeenCalled()
  })

  it("does NOT resolve a javascript: image (blocked, no fetch, no <img>)", () => {
    render(<MarkdownContent text="![x](javascript:alert(1))" workspaceDir={WS} />)
    expect(getFileContent).not.toHaveBeenCalled()
    expect(screen.queryByAltText("x")).toBeNull()
  })
})
