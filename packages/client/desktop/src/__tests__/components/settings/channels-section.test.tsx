import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

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
  requestWeChatQR: vi.fn(),
  pollWeChatQRStatus: vi.fn(),
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

  it("offers dingtalk and wechat entries (with brand icons) in the add dropdown", async () => {
    render(<ChannelsSection />)
    const trigger = screen.getByText("channel.addChannel")
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.pointerUp(trigger, { button: 0 })
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["channel.type.dingtalk", "channel.type.wechat"])
    for (const item of items) {
      expect(item.querySelector("svg[data-brand]")).not.toBeNull()
    }
  })
})
