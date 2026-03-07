import { describe, it, expect } from "vitest"
import { cn } from "@/lib/utils"

describe("cn()", () => {
  it("merges basic class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar")
  })

  it("handles conditional classes", () => {
    expect(cn("base", true && "active", false && "hidden")).toBe("base active")
  })

  it("resolves tailwind conflicts (last wins)", () => {
    const result = cn("p-4", "p-2")
    expect(result).toBe("p-2")
  })

  it("resolves text color conflicts", () => {
    const result = cn("text-red-500", "text-blue-500")
    expect(result).toBe("text-blue-500")
  })

  it("handles undefined and null", () => {
    expect(cn("foo", undefined, null, "bar")).toBe("foo bar")
  })

  it("handles empty string", () => {
    expect(cn("foo", "", "bar")).toBe("foo bar")
  })

  it("handles no arguments", () => {
    expect(cn()).toBe("")
  })

  it("handles clsx array syntax", () => {
    expect(cn(["foo", "bar"])).toBe("foo bar")
  })

  it("handles clsx object syntax", () => {
    expect(cn({ active: true, disabled: false })).toBe("active")
  })
})
