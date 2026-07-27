/**
 * LaTeX → Unicode degradation for IM channels (ADR-070 P2, discussions/055 §4.4).
 *
 * None of the four channels render LaTeX: WeChat gets plain text, DingTalk and
 * WeCom get their own markdown dialect, Feishu gets raw text. So a formula the
 * desktop renders as math reaches an IM user as source code. This module turns
 * `$M \cdot q(x) \geq p(x)$` into `M⋅q(x)≥p(x)` before it leaves the process.
 *
 * **The conversion is done by KaTeX's parser, not by regexes.** Two hand-written
 * `$`-matching guards were tried during P1 and both shipped bugs — one killed
 * real formulas, one leaked `\5` into the UI (discussions/055 §3.3). What is left
 * to regexes here is only *span detection* (finding `$…$`), which mirrors the
 * delimiters remark-math uses on the desktop; everything inside a span is handed
 * to KaTeX and walked as a MathML tree.
 *
 * Naive tree flattening is not enough either: MathML puts the numerator and
 * denominator of `\frac{1}{M}` side by side, so `.toText()` yields `1M` — a
 * different number. `mfrac`, `msup`, `msub`, `msubsup`, `msqrt`, `mroot`,
 * `mover`, `munder`, `munderover` and `mtable` therefore all get explicit rules.
 *
 * Failure is always safe: a span KaTeX cannot parse (or that renders to nothing)
 * is left exactly as it was, so the worst case is today's behaviour.
 */
import katex from "katex";

/** The subset of KaTeX's MathML tree we walk. Not covered by katex's own types. */
interface MathMLNode {
  /** Element name (`mfrac`, `mi`, …). Absent on TextNode / SpaceNode / wrappers. */
  type?: string;
  /** TextNode payload. */
  text?: string;
  /** SpaceNode width, in ems. */
  width?: number;
  children?: MathMLNode[];
  attributes?: Record<string, string>;
}

interface KatexInternals {
  __renderToDomTree(
    expression: string,
    options: Record<string, unknown>,
  ): MathMLNode;
}

/**
 * `__renderToDomTree` with `output: "mathml"` hands back the MathML *tree
 * object*, so no XML string has to be parsed. It is a `__`-prefixed internal,
 * but a stable one (present since 0.10) and the only way to get the tree —
 * `renderToString` would force us to re-parse its markup, which is exactly the
 * kind of regex work this module exists to avoid. Pinned by `katex@^0.16`;
 * `latexToUnicode` returns null if it ever disappears, degrading to raw LaTeX.
 */
const katexInternals = katex as unknown as KatexInternals;

// ---- Unicode script maps ----

/**
 * Superscripts are applied all-or-nothing: `x^{2n}` becomes `x²ⁿ`, but one
 * unmappable character (`\pi`, `q`, most capitals) drops the whole script to the
 * `^(…)` form. A half-mapped script like `e^π²` reads as a different expression.
 */
const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ",
  i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ",
  r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ",
  K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ", O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ",
  U: "ᵁ", V: "ⱽ", W: "ᵂ",
  "β": "ᵝ", "γ": "ᵞ", "δ": "ᵟ", "θ": "ᶿ",
  "φ": "ᵠ", "χ": "ᵡ",
};

const SUBSCRIPT: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ",
  n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
  "β": "ᵦ", "γ": "ᵧ", "ρ": "ᵨ", "φ": "ᵩ", "χ": "ᵪ",
};

/**
 * MathML carries invisible operators (function application, invisible times) so
 * that `\sin\theta` is semantically a call. They are zero-width but real
 * characters — left in, they travel to the IM client and can confuse copy/paste.
 */
const INVISIBLE = /[\u2061-\u2064]/g;

/**
 * Characters that bind no tighter than division, scanned at bracket depth 0 to
 * decide whether a fraction side / script body needs parentheses. Without this,
 * `\frac{p(x)}{M \cdot q(x)}` degrades to `p(x)/M⋅q(x)`, which reads as
 * `p(x)/M × q(x)` — a different expression.
 */
const LOW_PRECEDENCE = new Set(
  [..." +-−±∓=≠<>≤≥≈≡/⋅×÷*∗,;∈∉⊂⊆∪∩→⇒↔⇔∧∨"],
);

