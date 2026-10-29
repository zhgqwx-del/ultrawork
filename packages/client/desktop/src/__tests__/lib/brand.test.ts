import { describe, expect, it } from "vitest"
import { DEFAULT_BRAND, resolveIdentity } from "@agent/brand"
import { brandTranslation } from "@/lib/brand"
import { en, zhHans } from "@/lib/i18n-translations"

const mywork = resolveIdentity({ brandId: "mywork", productName: "MyWork" })

describe("product branding", () => {
  it("keeps default copy and original casing byte-for-byte", () => {
    for (const dictionary of [en, zhHans]) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(brandTranslation(key, value, DEFAULT_BRAND)).toBe(value)
      }
    }
  })

  it("brands product copy and leaves attribution and filesystem names alone", () => {
    expect(brandTranslation("brand.name", en["brand.name"], mywork)).toBe("MyWork")
    expect(brandTranslation("tray.open", en["tray.open"], mywork)).toBe("Open MyWork")
    expect(brandTranslation("screenshot.staleGrant", zhHans["screenshot.staleGrant"], mywork)).toContain("MyWork")
    expect(brandTranslation("about.copyrightValue", en["about.copyrightValue"], mywork)).toBe(en["about.copyrightValue"])
    expect(brandTranslation("about.licenseValue", en["about.licenseValue"], mywork)).toBe(en["about.licenseValue"])
    expect(brandTranslation("some.path", "~/.ultrawork", mywork)).toBe("~/.ultrawork")
  })

  it("treats replacement metacharacters in product names as literal text", () => {
    const brand = { ...mywork, productName: "My$&Work" }
    expect(brandTranslation("tray.quit", "Quit Ultrawork", brand)).toBe("Quit My$&Work")
  })
})
