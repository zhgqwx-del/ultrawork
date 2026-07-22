// Inline reply images (`![alt](src)`). qwen "draws" by writing an SVG/PNG into
// the workspace and referencing it by local path; the default <img> 404s in the
// WebView. MarkdownImage resolves local paths through getFileContent → data URI,
// passes remote/base64 straight through, and falls back to a chip otherwise.
// See discussions/049 / ADR-065. jsdom + mocked api.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import {
  MarkdownImage,
  MarkdownImageContext,
  type MarkdownImageCtx,
  __clearMarkdownImageCache,
} from "@/components/chat/markdown-image"

const getFileContent = vi.fn()
const apiStub = { getFileContent }
vi.mock("@/lib/use-api", () => ({ useApi: () => apiStub }))

const WS = "/Users/z/.ultrawork/workspace"

function renderImg(props: { src?: string; alt?: string }, ctx: MarkdownImageCtx = {}) {
  return render(
    <MarkdownImageContext.Provider value={ctx}>
      <MarkdownImage {...props} />
    </MarkdownImageContext.Provider>,
  )
}

beforeEach(() => {
  __clearMarkdownImageCache()
})
afterEach(() => {
  cleanup()
  getFileContent.mockReset()
})

describe("MarkdownImage", () => {
  it("passes a remote https URL straight through to a native <img>", () => {
    renderImg({ src: "https://example.com/a.png", alt: "remote" })
    const img = screen.getByAltText("remote") as HTMLImageElement
    expect(img.tagName).toBe("IMG")
    expect(img.getAttribute("src")).toBe("https://example.com/a.png")
    expect(getFileContent).not.toHaveBeenCalled()
  })

  it("passes a base64 data URI straight through", () => {
    const data = "data:image/png;base64,iVBORw0KGgo="
    renderImg({ src: data, alt: "b64" })
    expect((screen.getByAltText("b64") as HTMLImageElement).getAttribute("src")).toBe(data)
    expect(getFileContent).not.toHaveBeenCalled()
  })

  it("resolves a workspace-relative local path via getFileContent → data URI", async () => {
    getFileContent.mockResolvedValue({ content: "PHN2Zz4=", mimeType: "image/svg+xml" })
    renderImg({ src: "octopus.svg", alt: "octo" }, { workspaceDir: WS })
    await waitFor(() =>
      expect((screen.getByAltText("octo") as HTMLImageElement).getAttribute("src")).toBe(
        "data:image/svg+xml;base64,PHN2Zz4=",
      ),
    )
    expect(getFileContent).toHaveBeenCalledWith("octopus.svg")
  })

  it("strips a workspace-absolute path to relative before fetching", async () => {
    getFileContent.mockResolvedValue({ content: "AAAA", mimeType: "image/png" })
    renderImg({ src: `${WS}/orca.png`, alt: "orca" }, { workspaceDir: WS })
    await waitFor(() => expect(screen.getByAltText("orca")).toBeTruthy())
    expect(getFileContent).toHaveBeenCalledWith("orca.png")
  })

  it("shows a fallback chip for an absolute path OUTSIDE the workspace (no fetch)", () => {
    renderImg({ src: "/etc/passwd.png", alt: "evil" }, { workspaceDir: WS })
    expect(screen.getByText("evil")).toBeTruthy()
    expect(screen.queryByAltText("evil")).toBeNull() // not an <img>
    expect(getFileContent).not.toHaveBeenCalled()
  })

  it("falls back to a chip when the file is empty / not an image", async () => {
    getFileContent.mockResolvedValue({ content: "", mimeType: "text/plain" })
    renderImg({ src: "notes.txt", alt: "notes" }, { workspaceDir: WS })
    await waitFor(() => expect(screen.getByText("notes")).toBeTruthy())
    expect(screen.queryByAltText("notes")).toBeNull()
  })

  it("falls back to a chip when getFileContent rejects", async () => {
    getFileContent.mockRejectedValue(new Error("nope"))
    renderImg({ src: "gone.svg", alt: "gone" }, { workspaceDir: WS })
    await waitFor(() => expect(screen.getByText("gone")).toBeTruthy())
    expect(screen.queryByAltText("gone")).toBeNull()
  })

  it("stays inert (no fetch) for a local path with no workspace context", () => {
    renderImg({ src: "octopus.svg", alt: "no-ws" }) // about-legal style: no workspaceDir
    expect(getFileContent).not.toHaveBeenCalled()
    expect(screen.queryByAltText("no-ws")).toBeNull()
    expect(screen.getByText("no-ws")).toBeTruthy()
  })

  it("refuses a javascript: src (no fetch, no <img>)", () => {
    renderImg({ src: "javascript:alert(1)", alt: "xss" }, { workspaceDir: WS })
    expect(getFileContent).not.toHaveBeenCalled()
    expect(screen.queryByAltText("xss")).toBeNull()
  })

  it("opens the artifact preview when a resolved image is clicked", async () => {
    getFileContent.mockResolvedValue({ content: "AAAA", mimeType: "image/png" })
    const onArtifactClick = vi.fn()
    renderImg({ src: "octopus.svg", alt: "octo" }, { workspaceDir: WS, onArtifactClick })
    const img = await screen.findByAltText("octo")
    fireEvent.click(img)
    expect(onArtifactClick).toHaveBeenCalledWith({ type: "file", path: "octopus.svg" })
  })

  it("serves a repeated image from cache without a second fetch", async () => {
    getFileContent.mockResolvedValue({ content: "AAAA", mimeType: "image/png" })
    renderImg({ src: "octopus.svg", alt: "first" }, { workspaceDir: WS })
    await screen.findByAltText("first")
    expect(getFileContent).toHaveBeenCalledTimes(1)

    renderImg({ src: "octopus.svg", alt: "second" }, { workspaceDir: WS })
    // Cache hit → synchronous <img>, still only one fetch total.
    expect(screen.getByAltText("second")).toBeTruthy()
    expect(getFileContent).toHaveBeenCalledTimes(1)
  })
})
