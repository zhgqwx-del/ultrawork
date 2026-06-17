import { describe, it, expect, vi, beforeAll } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))
vi.mock("@/lib/config-context", () => ({
  useConfig: () => ({ config: { language: "en" }, updateConfig: vi.fn() }),
}))

import { SettingsPopover } from "@/components/settings/settings-popover"

// radix relies on pointer-capture APIs that jsdom doesn't implement
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
    Element.prototype.setPointerCapture = () => {}
    Element.prototype.releasePointerCapture = () => {}
  }
})

function openMenu() {
  render(
    <SettingsPopover>
      <button>trigger</button>
    </SettingsPopover>
  )
  // radix DropdownMenu opens on pointerdown (left button), not click
  const trigger = screen.getByText("trigger")
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.pointerUp(trigger, { button: 0 })
}

describe("SettingsPopover menu structure", () => {
  it("keeps only the two intended groups of items", async () => {
    openMenu()
    // Group 1: general, language, workspace — Group 2: help, about
    for (const key of [
      "settingsPopover.general",
      "settingsPopover.language",
      "settingsPopover.workspace",
      "settingsPopover.help",
      "settingsPopover.about",
    ]) {
      expect(await screen.findByText(key)).toBeInTheDocument()
    }
  })

  it("no longer exposes the items that moved into the settings page", async () => {
    openMenu()
    await screen.findByText("settingsPopover.general") // ensure menu is open
    for (const key of [
      "settingsPopover.models",
      "settingsPopover.channels",
      "settingsPopover.remote",
      "settingsPopover.skills",
    ]) {
      expect(screen.queryByText(key)).toBeNull()
    }
  })
})
