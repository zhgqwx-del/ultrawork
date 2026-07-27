import { describe, it, expect } from "vitest";
import { stripMarkdown } from "../../../adapters/wechat/wechat-adapter.js";

/**
 * WeChat is the one channel that receives plain text (the other three send
 * markdown or raw source), so `stripMarkdown` is the last thing that touches an
 * answer before it leaves the process. It used to reach inside LaTeX and
 * rewrite it — see the summation case below. discussions/055 §4.1.
 */
describe("stripMarkdown — math must survive intact", () => {
  // The regression that motivated this: `_(.+?)_` paired the subscript in
  // `\sum_{i=1}^{n}` with the one in `a_i`, deleting both underscores and the
  // text between them. The formula still looked like a formula, but it now
  // said something different — a silent content change, not a display glitch.
  it("does not let _ emphasis pair across two subscripts", () => {
    const out = stripMarkdown("$\\sum_{i=1}^{n} a_i = b_i$ 恒成立");
    expect(out).toBe("$\\sum_{i=1}^{n} a_i = b_i$ 恒成立");
    expect(out).not.toContain("ai"); // what the old code produced
  });

  it("does not let * emphasis eat superscript stars", () => {
    const out = stripMarkdown("以概率 $\\frac{p(x^*)}{M \\cdot q(x^*)}$ 接受");
    expect(out).toContain("x^*");
    expect(out).toContain("\\cdot");
  });

  it("keeps block math verbatim", () => {
    const src = "公式：\n\n$$\nM \\cdot q(x) \\geq p(x)\n$$\n\n以上。";
    expect(stripMarkdown(src)).toContain("$$\nM \\cdot q(x) \\geq p(x)\n$$");
  });

  it("still strips emphasis outside formulas", () => {
    const out = stripMarkdown("**接受**该样本 $x_0$，否则*拒绝*");
    expect(out).toBe("接受该样本 $x_0$，否则拒绝");
  });

  // The placeholder used while parking formulas must not survive into output,
  // and must not collide with ordinary prose that looks like a token.
  it("restores every formula and leaves no placeholder behind", () => {
    const out = stripMarkdown("先 $a_1$ 再 $b_2$ 最后 $c_3$");
    expect(out).toBe("先 $a_1$ 再 $b_2$ 最后 $c_3$");
    expect(out).not.toContain("\u0000");
  });

  it("does not treat prose that resembles a placeholder as math", () => {
    const out = stripMarkdown("参数 M0 和 M1 表示两个模型");
    expect(out).toBe("参数 M0 和 M1 表示两个模型");
  });
});

describe("stripMarkdown — unchanged behaviour", () => {
  it("strips bold, italic, headers, links and images", () => {
    expect(stripMarkdown("# 标题")).toBe("标题");
    expect(stripMarkdown("**粗**和*斜*")).toBe("粗和斜");
    expect(stripMarkdown("见 [文档](https://example.com)")).toBe("见 文档");
    expect(stripMarkdown("![图](a.png)后文")).toBe("后文");
  });

  it("unwraps code blocks to their content", () => {
    expect(stripMarkdown("```py\nx = 1\n```")).toBe("x = 1");
  });

  // `$PATH` inside code is shell, not math — the math rule runs after the code
  // rules precisely so this can't be parked as a formula.
  it("leaves shell variables in inline code alone", () => {
    expect(stripMarkdown("变量 `$PATH` 与 `$HOME`")).toBe("变量 $PATH 与 $HOME");
  });
});
