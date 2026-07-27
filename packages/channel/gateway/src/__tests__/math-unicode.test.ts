import { describe, it, expect } from "vitest";
import { latexToUnicode, degradeMathToUnicode } from "../math-unicode.js";

/**
 * ADR-070 P2. None of the four IM channels render LaTeX, so formulas reach the
 * user as source code. These tests pin the two properties that matter: the
 * conversion must not change what a formula *means*, and anything it cannot
 * handle must come back byte-for-byte unchanged.
 */
describe("latexToUnicode — structure that naive flattening gets wrong", () => {
  // The reason this module walks the MathML tree instead of taking its text:
  // MathML puts numerator and denominator side by side, so `.toText()` on
  // `\frac{1}{M}` yields "1M" — a different number, silently.
  it("keeps a fraction a fraction", () => {
    expect(latexToUnicode("\\frac{1}{M}")).toBe("1/M");
    expect(latexToUnicode("\\frac{1}{M}")).not.toBe("1M");
  });

  it("renders scripts, radicals and integrals", () => {
    expect(latexToUnicode("x_0")).toBe("x₀");
    expect(latexToUnicode("A^{-1}")).toBe("A⁻¹");
    expect(latexToUnicode("\\sqrt{x^2 + y^2}")).toBe("√(x²+y²)");
    expect(latexToUnicode("\\int_0^1 f(x) dx")).toBe("∫₀¹f(x)dx");
    expect(latexToUnicode("\\sqrt[3]{x}")).toBe("∛x");
  });

  it("renders the formulas from the screenshot that started this", () => {
    expect(latexToUnicode("M \\cdot q(x) \\geq p(x)")).toBe("M⋅q(x)≥p(x)");
    // The superscript star is the character the desktop bug used to eat.
    expect(latexToUnicode("\\frac{p(x^*)}{M \\cdot q(x^*)}")).toBe(
      "p(x^(∗))/(M⋅q(x^(∗)))",
    );
  });

  it("parenthesises a denominator that is a product written by juxtaposition", () => {
    // No operator character appears in `2\pi` or `\sum_j e^{z_j}`, so a
    // string-level guard cannot see that they are products — only the tree can.
    // `1/2π` would read as (1/2)·π.
    expect(latexToUnicode("\\frac{1}{2\\pi}")).toBe("1/(2π)");
    expect(latexToUnicode("\\frac{e^{z_i}}{\\sum_j e^{z_j}}")).toBe(
      "e^(zᵢ)/(∑ⱼe^(zⱼ))",
    );
  });

  it("leaves a self-delimiting denominator bare", () => {
    // `Q(i)` cannot come apart, so parentheses would only add noise.
    expect(latexToUnicode("\\frac{P(i)}{Q(i)}")).toBe("P(i)/Q(i)");
  });

  it("brackets a fraction that is itself raised to a power", () => {
    // `a/b²` squares only the denominator.
    expect(latexToUnicode("\\frac{a}{b}^2")).toBe("(a/b)²");
  });

  it("does not turn a binomial into a division", () => {
    expect(latexToUnicode("\\binom{n}{k}")).toBe("(n, k)");
  });

  it("maps a whole script or none of it", () => {
    // Every character maps → real subscripts.
    expect(latexToUnicode("\\sum_{i=1}^{n} a_i = b_i")).toBe("∑ᵢ₌₁ⁿaᵢ=bᵢ");
    expect(latexToUnicode("x_{max}")).toBe("xₘₐₓ");
    // θ has no subscript form, so the whole script falls back rather than
    // rendering half-raised. The fallback is always bracketed: `_`/`^` have no
    // closing delimiter, so `y_{ic}\log(…)` would otherwise read as `y_iclog(…)`
    // with no way to tell where the subscript ends.
    expect(latexToUnicode("P_{\\theta}")).toBe("P_(θ)");
    expect(latexToUnicode("e^{-\\lambda}")).toBe("e^(−λ)");
  });

  it("treats an accent as decoration, not as an exponent", () => {
    expect(latexToUnicode("\\vec{x}")).toBe("x\u20d7");
    expect(latexToUnicode("\\overline{AB}")).toBe("AB\u0305");
  });

  it("handles matrices, cases and Chinese variable names", () => {
    expect(latexToUnicode("\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}")).toBe(
      "(a b; c d)",
    );
    // Chinese identifiers are legitimate maths here and only trip strict mode.
    expect(latexToUnicode("P(患病|阳性)")).toBe("P(患病∣阳性)");
  });

  it("drops MathML's invisible operators", () => {
    const out = latexToUnicode("\\sin\\theta") ?? "";
    expect(out).toBe("sinθ");
    expect(out).not.toMatch(/[\u2061-\u2064]/);
  });

  it("never emits the LaTeX source alongside the result", () => {
    // KaTeX ships the source in an <annotation> node; emitting it would print
    // every formula twice.
    const out = latexToUnicode("\\alpha + \\beta") ?? "";
    expect(out).toBe("α+β");
    expect(out).not.toContain("\\alpha");
  });

  it("returns null for anything it cannot parse", () => {
    expect(latexToUnicode("\\notacommand{x}")).toBeNull();
    expect(latexToUnicode("\\frac{1}")).toBeNull();
    expect(latexToUnicode("   ")).toBeNull();
  });

  it("returns null for a command KaTeX renders as an error instead of throwing", () => {
    // `\href` is known but gated behind `trust`, so KaTeX does not throw — it
    // renders the four characters `\href` in the error colour and **drops the
    // link text**. Degraded to plain text that is silent content loss, so it has
    // to count as a failure and keep the original source.
    expect(latexToUnicode("\\href{https://x}{点我}")).toBeNull();
    expect(latexToUnicode("\\url{https://x}")).toBeNull();
    expect(latexToUnicode("\\includegraphics{a.png}")).toBeNull();
  });

  it("does not mistake a legitimate backslash for an error", () => {
    // Scanning the output for `\` + letters would have rejected this one:
    // `\backslash` renders as a real ASCII backslash between two identifiers.
    expect(latexToUnicode("a \\backslash b")).toBe("a\\b");
  });
});

