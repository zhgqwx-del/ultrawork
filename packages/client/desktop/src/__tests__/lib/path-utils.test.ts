import { describe, it, expect } from "vitest"
import { pathBasename, isAbsolutePath, shortenPath, toWorkspaceRelative } from "@/lib/path-utils"

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

describe("toWorkspaceRelative", () => {
  const ws = "/Users/z/.ultrawork/workspace"

  it("strips the workspace prefix from an absolute path inside it", () => {
    expect(toWorkspaceRelative(`${ws}/octopus.svg`, ws)).toBe("octopus.svg")
    expect(toWorkspaceRelative(`${ws}/sub/dir/a.png`, ws)).toBe("sub/dir/a.png")
  })

  it("tolerates a trailing separator on the workspace dir", () => {
    expect(toWorkspaceRelative(`${ws}/a.svg`, `${ws}/`)).toBe("a.svg")
  })

  it("keeps a relative path as-is (normalizing a leading ./)", () => {
    expect(toWorkspaceRelative("orca_preview.png", ws)).toBe("orca_preview.png")
    expect(toWorkspaceRelative("./chart.svg", ws)).toBe("chart.svg")
    // A leading "/" is a POSIX-absolute path (root), i.e. outside the workspace.
    expect(toWorkspaceRelative("/chart.svg", ws)).toBeNull()
  })

  it("returns null for an absolute path outside the workspace", () => {
    expect(toWorkspaceRelative("/etc/passwd", ws)).toBeNull()
    expect(toWorkspaceRelative("/Users/z/other/a.svg", ws)).toBeNull()
    // A sibling dir that shares a prefix but is not inside the workspace.
    expect(toWorkspaceRelative("/Users/z/.ultrawork/workspace-evil/a.svg", ws)).toBeNull()
  })

  it("refuses parent-directory traversal in a relative path", () => {
    expect(toWorkspaceRelative("../secret.png", ws)).toBeNull()
    expect(toWorkspaceRelative("sub/../../secret.png", ws)).toBeNull()
  })

  it("returns null for empty / dir-equal inputs", () => {
    expect(toWorkspaceRelative("", ws)).toBeNull()
    expect(toWorkspaceRelative(ws, ws)).toBeNull()
    expect(toWorkspaceRelative("a.svg", "")).toBe("a.svg") // relative needs no dir
    expect(toWorkspaceRelative("/abs/a.svg", "")).toBeNull() // absolute needs a dir
  })

  it("handles Windows workspace + absolute paths", () => {
    const win = "C:\\Users\\z\\ws"
    expect(toWorkspaceRelative("C:\\Users\\z\\ws\\a.svg", win)).toBe("a.svg")
    expect(toWorkspaceRelative("C:\\Users\\z\\other\\a.svg", win)).toBeNull()
  })
})