const OPEN_BRACKETS = "([{";
const CLOSE_BRACKETS = ")]}";

/**
 * KaTeX does not throw for every failure. A command it knows but refuses to run
 * — `\href`, `\url`, `\includegraphics`, anything gated behind `trust` — is
 * rendered as its own *name*, coloured with `errorColor`: `\href{...}{点我}`
 * comes out as the four characters `\href` and **点我 is gone**. On the desktop
 * that at least shows up red; degraded to plain text it is silent content loss.
 *
 * So the error colour is set to a sentinel nobody writes by hand and treated as
 * a parse failure — the span then keeps its original source, which is both
 * visible to the user and exactly the pre-P2 behaviour. Detecting this by
 * scanning the output for a stray backslash would not work: `a \backslash b`
 * legitimately renders as `a\b`.
 */
const ERROR_COLOR = "#cc0001";
/** Thrown from `render` when an error node is met; caught in `latexToUnicode`. */
const ERROR_NODE = Symbol("katex-error-node");

/**
 * KaTeX emits *spacing* accent glyphs, which trail the base instead of sitting
 * on it: `\hat{y}` comes out as `y^`, indistinguishable from an exponent, and
 * `\underline{ab}` as `ab‾` — an overline. The combining forms land on the base
 * character. (`\vec` already uses a combining mark and passes through.)
 */
const COMBINING_ABOVE: Record<string, string> = {
  "^": "̂", // ^  circumflex   \hat
  "~": "̃", // ~  tilde        \tilde
  "ˉ": "̄", // ˉ  macron       \bar
  "˙": "̇", // ˙  dot above    \dot
  "¨": "̈", // ¨  diaeresis    \ddot
  "ˇ": "̌", // ˇ  caron        \check
  "˘": "̆", // ˘  breve        \breve
  "ˊ": "́", // ˊ  acute        \acute
  "ˋ": "̀", // ˋ  grave        \grave
  "‾": "̅", // ‾  overline     \overline
};
const COMBINING_BELOW: Record<string, string> = {
  "‾": "̲", // ‾ → low line    \underline
};

// ---- Tree → text ----

