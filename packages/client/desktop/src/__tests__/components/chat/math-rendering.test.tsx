import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"

// MarkdownContent pulls in the image renderer, which reaches for Tauri APIs.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve("")) }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

import { MarkdownContent } from "@/components/chat/message-parts"

/**
 * LaTeX rendering in chat answers (discussions/055).
 *
 * Before this, the whole pipeline was `[remarkGfm]` — every formula reached the
 * user as raw source, and markdown's inline rules quietly corrupted it on the
 * way (see the `x^*` case below). These tests pin both halves: formulas render,
 * and the things that must NOT be treated as math still aren't.
 */

function renderMd(md: string) {
  const { container } = render(<MarkdownContent text={md} />)
  return container
}

const katexCount = (c: HTMLElement) => c.querySelectorAll(".katex").length

describe("math rendering", () => {
  // The exact line from the screenshot that started this: it used to display as
  // literal `$M \cdot q(x) \geq p(x)$`.
  //
  // Assert against the VISUAL layer (`.katex-html`), not `textContent`. KaTeX
  // emits the formula three times — MathML, an `<annotation>` holding the
  // original LaTeX, and the visual HTML — so `textContent` still legitimately
  // contains `\cdot` from the annotation. (That triplication is regression W3;
  // the `user-select: none` we ship affects selection, not `textContent`.)
  it("renders inline math written with a single $", () => {
    const c = renderMd("满足：$M \\cdot q(x) \\geq p(x)$，对所有 $x$ 成立。")
    expect(katexCount(c)).toBe(2)
    const visual = c.querySelector(".katex-html")?.textContent ?? ""
    expect(visual).toContain("⋅") // \cdot became a real operator glyph
    expect(visual).not.toContain("\\cdot") // ...not leftover source
  })

  // Single `$` is deliberate, not an oversight: models overwhelmingly write
  // inline math that way (measured 85% on qwen3.7-max). Turning it off would
  // make rendering depend on the model's delimiter choice. See §8.2.
  it("renders block math written with $$", () => {
    const c = renderMd("公式：\n\n$$\nM \\cdot q(x) \\geq p(x)\n$$\n\n以上。")
    expect(c.querySelectorAll(".katex-display").length).toBe(1)
  })

  /**
   * The regression that made the bug visible rather than merely ugly.
   *
   * `$\frac{p(x^*)}{M \cdot q(x^*)}$` contains two `*`. Under plain remark-gfm
   * they paired into an `<em>`, so the asterisks vanished from the formula and
   * the leftover backslash rendered in italics — which is why the screenshot
   * showed `$\frac{p(x^)}{M |cdot q(x^)}$`. remark-math claims `$…$` at the
   * micromark level, i.e. before emphasis parsing, so the superscript survives.
   */
  it("does not let emphasis parsing eat the * in a superscript", () => {
    const c = renderMd("以概率 $\\frac{p(x^*)}{M \\cdot q(x^*)}$ **接受**该样本")
    expect(katexCount(c)).toBe(1)
    // The bold text outside the formula must still be bold...
    expect(c.querySelector("strong")?.textContent).toBe("接受")
    // ...but nothing inside the formula may have been turned into <em>.
    expect(c.querySelector(".katex em")).toBeNull()
    expect(c.querySelector("annotation")?.textContent).toContain("x^*")
  })

  it("renders math inside table cells", () => {
    const c = renderMd("| 要素 | 说明 |\n| --- | --- |\n| 接受率 | 等于 $\\frac{1}{M}$ |")
    expect(c.querySelectorAll("td .katex").length).toBe(1)
  })

  // Models legitimately write CJK inside math (`P(患病|阳性)`). KaTeX's default
  // strict mode logs one warning per character; we pass `strict: false`.
  it("renders CJK variable names without failing", () => {
    const c = renderMd("$P(患病|阳性) = \\frac{P(阳性|患病)}{P(阳性)}$")
    expect(katexCount(c)).toBe(1)
    expect(c.querySelector(".katex-error")).toBeNull()
  })

  it("renders a pmatrix", () => {
    const c = renderMd("$A = \\begin{pmatrix} 2 & 1 \\\\ 1 & 2 \\end{pmatrix}$")
    expect(katexCount(c)).toBe(1)
    expect(c.querySelector(".katex-error")).toBeNull()
  })

  // `throwOnError: false`: a malformed formula must degrade to red text, never
  // take the surrounding message down with it.
  it("degrades invalid LaTeX instead of throwing", () => {
    const c = renderMd("错误公式 $\\frac{a}{$ 后面的正文必须还在")
    expect(c.querySelector(".katex-error")).not.toBeNull()
    expect(c.textContent).toContain("后面的正文必须还在")
  })
})

describe("what must NOT become math", () => {
  it("leaves $ inside fenced code blocks alone", () => {
    const c = renderMd('```py\nprice = f"${x}"\ncost = f"${y}"\n```')
    expect(katexCount(c)).toBe(0)
    expect(c.textContent).toContain("${x}")
  })

  it("leaves $ inside inline code alone", () => {
    const c = renderMd("变量 `$PATH` 和 `$HOME` 是环境变量")
    expect(katexCount(c)).toBe(0)
    expect(c.textContent).toContain("$PATH")
  })

  it("leaves an escaped \\$ alone", () => {
    const c = renderMd("文件大小 \\$5 不是公式")
    expect(katexCount(c)).toBe(0)
  })

  /**
   * The known cost of accepting single `$`: two currency amounts in one
   * paragraph pair into a formula. Measured against 24 real model answers /
   * 279 formulas, this never actually fired (§8.2) — the two heuristic guards
   * we prototyped both mangled real formulas, so we accept this instead of
   * defending against it. This test documents the accepted behaviour so that a
   * future change to it is a deliberate decision, not an accident.
   */
  it("DOCUMENTS the accepted currency false-positive", () => {
    const c = renderMd("It costs $5 today and $10 tomorrow.")
    expect(katexCount(c)).toBe(1) // ← accepted, not desired
  })
})
