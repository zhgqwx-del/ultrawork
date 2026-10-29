import { describe, expect, it } from "vitest"
import { DEFAULT_BRAND, packageSlug, parseBrandIdentity, resolveIdentity, validateBrandId } from "./index"

describe("brand identity", () => {
  it("preserves the existing default identity without a binary rename", () => {
    expect(resolveIdentity()).toEqual({ schemaVersion: 1, brandId: "ultrawork", productName: "Ultrawork", identifier: "com.ultrawork.desktop", namespace: "ultrawork", isDefault: true })
    expect(parseBrandIdentity(DEFAULT_BRAND)).toBe(DEFAULT_BRAND)
  })
  it("derives a stable, separate MyWork identity", () => {
    expect(resolveIdentity({ brandId: "mywork", productName: "MyWork" })).toMatchObject({ namespace: "mywork", identifier: "com.ultrawork.mywork", mainBinaryName: "mywork", isDefault: false })
    expect(packageSlug("MyWork")).toBe("my-work")
    expect(packageSlug("My Work")).toBe("my-work")
  })
  it.each(["ultrawork", "desktop", "opencode", "codex", "../foo", "a/b", "AName", "a", "con", "com1", "a--b", "a-", "foo.bar"])("rejects unsafe/reserved namespace %s", (id) => {
    expect(() => validateBrandId(id)).toThrow()
  })
  it.each(["Ultrawork", "Ultrawork Dev", " bad", "bad.", "bad/name", "bad\\name", "con", "a\u0000b"])("rejects unsafe/conflicting product %s", (productName) => {
    expect(() => resolveIdentity({ brandId: "test-brand", productName })).toThrow()
  })
  it("rejects identity tampering rather than trusting a foreign path or identifier", () => {
    const identity = resolveIdentity({ brandId: "mywork", productName: "MyWork" })
    expect(() => parseBrandIdentity({ ...identity, namespace: "ultrawork" })).toThrow()
    expect(() => parseBrandIdentity({ ...identity, identifier: "com.ultrawork.desktop" })).toThrow()
    expect(() => parseBrandIdentity({ ...DEFAULT_BRAND, productName: "MyWork" })).toThrow()
  })
})