function mapScript(body: string, table: Record<string, string>): string | null {
  const chars = [...body];
  if (chars.length === 0) return null;
  let out = "";
  for (const ch of chars) {
    const mapped = table[ch];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}

/**
 * True when `s` contains an operator outside any bracket, i.e. wrapping it is
 * needed for the result to mean what the LaTeX meant.
 */
function needsParens(s: string): boolean {
  const chars = [...s];
  if (chars.length <= 1) return false;
  let depth = 0;
  for (const ch of chars) {
    if (OPEN_BRACKETS.includes(ch)) depth++;
    else if (CLOSE_BRACKETS.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && LOW_PRECEDENCE.has(ch)) return true;
  }
  return false;
}

function paren(s: string): string {
  return needsParens(s) ? `(${s})` : s;
}

function bracketsBalanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (OPEN_BRACKETS.includes(ch)) depth++;
    else if (CLOSE_BRACKETS.includes(ch)) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Children that contribute something — invisible operators and the LaTeX
 *  annotation render to nothing and must not make a node look composite. */
function meaningfulChildren(node: MathMLNode): MathMLNode[] {
  return (node.children ?? []).filter((c) => render(c) !== "");
}

/**
 * Whether a node can sit to the right of `/` without parentheses.
 *
 * The string-level {@link needsParens} scan cannot answer this: a denominator
 * like `\sum_j e^{z_j}` or `2\pi` is a *product* written by juxtaposition, so it
 * contains no operator character at all — yet `1/2π` reads as `(1/2)·π`. Only
 * the tree knows it is more than one factor.
 *
 * Two composite shapes are still safe because they are self-delimiting: an
 * expression already wrapped in brackets (`\left(…\right)`), and a function
 * application (`Q(i)`), where nothing can detach from the identifier.
 */
function isAtomicOperand(node: MathMLNode | undefined): boolean {
  if (!node) return true;
  if (node.text !== undefined) return true;

  const kids = meaningfulChildren(node);
  switch (node.type) {
    case "mi":
    case "mn":
    case "mo":
    case "mtext":
      return true;
    // A script binds to its base; nothing can slip in between.
    case "msub":
    case "msup":
    case "msubsup":
    case "munder":
    case "mover":
    case "munderover":
      return isAtomicOperand(kids[0]);
    // The radical sign delimits its own body.
    case "msqrt":
    case "mroot":
      return true;
    case "mfrac":
    case "mtable":
      return false;
    default: {
      // Wrappers: mrow / mstyle / semantics / math / Span / DocumentFragment.
      if (kids.length <= 1) return isAtomicOperand(kids[0]);
      const first = render(kids[0]);
      const last = render(kids[kids.length - 1]);
      const middle = kids.slice(1, -1).map(render).join("");
      // `\left( … \right)` — already bracketed.
      if (OPEN_BRACKETS.includes(first) && CLOSE_BRACKETS.includes(last)) {
        return bracketsBalanced(middle);
      }
      // `Q(i)`, `P_1(x)` — an atom immediately applied to a bracketed argument.
      if (
        kids.length >= 3 &&
        isAtomicOperand(kids[0]) &&
        render(kids[1]) === "(" &&
        last === ")"
      ) {
        return bracketsBalanced(kids.slice(2, -1).map(render).join(""));
      }
      return false;
    }
  }
}

/** `√` binds tighter than anything, so only a lone atom or a number may go bare. */
function parenUnderRoot(s: string): string {
  const chars = [...s];
  if (chars.length <= 1) return s;
  if (/^\d+$/.test(s)) return s;
  return `(${s})`;
}

function renderScripted(
  base: MathMLNode | undefined,
  sub: MathMLNode | undefined,
  sup: MathMLNode | undefined,
): string {
  // The base needs bracketing for the same reason a fraction side does:
  // `\frac{a}{b}^2` must not degrade to `a/b²`, which squares only `b`.
  let out = paren(render(base));
  // The fallback is always bracketed, even for a one-character script. `_` and
  // `^` have no closing delimiter, so `y_{ic}\log(...)` would degrade to
  // `y_iclog(...)` — where the subscript ends is anyone's guess. Measured on the
  // real P0 corpus, not imagined.
  if (sub) {
    const body = render(sub);
    out += mapScript(body, SUBSCRIPT) ?? `_(${body})`;
  }
  if (sup) {
    const body = render(sup);
    out += mapScript(body, SUPERSCRIPT) ?? `^(${body})`;
  }
  return out;
}

/**
 * `mover` / `munder` are two different things wearing one element name: an
 * accent (`\vec x`, `\overline{AB}`) decorates the base, while a non-accent
 * script (`\lim` in display mode, `\underbrace`) is a limit and must degrade
 * like a sub/superscript would.
 */
function renderOverUnder(
  node: MathMLNode,
  kids: MathMLNode[],
  position: "over" | "under",
): string {
  const mark = render(kids[1]);
  const combining = (position === "over" ? COMBINING_ABOVE : COMBINING_BELOW)[mark];
  // An accent is decoration, never a script — `x^⃗` would read as an exponent.
  // The glyph is checked as well as the attribute because `\underline` arrives
  // as a plain munder with no `accent`, and would otherwise become `ab_(‾)`.
  if (combining !== undefined || node.attributes?.accent === "true") {
    return render(kids[0]) + (combining ?? mark);
  }
  return position === "over"
    ? renderScripted(kids[0], undefined, kids[1])
    : renderScripted(kids[0], kids[1], undefined);
}

function renderTable(kids: MathMLNode[]): string {
  // Cells joined by a space rather than a comma: `\begin{aligned} a &= b \end{}`
  // splits into `a` and `= b`, and `a, = b` reads as a typo. A matrix loses a
  // little clarity in exchange (`(a b; c d)`).
  return kids
    .map((row) => (row.children ?? []).map(render).join(" "))
    .join("; ");
}

function render(node: MathMLNode | undefined): string {
  if (!node) return "";
  if (node.text !== undefined) return node.text.replace(INVISIBLE, "");
  if (node.width !== undefined && node.type === undefined) {
    // `\quad`-class spacing survives as one space; hair/thin spaces are dropped.
    return node.width >= 0.15 ? " " : "";
  }

  if (node.attributes?.mathcolor === ERROR_COLOR) throw ERROR_NODE;

  const kids = node.children ?? [];
  switch (node.type) {
    // The LaTeX source rides along in `<annotation>`; emitting it would print
    // every formula twice, once degraded and once raw.
    case "annotation":
      return "";
    case "mphantom":
      return "";
    case "mfrac":
      return renderFrac(node, kids);
    case "msup":
      return renderScripted(kids[0], undefined, kids[1]);
    case "msub":
      return renderScripted(kids[0], kids[1], undefined);
    case "msubsup":
      return renderScripted(kids[0], kids[1], kids[2]);
    case "munderover":
      return renderScripted(kids[0], kids[1], kids[2]);
    case "mover":
      return renderOverUnder(node, kids, "over");
    case "munder":
      return renderOverUnder(node, kids, "under");
    case "msqrt":
      return "√" + parenUnderRoot(kids.map(render).join(""));
    case "mroot":
      return renderRoot(kids);
    case "mtable":
      return renderTable(kids);
    default:
      return kids.map(render).join("");
  }
}

function renderFrac(node: MathMLNode, kids: MathMLNode[]): string {
  const numer = render(kids[0]);
  const denom = render(kids[1]);
  // `\binom{n}{k}` is an mfrac with no rule. Degrading it to `n/k` would state a
  // division that is not there, so the two parts are merely listed.
  if (node.attributes?.linethickness === "0px") return `${numer}, ${denom}`;
  // The numerator only has to fend off what precedes the fraction, and `/` binds
  // tighter than `+`/`=`; the denominator has to fend off juxtaposition too.
  const right =
    isAtomicOperand(kids[1]) && !needsParens(denom) ? denom : `(${denom})`;
  return `${paren(numer)}/${right}`;
}

function renderRoot(kids: MathMLNode[]): string {
  const body = parenUnderRoot(render(kids[0]));
  const index = render(kids[1]);
  if (index === "3") return "∛" + body;
  if (index === "4") return "∜" + body;
  const sup = mapScript(index, SUPERSCRIPT);
  return `${sup ?? `[${index}]`}√${body}`;
}

/**
 * Convert one LaTeX expression to a Unicode approximation.
 * Returns null when KaTeX cannot parse it or the result is empty — callers must
 * then keep the original source (safe failure).
 */
export function latexToUnicode(tex: string, displayMode = false): string | null {
  let tree: MathMLNode;
  try {
    tree = katexInternals.__renderToDomTree(tex, {
      output: "mathml",
      // Parse errors must reach us so the original survives; a red "error node"
      // rendered into a chat message would be worse than the raw LaTeX.
      throwOnError: true,
      // Chinese variable names (`P(患病|阳性)`) are legitimate here and only trip
      // strict mode's warnings — same setting the desktop uses (ADR-070 D1).
      strict: false,
      displayMode,
      errorColor: ERROR_COLOR,
    });
  } catch {
    return null;
  }

  let out: string;
  try {
    out = render(tree).replace(/[ \t]{2,}/g, " ").trim();
  } catch (err) {
    if (err === ERROR_NODE) return null; // a command KaTeX refused to run
    throw err;
  }
  return out.length > 0 ? out : null;
}

// ---- Span detection ----

/**
 * A LaTeX span, matching the delimiters remark-math tokenises on the desktop:
 * `$$…$$` (may span lines) or a single-line `$…$`. Deliberately conservative —
 * a single `$` span may contain neither a newline nor another `$`.
 *
 * Shared with `stripMarkdown` so the two ends of the pipeline cannot drift on
 * what counts as a formula.
 */
export const MATH_SPAN = /\$\$[\s\S]+?\$\$|\$(?!\$)[^\n$]+?\$/g;

/** Same patterns, anchored, for the scanner below. */
const DISPLAY_SPAN_AT = /\$\$([\s\S]+?)\$\$/y;
const INLINE_SPAN_AT = /\$(?!\$)([^\n$]+?)\$/y;
const FENCE_OPEN_AT = /[ ]{0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/y;
const BACKTICK_RUN_AT = /`+/y;
/** A bare URL, which GFM autolinks, and an `<…>` autolink. */
const BARE_URL_AT = /https?:\/\/[^\s<>)\]]*/y;
const ANGLE_AUTOLINK_AT = /<[a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]*>/y;

/** Position of the first char after the fenced block opening at `start`. */
function skipFencedBlock(text: string, start: number): number | null {
  FENCE_OPEN_AT.lastIndex = start;
  const open = FENCE_OPEN_AT.exec(text);
  if (!open) return null;
  const marker = open[1][0];
  const closeRe = new RegExp(`^ {0,3}${marker}{${open[1].length},}[ \\t]*(?:\\n|$)`, "gm");
  closeRe.lastIndex = start + open[0].length;
  const close = closeRe.exec(text);
  // An unclosed fence runs to the end of the message — same as every markdown
  // renderer, and the safer reading: everything after it stays untouched.
  return close ? close.index + close[0].length : text.length;
}

/** Position of the first char after the inline code span at `start`. */
function skipInlineCode(text: string, start: number): number | null {
  BACKTICK_RUN_AT.lastIndex = start;
  const open = BACKTICK_RUN_AT.exec(text);
  if (!open) return null;
  const fence = open[0];
  let i = start + fence.length;
  while (i < text.length) {
    const next = text.indexOf(fence, i);
    if (next === -1) return null; // never closed → not a code span at all
    let end = next + fence.length;
    // CommonMark closes on a run of *exactly* this length.
    if (text[end] === "`") {
      while (text[end] === "`") end++;
      i = end;
      continue;
    }
    return end;
  }
  return null;
}

