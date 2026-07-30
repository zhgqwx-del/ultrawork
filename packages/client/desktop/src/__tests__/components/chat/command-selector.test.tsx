import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { ChatInput } from "@/components/chat/chat-input"
import type { Command } from "@agent/api-client"

/**
 * Integration tests for the `/` command menu (discussions/056). Drives the real
 * CommandSelector through ChatInput, because the defects that made this batch
 * necessary lived in the seam between the two — chat-input.test.tsx mocks the
 * selector out entirely, so that seam had zero coverage.
 */

const cmd = (name: string, description: string, source = "skill"): Command => ({
  name,
  description,
  source,
  template: "",
  hints: [],
})

let COMMANDS: Command[] = []
let getCommands: () => Promise<Command[]> = () => Promise.resolve(COMMANDS)

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "zh", setLanguage: vi.fn() }),
}))

vi.mock("@/lib/use-api", () => ({
  useApi: () => ({ getCommands: () => getCommands() }),
}))

function Harness({
  onSend = vi.fn(),
  commandsEnabled,
  initial = "",
}: {
  onSend?: () => void
  commandsEnabled?: boolean
  initial?: string
}) {
  const [value, setValue] = useState(initial)
  return (
    <ChatInput
      value={value}
      onChange={setValue}
      onSend={onSend}
      commandsEnabled={commandsEnabled}
      placeholder="Reply..."
    />
  )
}

const rows = () => screen.queryAllByRole("button").filter((b) => b.hasAttribute("data-index"))
const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement

const highlightedIndex = () =>
  rows().findIndex((r) => r.className.includes("bg-[var(--color-accent)]"))

/**
 * Open the menu and wait until it actually OWNS THE KEYBOARD.
 *
 * Rows appear in the render phase, but the selector attaches its document-level
 * keydown listener — and resets the selection to 0 — in effects keyed on `open`.
 * A key fired in that window is either swallowed (no listener yet) or undone (the
 * reset runs after it). A human cannot type that fast; a test can, and this file
 * flaked on CI three separate ways because of it: arrows lost, then Escape lost.
 *
 * So probe instead of hoping: press ArrowDown until the highlight actually moves,
 * then ArrowUp to put the selection back where it started. Once a key has visibly
 * landed, every later key in the test lands too.
 */
async function openMenu(text = "/") {
  fireEvent.change(textarea(), { target: { value: text } })
  await waitFor(() => expect(rows().length).toBeGreaterThan(0))
  // One row means the arrows are a no-op (selection wraps to itself), so there is
  // nothing observable to probe with — and nothing to race, either.
  if (rows().length < 2) return
  await waitFor(() => {
    fireEvent.keyDown(textarea(), { key: "ArrowDown" })
    expect(highlightedIndex()).toBe(1)
  })
  fireEvent.keyDown(textarea(), { key: "ArrowUp" })
  await waitFor(() => expect(highlightedIndex()).toBe(0))
}

beforeEach(() => {
  getCommands = () => Promise.resolve(COMMANDS)
  COMMANDS = [
    cmd("deckcraft", "HTML-first presentation generator for 做PPT and slide decks."),
    cmd("doc-edit", "Use when the user wants to READ or MODIFY existing Office files."),
    cmd("markdown-exporter", "Convert Markdown text to DOCX, PPTX, XLSX, PDF files."),
  ]
})

