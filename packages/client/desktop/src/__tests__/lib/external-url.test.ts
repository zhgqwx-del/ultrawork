import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ openUrl: vi.fn(() => Promise.resolve()) }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }))

import { isOpenableUrl, openExternal } from "@/lib/external-url"

describe("isOpenableUrl", () => {
  it("accepts the schemes we are willing to hand to the OS", () => {
    expect(isOpenableUrl("https://example.com/a?b=1#c")).toBe(true)
    expect(isOpenableUrl("http://example.com")).toBe(true)
    expect(isOpenableUrl("mailto:a@b.com")).toBe(true)
    expect(isOpenableUrl("tel:+8613800138000")).toBe(true)
  })

  // The transcript renders model output, and model output is steerable by fetched
  // pages and (via the IM channels) by third parties. `openUrl` shells out to the
  // system handler, so a scheme that escapes this list is not "a link" — it is a
  // way to launch a local app or file.
  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["file:///etc/passwd"],
    ["vbscript:msgbox(1)"],
    ["ms-msdt:/id"],
    ["feishu://open"],
    ["itms-services://?action=download-manifest"],
  ])("refuses %s", (href) => {
    expect(isOpenableUrl(href)).toBe(false)
  })

  it("refuses relative paths, anchors and malformed input (nothing for the OS to open)", () => {
    expect(isOpenableUrl("./report.pdf")).toBe(false)
    expect(isOpenableUrl("../a/b.md")).toBe(false)
    expect(isOpenableUrl("report.pdf")).toBe(false)
    expect(isOpenableUrl("#section")).toBe(false)
    expect(isOpenableUrl("")).toBe(false)
    expect(isOpenableUrl(undefined)).toBe(false)
    expect(isOpenableUrl(null)).toBe(false)
  })

  it("is not fooled by a whitelisted scheme appearing later in the string", () => {
    expect(isOpenableUrl("javascript:void(location='https://evil.com')")).toBe(false)
    expect(isOpenableUrl("data:text/html,https://example.com")).toBe(false)
  })
})

describe("openExternal", () => {
  beforeEach(() => {
    h.openUrl.mockClear()
  })

  it("opens a whitelisted URL in the system browser", () => {
    openExternal("https://example.com")
    expect(h.openUrl).toHaveBeenCalledWith("https://example.com")
  })

  // The guard has to live at the call site, not only in the caller: a rejected
  // href must never reach `openUrl`, whatever asked for it.
  it("hands nothing to the OS for a rejected scheme", () => {
    openExternal("javascript:alert(1)")
    openExternal("file:///etc/passwd")
    openExternal("./report.pdf")
    openExternal(undefined)
    expect(h.openUrl).not.toHaveBeenCalled()
  })
})
