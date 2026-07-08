import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { WeChatIcon, WeComIcon, DingTalkIcon, FeishuIcon } from "@/components/brand-icons"

const CASES = [
  { name: "WeChatIcon", Comp: WeChatIcon, brand: "wechat", color: "#07C160" },
  { name: "WeComIcon", Comp: WeComIcon, brand: "wecom", color: "#0082EF" },
  { name: "DingTalkIcon", Comp: DingTalkIcon, brand: "dingtalk", color: "#0089FF" },
  { name: "FeishuIcon", Comp: FeishuIcon, brand: "feishu", color: "#3370FF" },
] as const

describe("brand icons", () => {
  for (const { name, Comp, brand, color } of CASES) {
    it(`${name} renders an inline svg badge carrying the ${brand} brand color`, () => {
      const { container } = render(<Comp className="size-5" />)
      const svg = container.querySelector(`svg[data-brand="${brand}"]`)
      expect(svg).not.toBeNull()
      // decorative: hidden from a11y tree, sized via className
      expect(svg!.getAttribute("aria-hidden")).toBe("true")
      expect(svg!.getAttribute("class")).toContain("size-5")
      // brand color present on either the badge circle (positive glyphs) or
      // the knockout path (negative glyphs)
      expect(svg!.innerHTML).toContain(color)
    })
  }

  it("knockout-style icons (dingtalk/wecom) keep a white disc underlay for dark mode", () => {
    for (const Comp of [DingTalkIcon, WeComIcon]) {
      const { container } = render(<Comp />)
      const circle = container.querySelector("circle")
      expect(circle?.getAttribute("fill")).toBe("#fff")
    }
  })
})
