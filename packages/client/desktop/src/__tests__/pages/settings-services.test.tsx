import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// t returns the key verbatim so we can assert on i18n keys directly.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))

// Stable module-level hook returns (gotchas §13: a hook that returns a fresh
// object each render churns effect deps). Fields are mutated per test, then
// reset in beforeEach — identity of the returned object stays stable.
const mcpApi = {
  statusMap: {} as Record<string, { status: string }>,
  configMap: {} as Record<string, unknown>,
  loading: false,
  error: null as string | null,
  actionLoading: null as string | null,
  handleToggle: vi.fn(),
  handleAdd: vi.fn(),
  handleRemove: vi.fn(),
  refresh: vi.fn(async () => {}),
}
const cliApi = {
  statuses: {} as Record<string, { state: string }>,
  checking: false,
  phases: {} as Record<string, string>,
  errors: {} as Record<string, string | null>,
  pendingUrls: {} as Record<string, string | null>,
  refresh: vi.fn(async () => {}),
  install: vi.fn(),
  configure: vi.fn(),
  authorize: vi.fn(),
}
const browserApi = {
  nodeAvailable: true,
  nodeVersion: "v20",
  nodeEmbedded: false,
  chromeAvailable: true,
  installed: false,
  installing: false,
  error: null,
  setup: vi.fn(),
  checking: false,
  mode: "embedded",
  switchMode: vi.fn(),
  switchingMode: false,
}
vi.mock("@/lib/use-mcp-servers", () => ({ useMCPServers: () => mcpApi }))
vi.mock("@/lib/use-cli-connectors", () => ({ useCliConnectors: () => cliApi }))
vi.mock("@/lib/use-browser-mcp", () => ({ useBrowserMCP: () => browserApi }))

import { ServicesSection } from "@/pages/Settings"

beforeEach(() => {
  vi.clearAllMocks()
  mcpApi.statusMap = {}
  cliApi.statuses = {}
})