describe("CommandSelector — layout", () => {
  it("caps its height and scrolls instead of growing past the viewport", async () => {
    render(<Harness />)
    await openMenu()
    const list = rows()[0].closest("div.overflow-y-auto")
    expect(list).not.toBeNull()
    expect(list!.className).toMatch(/max-h-/)
  })

  it("renders the description on its own truncated line, with no opacity dimming", async () => {
    render(<Harness />)
    await openMenu()
    // Row 0 is the selected one, row 1 is not — both descriptions must be
    // truncated and neither may be dimmed with opacity (muted × opacity-70
    // measures 2.68:1 light / 3.73:1 dark, both under AA). The ratios
    // themselves are gated in command-menu-contrast.test.ts.
    const selectedDesc = screen.getByText(/HTML-first presentation/)
    const unselectedDesc = screen.getByText(/READ or MODIFY/)
    for (const desc of [selectedDesc, unselectedDesc]) {
      expect(desc.className).toMatch(/truncate/)
      expect(desc.className).not.toMatch(/opacity-/)
    }
    expect(unselectedDesc.className).toMatch(/--color-fg-muted/)
    expect(selectedDesc.className).toMatch(/--color-accent-fg/)
    // Name and description are separate blocks, not one reflowing paragraph.
    expect(screen.getByText("/deckcraft").tagName).toBe("DIV")
  })

  it("keeps the full description reachable via title once truncated", async () => {
    render(<Harness />)
    await openMenu()
    expect(rows()[0].getAttribute("title")).toBe(COMMANDS[0].description)
  })

  it("scrolls the active row into view on arrow navigation", async () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView")
    render(<Harness />)
    await openMenu()
    spy.mockClear()
    fireEvent.keyDown(textarea(), { key: "ArrowDown" })
    await waitFor(() => expect(spy).toHaveBeenCalled())
    spy.mockRestore()
  })
})

describe("CommandSelector — ordering and grouping", () => {
  it("groups by source when there is more than one non-empty group", async () => {
    COMMANDS = [cmd("my-deploy", "a config command", "command"), cmd("deckcraft", "decks", "skill")]
    render(<Harness />)
    await openMenu()
    expect(screen.getByText("command.group.command")).toBeInTheDocument()
    expect(screen.getByText("command.group.skill")).toBeInTheDocument()
    expect(rows().map((r) => r.getAttribute("data-index"))).toEqual(["0", "1"])
  })

  it("omits group headers when only one group is non-empty (the default install)", async () => {
    render(<Harness />) // all three are skills
    await openMenu()
    // Exactly one label, and it is the panel title — not a redundant second one.
    expect(screen.getAllByText("command.group.skill")).toHaveLength(1)
  })

  // The old fixed "Commands" title sat above a list that, on a default install,
  // is 100% skills — while the settings page and the group headers below both
  // call those things "Skills". The panel now names what it actually holds.
  describe("the panel title names its actual contents", () => {
    it("labels an all-skills list as skills", async () => {
      render(<Harness />)
      await openMenu()
      const title = screen.getByText("command.group.skill")
      expect(title.tagName).toBe("P")
      expect(title.closest("div.absolute")).not.toBeNull()
      expect(screen.queryByText("command.group.command")).toBeNull()
    })

    it("labels an all-command list as commands", async () => {
      COMMANDS = [cmd("my-deploy", "a config command", "command")]
      render(<Harness />)
      await openMenu()
      expect(screen.getByText("command.group.command")).toBeInTheDocument()
      expect(screen.queryByText("command.group.skill")).toBeNull()
    })

    it("drops the title when the list is mixed — the group headers name it instead", async () => {
      COMMANDS = [cmd("my-deploy", "a config command", "command"), cmd("deckcraft", "decks", "skill")]
      render(<Harness />)
      await openMenu()
      // One occurrence each: the group headers, with no panel title duplicating them.
      expect(screen.getAllByText("command.group.command")).toHaveLength(1)
      expect(screen.getAllByText("command.group.skill")).toHaveLength(1)
      const panel = rows()[0].closest("div.absolute")!
      expect(panel.querySelector(":scope > p")).toBeNull()
    })

    it("drops the title when a query mixes sources", async () => {
      COMMANDS = [cmd("deploy-thing", "x", "command"), cmd("deckcraft", "x", "skill")]
      render(<Harness />)
      await openMenu("/de")
      await waitFor(() => expect(rows()).toHaveLength(2))
      const panel = rows()[0].closest("div.absolute")!
      expect(panel.querySelector(":scope > p")).toBeNull()
    })
  })

  it("flattens to match-rank order once a query is typed, best match first", async () => {
    COMMANDS = [
      cmd("my-deploy", "nothing relevant here", "command"),
      cmd("deckcraft", "decks", "skill"),
    ]
    render(<Harness />)
    await openMenu()
    fireEvent.change(textarea(), { target: { value: "/de" } })
    await waitFor(() => expect(rows()[0]).toHaveTextContent("/deckcraft"))
    // Grouping must not survive the query — it would bury the best match.
    expect(screen.queryByText("command.group.command")).toBeNull()
  })

  it("separates description-only hits behind a labelled divider", async () => {
    render(<Harness />)
    await openMenu("/doc")
    expect(rows()[0]).toHaveTextContent("/doc-edit")
    expect(screen.getByText("command.descriptionMatch")).toBeInTheDocument()
  })

  it("does not flash the empty state while the list is still loading", async () => {
    let release: (cmds: Command[]) => void = () => {}
    const pending = new Promise<Command[]>((resolve) => { release = resolve })
    getCommands = () => pending

    render(<Harness />)
    fireEvent.change(textarea(), { target: { value: "/" } })
    // In flight: an empty list is indistinguishable from "no match" here.
    expect(screen.queryByText("command.noMatch")).toBeNull()
    expect(screen.queryByText("command.group.skill")).toBeNull()

    release(COMMANDS)
    await waitFor(() => expect(rows().length).toBe(3))
    expect(screen.queryByText("command.noMatch")).toBeNull()
  })

  it("shows an explicit empty state rather than vanishing", async () => {
    render(<Harness />)
    await openMenu()
    fireEvent.change(textarea(), { target: { value: "/zzzzz" } })
    await waitFor(() => expect(screen.getByText("command.noMatch")).toBeInTheDocument())
    expect(rows()).toHaveLength(0)
  })
})

