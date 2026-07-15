import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { I18nProvider, useI18n } from "@/lib/i18n-context"

// Render through the REAL I18nProvider + real translations (not a reimplemented
// createT) to prove the end-to-end wiring: language → correct dictionary →
// Traditional/Simplified/English text, plus param interpolation. (ADR-058)
//
// I18nProvider reads useConfig(); stub it with a controllable language.
const cfg = vi.hoisted(() => ({ language: "en" as string }))
vi.mock("@/lib/config-context", () => ({
  useConfig: () => ({ config: { language: cfg.language }, updateConfig: vi.fn() }),
}))

function Probe() {
  const { t } = useI18n()
  return (
    <div>
      <span data-testid="theme">{t("general.theme.system")}</span>
      <span data-testid="notify">{t("notify.completed", { title: "任务A" })}</span>
    </div>
  )
}

function renderAt(language: string) {
  cfg.language = language
  return render(
    <I18nProvider>
      <Probe />
    </I18nProvider>,
  )
}

describe("i18n end-to-end render", () => {
  it("zh-Hant renders Traditional through the real t()", () => {
    renderAt("zh-Hant")
    expect(screen.getByTestId("theme").textContent).toBe("跟隨系統")
    // Traditional + interpolation both applied.
    expect(screen.getByTestId("notify").textContent).toBe("「任务A」已完成。")
  })

  it("zh-Hans renders Simplified", () => {
    renderAt("zh-Hans")
    expect(screen.getByTestId("theme").textContent).toBe("跟随系统")
  })

  it("en renders English", () => {
    renderAt("en")
    expect(screen.getByTestId("theme").textContent).toBe("System")
  })

  it("an unknown language falls back to the key (never throws)", () => {
    renderAt("xx")
    expect(screen.getByTestId("theme").textContent).toBe("general.theme.system")
  })
})
