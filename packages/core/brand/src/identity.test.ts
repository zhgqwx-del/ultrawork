import { describe, expect, it } from "vitest"
import { assistantIdentityPrompt, DEFAULT_BRAND, packageSlug, parseBrandIdentity, resolveIdentity, validateBrandId } from "./index"

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
  it.each(["ultrawork", "desktop", "opencode", "codex", "../foo", "a/b", "AName", "a", "con", "com1", "a--b", "a-", "foo.bar", "mywork\n", "mywork\r\n"])("rejects unsafe/reserved namespace %s", (id) => {
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
  it("uses the canonical product name for the host without replacing the external agent identity", () => {
    expect(assistantIdentityPrompt()).toContain('The host application is "Ultrawork"')
    const identity = resolveIdentity({ brandId: "mywork", productName: "MyWork" })
    const prompt = assistantIdentityPrompt(identity)
    expect(prompt).toContain('The host application is "MyWork"')
    expect(prompt).toContain("Preserve your underlying agent/model identity, capabilities, assigned role, and tool instructions")
    expect(prompt).toContain('introduce yourself as the assistant of "MyWork"')
    expect(prompt).toContain("single-agent, Team Leader, and member roles")
    expect(prompt).toContain("language of the latest user question")
    expect(prompt).toContain("following any explicit language request in that question")
    expect(prompt).toContain("not from workspace names, file paths, tool descriptions, or Team instructions")
    expect(prompt).toContain("does not add requirements to the user's task")
    expect(prompt).toContain("unless the user specifically requests that content in that output")
    expect(prompt).toContain("If the user explicitly asks which external agent or model is executing the task, answer truthfully")
    expect(prompt).not.toContain("Ultrawork")
    expect(prompt).not.toContain(identity.identifier)
    expect(assistantIdentityPrompt(identity)).toBe(prompt)
  })
  it("validates identity before constructing host guidance and quotes product data", () => {
    const identity = resolveIdentity({ brandId: "research", productName: "R&D's Work" })
    expect(assistantIdentityPrompt(identity)).toContain(JSON.stringify(identity.productName))
    expect(() => assistantIdentityPrompt({ ...identity, namespace: "other" })).toThrow()
  })
})
