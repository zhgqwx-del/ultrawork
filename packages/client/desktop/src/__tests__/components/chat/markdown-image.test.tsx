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
// t() resolves against the REAL zh-Hans dictionary, not `(k) => k`: a mistyped
// key would then render as the raw key and these assertions would still pass,
// while the UI showed `message.imageUnreadable` to the user.
vi.mock("@/lib/i18n-context", async (orig) => {
  const actual = (await orig()) as { translations: Record<string, Record<string, string>> }
  return {
    ...actual,
    useI18n: () => ({
      language: "zh-Hans",
      setLanguage: () => {},
      t: (k: string) => actual.translations["zh-Hans"][k] ?? k,
    }),
  }
})

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

  // ── 兜底卡片必须说出是哪一种失败 ─────────────────────────────────────
  // 2026-08-15 L4：用户报「预览图不显示」，三种失败长得一模一样（同一个灰色
  // ImageOff + 同一段文字），分清「在工作区外」「读不到」「这是 PDF 不是图」
  // 花掉了整整一轮调查。这三条断言钉住的就是那个区别。（059 §十七/§十九）
  it("says WHY when the path is outside the workspace (and stays unclickable)", () => {
    renderImg({ src: "/tmp/filled_preview/page-001.png", alt: "form" }, { workspaceDir: WS })
    const chip = screen.getByTestId("markdown-image-fallback")
    expect(chip.getAttribute("data-fallback-kind")).toBe("outside")
    expect(chip.textContent).toContain("在工作区外")
    expect((chip as HTMLButtonElement).disabled).toBe(true) // 点了也没用，就别装成能点
    expect(getFileContent).not.toHaveBeenCalled()
  })

  it("calls a PDF a FILE, not a broken image, and keeps it clickable", async () => {
    // 端点对 PDF 和「文件不存在」返回同一个空 body，分不出来的只能靠扩展名。
    getFileContent.mockResolvedValue({ content: "", mimeType: undefined })
    const onArtifactClick = vi.fn()
    renderImg({ src: "输出/合并文件.pdf", alt: "合并文件" }, { workspaceDir: WS, onArtifactClick })
    const chip = await screen.findByTestId("markdown-image-fallback")
    expect(chip.getAttribute("data-fallback-kind")).toBe("document")
    expect(chip.textContent).toContain("不是图片，点击查看")
    fireEvent.click(chip)
    // 产物面板用 pdf.js 自己读字节，所以这一点不是空头支票。
    expect(onArtifactClick).toHaveBeenCalledWith({ type: "file", path: "输出/合并文件.pdf" })
  })

  it("refuses an ENCODED parent traversal (decode happens before the `..` check)", () => {
    // `%2E%2E%2F` 解码后才是 `..`。解码放在遍历检查之前是有意的：先检查再解码，
    // 这条会被判成一个普通的相对路径原样发出去。
    renderImg({ src: "%2E%2E%2F%2E%2E%2Fetc/passwd.png", alt: "trav" }, { workspaceDir: WS })
    expect(getFileContent).not.toHaveBeenCalled()
    expect(screen.getByTestId("markdown-image-fallback").getAttribute("data-fallback-kind")).toBe("outside")
  })

  it("says 读不到 when an image really cannot be read", async () => {
    getFileContent.mockResolvedValue({ content: "", mimeType: undefined })
    renderImg({ src: "输出/page-001.png", alt: "第1页" }, { workspaceDir: WS })
    const chip = await screen.findByTestId("markdown-image-fallback")
    expect(chip.getAttribute("data-fallback-kind")).toBe("unreadable")
    expect(chip.textContent).toContain("读不到")
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
