// HTML artifacts render as an in-app browser preview (iframe with srcDoc), not
// the CodeMirror source view — decks are self-contained so srcDoc renders them
// fully. A header toggle flips to the raw source and back. Separately, the
// "open with default app" button is now offered for every file type, not just
// PDF/HTML. jsdom + mocked deps (the real API/Tauri bridges don't exist here).
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import { ArtifactPreview } from "@/components/session/artifact-preview"

const invokeMock = vi.fn().mockResolvedValue(undefined)
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: any[]) => invokeMock(...a) }))
// Return STABLE references — the real i18n/api come from context and are stable,
// so the content-load effect (deps include `t` and `api`) runs once. Fresh
// objects per render would re-run it and reset the source/preview toggle.
const i18n = { t: (k: string) => k, language: "en", setLanguage: () => {} }
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => i18n }))
vi.mock("@/lib/theme-context", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))

// CodeMirror is the source-view branch. Stub it to a marker so we can assert
// which branch rendered without pulling the heavy editor into jsdom.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value }: { value: string }) => <div data-testid="cm-source">{value}</div>,
}))

const getFileContent = vi.fn()
const apiStub = { getFileContent, getSessionDiff: vi.fn() }
vi.mock("@/lib/use-api", () => ({ useApi: () => apiStub }))

const HTML = "<!doctype html><title>Deck</title><body><h1>Slide</h1></body>"

afterEach(() => {
  cleanup()
  invokeMock.mockClear() // keep the mockResolvedValue impl (handleOpenWithApp does invoke(...).catch)
  getFileContent.mockReset()
})

describe("ArtifactPreview — HTML in-app preview", () => {
  it("renders an HTML file as an iframe (srcDoc), not the source view, by default", async () => {
    getFileContent.mockResolvedValue({ content: HTML })
    render(<ArtifactPreview artifact={{ type: "file", path: "/ws/deck.html" }} directory="/ws" onClose={() => {}} />)

    const frame = await screen.findByTitle("deck.html")
    expect(frame.tagName).toBe("IFRAME")
    // Self-contained content goes in via srcDoc; sandbox keeps an opaque origin
    // with scripts allowed but no same-origin access to the parent / Tauri IPC.
    expect(frame.getAttribute("srcdoc")).toBe(HTML)
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    expect(screen.queryByTestId("cm-source")).toBeNull()
  })

  it("toggles between preview and source view", async () => {
    getFileContent.mockResolvedValue({ content: HTML })
    render(<ArtifactPreview artifact={{ type: "file", path: "/ws/deck.html" }} directory="/ws" onClose={() => {}} />)

    await screen.findByTitle("deck.html")
    // Preview is up → the toggle offers "view source".
    fireEvent.click(screen.getByTitle("artifact.viewSource"))
    expect(screen.getByTestId("cm-source")).toBeTruthy()
    expect(screen.queryByTitle("deck.html")).toBeNull() // iframe gone
    // Now source is up → the toggle offers "view preview".
    fireEvent.click(screen.getByTitle("artifact.viewPreview"))
    expect(screen.getByTitle("deck.html").tagName).toBe("IFRAME")
  })

  it("offers 'open with default app' for a non-HTML file (generalized beyond PDF/HTML)", async () => {
    getFileContent.mockResolvedValue({ content: "print('hi')" })
    render(<ArtifactPreview artifact={{ type: "file", path: "/ws/gen.py" }} directory="/ws" onClose={() => {}} />)

    await waitFor(() => expect(screen.getByTestId("cm-source")).toBeTruthy()) // .py → source view
    const btn = screen.getByTitle("artifact.openWithApp")
    fireEvent.click(btn)
    expect(invokeMock).toHaveBeenCalledWith("open_file_with_system", expect.objectContaining({ path: expect.stringContaining("gen.py") }))
    // No preview/source toggle for a plain code file.
    expect(screen.queryByTitle("artifact.viewSource")).toBeNull()
    expect(screen.queryByTitle("artifact.viewPreview")).toBeNull()
  })
})

describe("ArtifactPreview — open-with-app icon reflects file type", () => {
  // lucide renders <svg class="lucide lucide-<name> ...">; assert which glyph the
  // header's "open with default app" button shows per type (semantic hint, not a
  // fixed icon). Binary types (xlsx/pptx/mp4) ALSO render a BinaryFileCard whose
  // own open button shares the title, so take the FIRST match = the header button.
  const headerIconClass = (title: string) =>
    screen.getAllByTitle(title)[0].querySelector("svg")?.getAttribute("class") ?? ""

  it.each([
    ["/ws/deck.html", "artifact.openInBrowser", "lucide-globe", "print"], // html → browser glyph
    ["/ws/gen.py", "artifact.openWithApp", "lucide-file-code", "x=1"], // code → code glyph
    ["/ws/notes.md", "artifact.openWithApp", "lucide-file-text", "# hi"], // doc → text glyph
    ["/ws/data.xlsx", "artifact.openWithApp", "lucide-file-spreadsheet", ""], // sheet (binary)
    ["/ws/slides.pptx", "artifact.openWithApp", "lucide-presentation", ""], // slides (binary)
    ["/ws/movie.mp4", "artifact.openWithApp", "lucide-file-play", ""], // video (binary; lucide FileVideo→file-play)
    ["/ws/whatever.xyz", "artifact.openWithApp", "lucide-app-window", "blah"], // unmapped → fallback
  ])("%s → %s", async (path, title, cls, content) => {
    getFileContent.mockResolvedValue({ content })
    render(<ArtifactPreview artifact={{ type: "file", path }} directory="/ws" onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByTitle(title).length).toBeGreaterThan(0))
    expect(headerIconClass(title)).toContain(cls)
  })
})