/** Position after a `](…)` link/image destination starting at `]`. */
function skipLinkDestination(text: string, start: number): number | null {
  if (text[start] !== "]" || text[start + 1] !== "(") return null;
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") return null; // not a destination after all
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * Rewrite every LaTeX span in a markdown message as Unicode, leaving code
 * blocks, inline code, URLs and anything KaTeX rejects untouched.
 *
 * The skips are not optional extras — each one is a place where a `$` is not
 * maths and rewriting it would corrupt something the user acts on:
 *
 * - **Code.** Unlike `stripMarkdown` this runs on the message as sent, so
 *   `$PATH` in a shell snippet is still in place and `$PATH … $HOME` would be
 *   swallowed as one span, changing a command the user may paste and run.
 * - **URLs.** Verified against the desktop pipeline: remark-math leaves `$`
 *   inside a link destination and inside a GFM-autolinked bare URL alone, so
 *   converting them here would break links that work everywhere else — an
 *   IM-only regression rather than a difference the desktop already has.
 */
export function degradeMathToUnicode(text: string): string {
  if (!text.includes("$")) return text;

  let out = "";
  let i = 0;
  while (i < text.length) {
    const atLineStart = out.length === 0 || out.endsWith("\n");
    const ch = text[i];

    if (atLineStart && (ch === "`" || ch === "~" || ch === " ")) {
      const end = skipFencedBlock(text, i);
      if (end !== null) {
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === "`") {
      const end = skipInlineCode(text, i);
      if (end !== null) {
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === "]") {
      const end = skipLinkDestination(text, i);
      if (end !== null) {
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === "h" || ch === "<") {
      const re = ch === "h" ? BARE_URL_AT : ANGLE_AUTOLINK_AT;
      re.lastIndex = i;
      const url = re.exec(text);
      if (url) {
        out += url[0];
        i += url[0].length;
        continue;
      }
    }

    if (ch === "$") {
      DISPLAY_SPAN_AT.lastIndex = i;
      const display = DISPLAY_SPAN_AT.exec(text);
      if (display) {
        out += latexToUnicode(display[1], true) ?? display[0];
        i += display[0].length;
        continue;
      }
      INLINE_SPAN_AT.lastIndex = i;
      const inline = INLINE_SPAN_AT.exec(text);
      if (inline) {
        out += latexToUnicode(inline[1], false) ?? inline[0];
        i += inline[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}