describe("CommandSelector — selection", () => {
  it("never highlights two rows at once: hovering moves the selection", async () => {
    // userEvent.hover drives the full pointer sequence React needs to synthesize
    // onMouseEnter. A hand-fired `fireEvent.mouseEnter` is a non-bubbling event
    // that React's enter/leave delegation may never see — it happened to pass in
    // a full-file run and failed both in isolation and on CI's ubuntu runner.
    render(<Harness />)
    await openMenu()
    const highlighted = () => rows().filter((r) => r.className.includes("bg-[var(--color-accent)]"))
    expect(highlighted()).toHaveLength(1)
    await userEvent.hover(rows()[2])
    await waitFor(() => expect(highlighted()[0]).toHaveTextContent("/markdown-exporter"))
    expect(highlighted()).toHaveLength(1)
  })

  it("reopens on the first row, not wherever the arrows last stopped", async () => {
    // For a bare "/" the query is "" — which is also the query while the menu is
    // closed — so a reset keyed on the query alone never fires across a
    // close/reopen, and the menu comes back selected on an off-screen row.
    render(<Harness />)
    await openMenu()
    const highlighted = () => rows().filter((r) => r.className.includes("bg-[var(--color-accent)]"))
    // Plain presses are safe again: openMenu() does not return until a key has
    // been observed to land.
    fireEvent.keyDown(textarea(), { key: "ArrowDown" })
    fireEvent.keyDown(textarea(), { key: "ArrowDown" })
    await waitFor(() => expect(highlighted()[0]).toHaveTextContent("/markdown-exporter"))

    fireEvent.change(textarea(), { target: { value: "" } })
    await waitFor(() => expect(rows()).toHaveLength(0))
    await openMenu()
    // waitFor, not a bare assert: openMenu only waits for the ROWS, and the
    // selection reset lands in a later effect tick. Asserting synchronously
    // passed locally and flaked on CI (seen on ubuntu and macos runners) —
    // the sibling assertion above is already written this way for the same
    // reason.
    await waitFor(() => expect(highlighted()[0]).toHaveTextContent("/deckcraft"))
  })

  it("fills the composer on click", async () => {
    render(<Harness />)
    await openMenu()
    fireEvent.click(rows()[1])
    await waitFor(() => expect(textarea().value).toBe("/doc-edit "))
  })
})

