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
vi.mock("@/lib/i18n-context", async (orig) => {
  const actual = (await orig()) as { translations: Record<string, Record<string, string>> }
  return {
    ...actual,
    useI18n: () => ({ language: "zh-Hans", setLanguage: () => {}, t: (k: string) => actual.translations["zh-Hans"][k] ?? k }),
  }
})
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

  // ── 中文路径：这一条是真机缺陷，而且只有走真管线才看得见 ────────────────
  // mdast-util-to-hast 的 image handler 是 `{src: normalizeUri(node.url)}`，
  // 于是 `输出/page-001.png` 到达组件时已经是 `%E8%BE%93%E5%87%BA/page-001.png`。
  // 客户端再 encodeURIComponent 一次 ⇒ 请求的是一个名字里真含 `%E8…` 的文件。
  // 2026-08-15 L4 实测：中文工作区下三张内联图全灭，唯一显示出来的那张是纯 ASCII。
  // ⚠️ 这两条断言在 MarkdownImage 单测里写不出来 —— 单测直接喂 src，绕开了加编码的那一层，
  // 而此前 18 条用例里每一条路径都是纯 ASCII，所以门禁全绿而功能是坏的。
  it("resolves a Chinese RELATIVE path (percent-encoded by the markdown pipeline)", async () => {
    getFileContent.mockResolvedValue({ content: "AAAA", mimeType: "image/png" })
    render(<MarkdownContent text="![第1页](输出/page-001.png)" workspaceDir={WS} />)
    await waitFor(() => expect(screen.getByAltText("第1页")).toBeTruthy())
    expect(getFileContent).toHaveBeenCalledWith("输出/page-001.png")
  })

  it("resolves a Chinese ABSOLUTE path inside a Chinese WORKSPACE (prefix match must survive encoding)", async () => {
    // 工作区名本身带中文时更狠：编码后前缀不再等于 workspaceDir ⇒ 连请求都不会发出，
    // 直接落到「无法解析」那一支。
    const cnWs = "/Users/z/Desktop/技能自测"
    getFileContent.mockResolvedValue({ content: "BBBB", mimeType: "image/png" })
    render(<MarkdownContent text={`![第2页](${cnWs}/输出/page-002.png)`} workspaceDir={cnWs} />)
    await waitFor(() => expect(screen.getByAltText("第2页")).toBeTruthy())
    expect(getFileContent).toHaveBeenCalledWith("输出/page-002.png")
  })

  it("keeps a literal percent in a filename intact (decode is the exact inverse)", async () => {
    getFileContent.mockResolvedValue({ content: "CCCC", mimeType: "image/png" })
    render(<MarkdownContent text="![p](100%25-done.png)" workspaceDir={WS} />)
    await waitFor(() => expect(screen.getByAltText("p")).toBeTruthy())
    expect(getFileContent).toHaveBeenCalledWith("100%-done.png")
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