describe("degradeMathToUnicode — span detection", () => {
  it("rewrites inline and block spans in place", () => {
    expect(degradeMathToUnicode("以概率 $\\frac{1}{M}$ 接受")).toBe(
      "以概率 1/M 接受",
    );
    expect(
      degradeMathToUnicode("公式：\n\n$$\nM \\cdot q(x) \\geq p(x)\n$$\n\n以上。"),
    ).toBe("公式：\n\nM⋅q(x)≥p(x)\n\n以上。");
  });

  it("keeps the original source when KaTeX rejects a span", () => {
    const src = "坏公式 $\\notacommand{x}$ 保留原文";
    expect(degradeMathToUnicode(src)).toBe(src);
  });

  it("leaves shell variables in inline code alone", () => {
    // This runs on the message as sent, so unlike `stripMarkdown` the code has
    // not been unwrapped yet — `$PATH ... $HOME` would otherwise look like one
    // span and be swallowed, corrupting a command the user might run.
    const src = "变量 `$PATH` 与 `$HOME` 不变";
    expect(degradeMathToUnicode(src)).toBe(src);
  });

  it("leaves fenced code blocks alone", () => {
    const src = "```bash\necho $HOME  # $x^2$ 不动\n```";
    expect(degradeMathToUnicode(src)).toBe(src);
    const tilde = "~~~\ncost=$5 and $10\n~~~";
    expect(degradeMathToUnicode(tilde)).toBe(tilde);
  });

  it("does not let an unclosed fence swallow later text as code", () => {
    // An unclosed fence runs to the end of the message, same as any markdown
    // renderer — the safe direction, since nothing after it is rewritten.
    const src = "```\n$x^2$";
    expect(degradeMathToUnicode(src)).toBe(src);
  });

  it("leaves dollars inside URLs alone", () => {
    // Checked against the desktop pipeline, which keeps these intact: rewriting
    // them here would break a link that works everywhere else. `$b$` in the
    // path would otherwise be eaten and the URL would silently become `.../abc`.
    for (const src of [
      "见 [文档](https://ex.com/a$b$c) 说明",
      "见 https://ex.com/a$b$c 说明",
      "![图](https://ex.com/i$k$g)",
      "见 <https://ex.com/a$b$c> 说明",
    ]) {
      expect(degradeMathToUnicode(src)).toBe(src);
    }
  });

  it("still converts a formula that follows a link", () => {
    expect(
      degradeMathToUnicode("见 [文档](https://ex.com/a) 里的 $x_0$"),
    ).toBe("见 [文档](https://ex.com/a) 里的 x₀");
  });

  it("converts formulas inside a markdown table", () => {
    expect(degradeMathToUnicode("| $\\frac{1}{M}$ | 接受率 |")).toBe(
      "| 1/M | 接受率 |",
    );
  });

  it("leaves a lone dollar sign untouched", () => {
    expect(degradeMathToUnicode("成本 $100 元")).toBe("成本 $100 元");
    expect(degradeMathToUnicode("no math here")).toBe("no math here");
  });

  it("converts several spans in one message independently", () => {
    expect(degradeMathToUnicode("先 $a_1$ 再 $\\bad{}$ 最后 $c_3$")).toBe(
      "先 a₁ 再 $\\bad{}$ 最后 c₃",
    );
  });
});