describe("CommandSelector — regressions", () => {
  // discussions/056 §2.1: "text starts with /" was treated as "the menu owns
  // Enter", so a non-matching /word could never be sent — Enter neither sent
  // nor was prevented, which in a real browser just inserts a newline, and the
  // trigger condition still held. A permanent dead end.
  it("D: Enter sends a /word that matches no command", async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    await openMenu()
    fireEvent.change(textarea(), { target: { value: "/zzzzz" } })
    await waitFor(() => expect(rows()).toHaveLength(0))
    fireEvent.keyDown(textarea(), { key: "Enter" })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it("D: Enter still picks the highlighted command when the menu has matches", async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    await openMenu("/deck")
    fireEvent.keyDown(textarea(), { key: "Enter" })
    await waitFor(() => expect(textarea().value).toBe("/deckcraft "))
    expect(onSend).not.toHaveBeenCalled()
  })

  // discussions/056 §2.2: closing the menu used to delete the user's "/".
  it("E: Escape closes the menu without touching the typed text", async () => {
    render(<Harness />)
    await openMenu("/deck")
    fireEvent.keyDown(textarea(), { key: "Escape" })
    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(textarea().value).toBe("/deck")
  })

  it("E: a dismissed menu stays closed while typing, and re-arms once the slash is gone", async () => {
    render(<Harness />)
    await openMenu("/deck")
    fireEvent.keyDown(textarea(), { key: "Escape" })
    await waitFor(() => expect(rows()).toHaveLength(0))

    fireEvent.change(textarea(), { target: { value: "/deckc" } })
    expect(rows()).toHaveLength(0)

    // Clearing the trigger re-arms it.
    fireEvent.change(textarea(), { target: { value: "hello" } })
    fireEvent.change(textarea(), { target: { value: "/" } })
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))
  })

  it("E: Escape is available in the empty state too", async () => {
    render(<Harness />)
    await openMenu()
    fireEvent.change(textarea(), { target: { value: "/zzzzz" } })
    await waitFor(() => expect(screen.getByText("command.noMatch")).toBeInTheDocument())
    fireEvent.keyDown(textarea(), { key: "Escape" })
    await waitFor(() => expect(screen.queryByText("command.noMatch")).toBeNull())
    expect(textarea().value).toBe("/zzzzz")
  })

  // Found on the real machine (discussions/056 §8.4): with a Chinese IME active,
  // typing "/de" opens the menu WHILE the input method is still composing. Enter
  // then commits the candidate and the arrows walk the candidate list — keys the
  // menu must not touch, or the user's half-typed Chinese is replaced by a command.
  describe("IME composition", () => {
    it("does not hijack Enter while an input method is composing", async () => {
      render(<Harness />)
      await openMenu("/de")
      fireEvent.compositionStart(textarea())
      fireEvent.keyDown(textarea(), { key: "Enter" })
      // Composition owns this Enter: no command was picked.
      expect(textarea().value).toBe("/de")
    })

    it("does not hijack the arrow keys while composing (they walk IME candidates)", async () => {
      render(<Harness />)
      await openMenu("/d")
      const highlighted = () => rows().filter((r) => r.className.includes("bg-[var(--color-accent)]"))
      const before = highlighted()[0].textContent
      fireEvent.compositionStart(textarea())
      fireEvent.keyDown(textarea(), { key: "ArrowDown" })
      expect(highlighted()[0].textContent).toBe(before)
    })

    it("honours the legacy keyCode 229 signal too", async () => {
      render(<Harness />)
      await openMenu("/de")
      fireEvent.keyDown(textarea(), { key: "Enter", keyCode: 229 })
      expect(textarea().value).toBe("/de")
    })

    it("resumes owning Enter once composition ends", async () => {
      render(<Harness />)
      await openMenu("/deck")
      fireEvent.compositionStart(textarea())
      fireEvent.compositionEnd(textarea())
      await waitFor(() => {
        fireEvent.keyDown(textarea(), { key: "Enter" })
        expect(textarea().value).toBe("/deckcraft ")
      })
    })
  })

  it("stays closed for a backend that never receives these commands", async () => {
    render(<Harness commandsEnabled={false} />)
    fireEvent.change(textarea(), { target: { value: "/" } })
    await waitFor(() => expect(textarea().value).toBe("/"))
    expect(rows()).toHaveLength(0)
    expect(screen.queryByText("command.group.skill")).toBeNull()
  })
})
