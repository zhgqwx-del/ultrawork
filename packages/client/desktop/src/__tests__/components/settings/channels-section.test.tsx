import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ workspacePath: "/tmp/ws" }),
}))

// Stable module-level mock state (gotchas §13: the hook must return stable
// references across renders, or effect deps churn forever).
const mockChannels = [
  { id: "c1", type: "dingtalk", name: "My DingTalk", state: "connected", connectedAt: "2026-07-07T11:24:30.000Z" },
  { id: "c2", type: "wechat", name: "My WeChat", state: "disconnected" },
]
const mockConfigs = [{ id: "c1", type: "dingtalk", name: "My DingTalk", workspaceDir: "/tmp/ws" }]
const mockApi = {
  channels: mockChannels,
  configs: mockConfigs,
  loading: false,
  error: null,
  actionLoading: null,
  handleAdd: vi.fn(),
  handleRemove: vi.fn(),
  handleConnect: vi.fn(),
  handleDisconnect: vi.fn(),
  refresh: vi.fn(),
  requestChannelQR: vi.fn(async () => ({ token: "qr_1", qrContent: "https://qr.example/x" })),
  // Stays pending forever — enough for open/close UI assertions
  pollChannelQRStatus: vi.fn(async () => ({ status: "pending" })),
  cancelChannelQR: vi.fn(async () => {}),
}
vi.mock("@/lib/use-channels", () => ({
  useChannels: () => mockApi,
}))

import { ChannelsSection } from "@/components/settings/channels-section"

describe("ChannelsSection (moved out of Settings.tsx)", () => {
  it("renders channel cards with name, type badge and brand icon", () => {
    const { container } = render(<ChannelsSection />)
    expect(screen.getByText("My DingTalk")).toBeInTheDocument()
    expect(screen.getByText("My WeChat")).toBeInTheDocument()
    // dynamic type badge keys survive the move
    expect(screen.getByText("channel.type.dingtalk")).toBeInTheDocument()
    // brand icons mapped by channel.type
    expect(container.querySelector('svg[data-brand="dingtalk"]')).not.toBeNull()
    expect(container.querySelector('svg[data-brand="wechat"]')).not.toBeNull()
  })

  it("shows the connected-count pill and workspace dir from configs", () => {
    render(<ChannelsSection />)
    expect(screen.getByText(/channel\.connected/)).toBeInTheDocument()
    expect(screen.getByText(/ws$/)).toBeInTheDocument()
  })

  it("offers dingtalk, wechat and wecom entries (with brand icons) in the add dropdown", async () => {
    render(<ChannelsSection />)
    const trigger = screen.getByText("channel.addChannel")
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.pointerUp(trigger, { button: 0 })
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual([
      "channel.type.dingtalk",
      "channel.type.wechat",
      "channel.type.wecom",
    ])
    for (const item of items) {
      expect(item.querySelector("svg[data-brand]")).not.toBeNull()
    }
  })

  it("dingtalk opens the QR flow (device flow) with a manual-input fallback to the form", async () => {
    render(<ChannelsSection />)
    const trigger = screen.getByText("channel.addChannel")
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.pointerUp(trigger, { button: 0 })
    const items = await screen.findAllByRole("menuitem")
    fireEvent.click(items[0]) // dingtalk

    // QR flow opens (not the clientId/Secret form), starts a dingtalk session
    expect(await screen.findByText("channel.qr.scanTitle")).toBeInTheDocument()
    expect(screen.getByText("channel.qr.autoCreateHint")).toBeInTheDocument()
    expect(screen.getByText("channel.qr.manualInput")).toBeInTheDocument()
    expect(mockApi.requestChannelQR).toHaveBeenCalledWith("dingtalk", expect.any(String), "/tmp/ws")

    // Manual fallback cancels the QR session and shows the credentials form
    fireEvent.click(screen.getByText("channel.qr.manualInput"))
    expect(await screen.findByText("channel.clientId")).toBeInTheDocument()
    expect(mockApi.cancelChannelQR).toHaveBeenCalledWith("dingtalk", "qr_1")
  })

  it("wecom opens the QR flow with manual fallback to the botId/secret form", async () => {
    render(<ChannelsSection />)
    const trigger = screen.getByText("channel.addChannel")
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.pointerUp(trigger, { button: 0 })
    const items = await screen.findAllByRole("menuitem")
    fireEvent.click(items[2]) // wecom

    expect(await screen.findByText("channel.qr.scanTitle")).toBeInTheDocument()
    expect(mockApi.requestChannelQR).toHaveBeenCalledWith("wecom", expect.any(String), "/tmp/ws")

    fireEvent.click(screen.getByText("channel.qr.manualInput"))
    // wecom manual form asks for botId/secret, not dingtalk's clientId
    expect(await screen.findByText("channel.botId")).toBeInTheDocument()
    expect(screen.getByText("channel.secret")).toBeInTheDocument()
    expect(screen.queryByText("channel.clientId")).toBeNull()
  })

  it("wechat QR flow has no browser/manual escape hatches (app-only QR)", async () => {
    render(<ChannelsSection />)
    const trigger = screen.getByText("channel.addChannel")
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.pointerUp(trigger, { button: 0 })
    const items = await screen.findAllByRole("menuitem")
    fireEvent.click(items[1]) // wechat

    expect(await screen.findByText("channel.qr.scanTitle")).toBeInTheDocument()
    expect(screen.queryByText("channel.qr.manualInput")).toBeNull()
    expect(screen.queryByText("channel.qr.openInBrowser")).toBeNull()
    expect(screen.queryByText("channel.qr.autoCreateHint")).toBeNull()
  })
})
