import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * Every place the desktop starts a turn must put the session on the notification
 * allowlist — otherwise that turn silently completes forever.
 *
 * This is not paranoia: the first implementation registered only inside the composer's
 * `sendMessage`, and Home's "ask something and walk away" (a NEW session's first turn —
 * the single most common path there is) calls `connector.prompt` directly. It shipped
 * completely silent, and a real packaged-app run is what caught it. A unit test on the
 * decision layer could never have: the decision layer was right, nobody called it.
 *
 * So the guard is on the SOURCE: a file that starts turns must also register them.
 */

// vitest runs with the desktop package as cwd (vitest.config.ts lives there).
const SRC = join(process.cwd(), "src")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === "__tests__" || name === "probe") return []
    if (statSync(path).isDirectory()) return walk(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/**
 * Import lines are stripped before matching. The first version of this guard did not,
 * so `import { markLocallyPrompted }` alone satisfied it — deleting the actual call
 * left the test green. A guard that cannot fail is worse than no guard: it certifies.
 */
function bodyOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line))
    .join("\n")
}

describe("notification allowlist coverage", () => {
  it("every file that calls connector.prompt() also CALLS markLocallyPrompted()", () => {
    const offenders = walk(SRC)
      .filter((path) => {
        const body = bodyOf(path)
        return /\.prompt\(/.test(body) && !/markLocallyPrompted\s*\(/.test(body)
      })
      .map((path) => relative(SRC, path))

    expect(offenders).toEqual([])
  })

  it("finds the prompt call sites at all (the guard itself is not vacuous)", () => {
    // Without this, deleting/renaming `prompt` would make the test above pass by
    // finding nothing — the exact failure mode it is supposed to catch.
    const callers = walk(SRC).filter((path) => /\.prompt\(/.test(readFileSync(path, "utf8")))
    expect(callers.length).toBeGreaterThanOrEqual(2)
  })
})
