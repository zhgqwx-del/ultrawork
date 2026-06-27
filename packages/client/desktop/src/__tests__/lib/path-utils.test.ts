import { describe, it, expect } from "vitest"
import { pathBasename, isAbsolutePath, shortenPath } from "@/lib/path-utils"

describe("pathBasename", () => {
  it("extracts the last segment of POSIX paths", () => {
    expect(pathBasename("/Users/alice/projects/repo")).toBe("repo")
    expect(pathBasename("/var/log/system.log")).toBe("system.log")
    expect(pathBasename("report.pdf")).toBe("report.pdf")
  })

  it("extracts the last segment of Windows paths", () => {
    expect(pathBasename("C:\\Users\\alice\\repo")).toBe("repo")
    expect(pathBasename("C:\\Users\\alice\\report.pdf")).toBe("report.pdf")
    // Mixed separators (Windows tolerates forward slashes too)
    expect(pathBasename("C:/Users/alice/repo")).toBe("repo")
  })

  it("tolerates trailing separators", () => {
    expect(pathBasename("/Users/alice/repo/")).toBe("repo")
    expect(pathBasename("C:\\Users\\alice\\repo\\")).toBe("repo")
  })

  it("returns the input unchanged when empty", () => {
    expect(pathBasename("")).toBe("")
  })
})

describe("isAbsolutePath", () => {
  it("recognizes POSIX absolute paths", () => {
    expect(isAbsolutePath("/Users/alice")).toBe(true)
    expect(isAbsolutePath("relative/path")).toBe(false)
    expect(isAbsolutePath("file.txt")).toBe(false)
  })

  it("recognizes Windows drive-letter and UNC paths", () => {
    expect(isAbsolutePath("C:\\Users\\alice")).toBe(true)
    expect(isAbsolutePath("D:/data")).toBe(true)
    expect(isAbsolutePath("\\\\server\\share")).toBe(true)
    expect(isAbsolutePath("Users\\alice")).toBe(false)
  })
})

describe("shortenPath", () => {
  it("replaces POSIX home with ~ and folds long paths", () => {
    expect(shortenPath("/Users/alice/a/b/c/d", { homedir: "/Users/alice" })).toBe("~/a/.../d")
  })

  it("returns short paths unchanged", () => {
    expect(shortenPath("/Users/alice", { homedir: "/Users/alice" })).toBe("~")
  })

  it("folds Windows paths preserving the backslash separator", () => {
    const out = shortenPath("C:\\Users\\bob\\a\\b\\c\\d", { homedir: "C:\\Users\\bob" })
    expect(out).toBe("~\\a\\...\\d")
  })

  it("auto-detects Windows home directory", () => {
    expect(shortenPath("C:\\Users\\bob\\project")).toBe("~\\project")
  })
})
