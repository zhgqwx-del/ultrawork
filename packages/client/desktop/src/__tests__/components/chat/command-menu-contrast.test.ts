import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

/**
 * Machine gate for the `/` command menu's text contrast (discussions/056 §2.3).
 *
 * The menu shipped `--color-fg-muted` × `opacity-70` at 10px, which measures
 * 2.68:1 in light and 3.73:1 in dark — both under WCAG AA. A hand calculation
 * caught it once; this keeps it caught. Token values are read from index.css
 * rather than copied, so a palette change re-runs the check instead of silently
 * invalidating it.
 */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "../../../index.css")
const css = readFileSync(cssPath, "utf8")

/** Read `--name: #rrggbb` from the `:root` block (light) or `.dark` block. */
function token(name: string, theme: "light" | "dark"): string {
  const blockStart = theme === "light" ? css.indexOf(":root {") : css.indexOf(".dark {")
  expect(blockStart, `${theme} block not found in index.css`).toBeGreaterThan(-1)
  const block = css.slice(blockStart, css.indexOf("}", blockStart))
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))
  expect(match, `token --${name} not found in the ${theme} block`).not.toBeNull()
  return match![1]
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
const linearize = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map(linearize)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** AA for text below 18.66px — every string in this menu qualifies. */
const AA_NORMAL_TEXT = 4.5

/** Mirrors what command-selector.tsx actually renders, per row state. */
const PAIRS: { label: string; fg: string; bg: string }[] = [
  { label: "row name, unselected", fg: "color-fg", bg: "color-bg" },
  { label: "row description, unselected", fg: "color-fg-muted", bg: "color-bg" },
  { label: "panel title", fg: "color-fg-muted", bg: "color-bg" },
  { label: "group header", fg: "color-fg-muted", bg: "color-bg" },
  { label: "empty state", fg: "color-fg-muted", bg: "color-bg" },
  { label: "divider label", fg: "color-fg-muted", bg: "color-bg" },
  { label: "row name, selected", fg: "color-fg", bg: "color-accent" },
  { label: "row description, selected", fg: "color-accent-fg", bg: "color-accent" },
]

describe.each(["light", "dark"] as const)("command menu contrast — %s", (theme) => {
  it.each(PAIRS)("$label clears AA", ({ fg, bg }) => {
    const ratio = contrast(token(fg, theme), token(bg, theme))
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })
})

describe("the regression this gate exists for", () => {
  it("would have failed on the shipped muted × opacity-70 description", () => {
    // Compositing 70% of the muted foreground over the panel background is what
    // `opacity-70` does; assert the gate would reject it in BOTH themes.
    const composite = (fg: string, bg: string, alpha: number) => {
      const [f, b] = [channels(fg), channels(bg)]
      const mixed = f.map((v, i) => v * alpha + b[i] * (1 - alpha))
      return "#" + mixed.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")
    }
    for (const theme of ["light", "dark"] as const) {
      const bg = token("color-bg", theme)
      const ratio = contrast(composite(token("color-fg-muted", theme), bg, 0.7), bg)
      expect(ratio).toBeLessThan(AA_NORMAL_TEXT)
    }
  })

  it("would also have failed on muted text over the selected row", () => {
    // 4.40:1 in light — close enough to look fine, still a miss.
    const ratio = contrast(token("color-fg-muted", "light"), token("color-accent", "light"))
    expect(ratio).toBeLessThan(AA_NORMAL_TEXT)
  })
})