describe("ServicesSection connector tabs", () => {
  it("defaults to the MCP tab; office CLI cards are not mounted", () => {
    render(<ServicesSection />)

    // MCP body is active: its empty state is visible
    expect(screen.getByText("mcp.noServers")).toBeInTheDocument()

    // Two tab triggers, in registry order (MCP, Office CLI). The trailing digit
    // is the entry-count badge: no MCP server configured, three office CLIs
    // ship built-in.
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((el) => el.textContent)).toEqual([
      "services.groupMcp0",
      "services.groupOfficeCli3",
    ])

    // Inactive office-cli content is unmounted — MCP state can't leak into it
    expect(screen.queryByText("cliConnector.lark.title")).toBeNull()
  })

  it("switches to the office CLI tab and renders all three connector cards", async () => {
    const user = userEvent.setup()
    render(<ServicesSection />)

    await user.click(screen.getByRole("tab", { name: /groupOfficeCli/ }))

    expect(await screen.findByText("cliConnector.lark.title")).toBeInTheDocument()
    expect(screen.getByText("cliConnector.dingtalk.title")).toBeInTheDocument()
    expect(screen.getByText("cliConnector.wecom.title")).toBeInTheDocument()

    // MCP empty state does not leak into the CLI tab. forceMount keeps the MCP
    // panel in the DOM but its Radix panel is inactive (hidden in the real
    // browser via `data-[state=inactive]:hidden`; jsdom has no Tailwind CSS).
    expect(screen.getByText("mcp.noServers").closest('[role="tabpanel"]')).toHaveAttribute("data-state", "inactive")
  })

  it("honors the initialTab deep-link by opening the office CLI tab directly", () => {
    render(<ServicesSection initialTab="office-cli" />)

    expect(screen.getByText("cliConnector.lark.title")).toBeInTheDocument()
    // forceMount keeps the MCP panel in the DOM but its Radix panel is inactive
    // (hidden in the real browser via `data-[state=inactive]:hidden`; jsdom has
    // no Tailwind CSS, so assert the state attribute the hiding keys off).
    expect(screen.getByText("mcp.noServers").closest('[role="tabpanel"]')).toHaveAttribute("data-state", "inactive")
  })

  it("falls back to the MCP tab for an unknown initialTab value", () => {
    render(<ServicesSection initialTab="bogus" />)

    expect(screen.getByText("mcp.noServers")).toBeInTheDocument()
    expect(screen.queryByText("cliConnector.lark.title")).toBeNull()
  })

  it("keeps the add-server dropdown in the MCP tab toolbar", async () => {
    render(<ServicesSection />)
    // Both the toolbar trigger and the empty-state button carry this label;
    // the toolbar one is first in DOM order.
    const triggers = screen.getAllByRole("button", { name: /mcp\.addServer/ })
    fireEvent.pointerDown(triggers[0], { button: 0 })
    fireEvent.pointerUp(triggers[0], { button: 0 })
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["mcp.addManual", "mcp.addJsonImport"])
  })

  it("preserves in-flight MCP add-form input across a tab round-trip (forceMount keep-alive)", async () => {
    const user = userEvent.setup()
    render(<ServicesSection />)

    // Open the manual add form in the MCP tab and type a name
    const triggers = screen.getAllByRole("button", { name: /mcp\.addServer/ })
    fireEvent.pointerDown(triggers[0], { button: 0 })
    fireEvent.pointerUp(triggers[0], { button: 0 })
    fireEvent.click(await screen.findByRole("menuitem", { name: "mcp.addManual" }))
    const nameInput = await screen.findByPlaceholderText("mcp.namePlaceholder")
    await user.type(nameInput, "my-server")
    expect(nameInput).toHaveValue("my-server")

    // Round-trip to the CLI tab and back
    await user.click(screen.getByRole("tab", { name: /groupOfficeCli/ }))
    await user.click(screen.getByRole("tab", { name: /groupMcp/ }))

    // Value survives: the MCP panel was kept mounted (forceMount), not destroyed
    expect(screen.getByPlaceholderText("mcp.namePlaceholder")).toHaveValue("my-server")
  })

  it("retargets the tab when initialTab changes on an already-mounted section", async () => {
    const { rerender } = render(<ServicesSection initialTab="mcp" />)
    expect(screen.getByText("mcp.noServers")).toBeInTheDocument()

    // Deep-link fires while the section is already mounted
    rerender(<ServicesSection initialTab="office-cli" />)
    expect(await screen.findByText("cliConnector.lark.title")).toBeInTheDocument()
    // forceMount keeps the MCP panel in the DOM but its Radix panel is inactive
    // (hidden in the real browser via `data-[state=inactive]:hidden`; jsdom has
    // no Tailwind CSS, so assert the state attribute the hiding keys off).
    expect(screen.getByText("mcp.noServers").closest('[role="tabpanel"]')).toHaveAttribute("data-state", "inactive")
  })

  // The header pill and the tab badges count DIFFERENT things on purpose: the
  // pill is connection state, the badges are entry counts (same meaning as the
  // Skills / Knowledge badges). These two tests pin that split apart.
  it("header pill counts connections; tab badges count entries, not connections", () => {
    // 0 MCP connected (1 configured) + 2 CLI connected (of 3 shipped)
    mcpApi.statusMap = { srvA: { status: "failed" } }
    cliApi.statuses = {
      lark: { state: "connected" },
      dingtalk: { state: "connected" },
    }
    render(<ServicesSection initialTab="office-cli" />)

    // Header pill sums connections across both categories
    const pill = screen.getByText(/services\.connected/)
    expect(pill.textContent?.replace(/\s+/g, " ").trim()).toBe("2 services.connected")

    const [mcpTab, cliTab] = screen.getAllByRole("tab")
    // Badge is the configured-server count (1), NOT the connected count (0)
    expect(mcpTab.textContent).toContain("1")
    // Badge is the shipped-CLI count (3), NOT the connected count (2)
    expect(cliTab.textContent).toContain("3")
  })

  it("counts the MCP term too: header sum + MCP tab badge (open on CLI tab to skip MCP cards)", () => {
    // 2 MCP connected + 1 CLI connected; render the CLI tab so MCP cards stay
    // unmounted while the MCP *tab badge* still reflects its entry count.
    mcpApi.statusMap = { srvA: { status: "connected" }, srvB: { status: "connected" } }
    cliApi.statuses = { lark: { state: "connected" } }
    render(<ServicesSection initialTab="office-cli" />)

    const pill = screen.getByText(/services\.connected/)
    expect(pill.textContent?.replace(/\s+/g, " ").trim()).toBe("3 services.connected")

    const [mcpTab, cliTab] = screen.getAllByRole("tab")
    expect(mcpTab.textContent).toContain("2")
    expect(cliTab.textContent).toContain("3")
  })

  it("global refresh reloads BOTH MCP and CLI connectors", async () => {
    const user = userEvent.setup()
    render(<ServicesSection />)

    await user.click(screen.getByRole("button", { name: /workspace\.refresh/ }))

    expect(mcpApi.refresh).toHaveBeenCalledTimes(1)
    expect(cliApi.refresh).toHaveBeenCalledTimes(1)
  })

  it("does not clobber a manual tab selection when the parent rerenders with the same initialTab", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ServicesSection initialTab="mcp" />)

    await user.click(screen.getByRole("tab", { name: /groupOfficeCli/ }))
    expect(await screen.findByText("cliConnector.lark.title")).toBeInTheDocument()

    // Unrelated parent rerender carrying the SAME initialTab must not snap back
    rerender(<ServicesSection initialTab="mcp" />)
    expect(screen.getByText("cliConnector.lark.title")).toBeInTheDocument()
    // forceMount keeps the MCP panel in the DOM but its Radix panel is inactive
    // (hidden in the real browser via `data-[state=inactive]:hidden`; jsdom has
    // no Tailwind CSS, so assert the state attribute the hiding keys off).
    expect(screen.getByText("mcp.noServers").closest('[role="tabpanel"]')).toHaveAttribute("data-state", "inactive")
  })
})
