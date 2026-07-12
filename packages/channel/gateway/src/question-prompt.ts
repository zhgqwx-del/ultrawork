import type { QuestionInfo } from "@agent/api-client";

/**
 * Rendering and parsing for agent questions in a chat channel.
 *
 * None of the four channels can render buttons through the current adapter
 * surface (sendMessage takes a string), so questions degrade to a numbered
 * list: the user replies with a number, or just types an answer when the
 * question allows a custom one. This is the same fallback the button-capable
 * bots use for channels without interactive UI.
 */

/** Reply with this to decline a question instead of answering it. */
export const QUESTION_SKIP_COMMAND = "/skip";

export function renderQuestions(questions: QuestionInfo[]): string {
  const multi = questions.length > 1;
  const blocks = questions.map((q, qi) => {
    const heading = multi ? `Q${qi + 1}. ${q.header}` : `❓ ${q.header}`;
    const options = q.options.map(
      (o, oi) => `  ${oi + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`,
    );
    return [heading, q.question, ...options].join("\n");
  });

  const hints: string[] = [];
  hints.push(
    multi
      ? "请按顺序逐行回答（每行一个：序号或自定义答案）"
      : "回复序号即可选择；也可以直接打字回答",
  );
  if (questions.some((q) => q.multiple)) {
    hints.push("可多选：用逗号分隔序号，如 1,3");
  }
  hints.push(`不想回答就回复 ${QUESTION_SKIP_COMMAND}`);

  return [...blocks, hints.join("\n")].join("\n\n");
}

export type ParseResult =
  | { ok: true; answers: string[][] }
  | { ok: false; error: string };

/**
 * Parse a chat reply into opencode's answer shape (one label array per question).
 * A number picks an option; anything else is taken as a custom answer when the
 * question permits one (`custom` defaults to true, matching opencode).
 */
export function parseAnswer(input: string, questions: QuestionInfo[]): ParseResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "回答不能为空。" };

  if (questions.length === 1) {
    const one = parseOne(raw, questions[0], 0);
    return one.ok ? { ok: true, answers: [one.labels] } : one;
  }

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== questions.length) {
    return {
      ok: false,
      error: `需要 ${questions.length} 个回答（每行一个），收到 ${lines.length} 个。`,
    };
  }

  const answers: string[][] = [];
  for (let i = 0; i < questions.length; i++) {
    const one = parseOne(lines[i], questions[i], i);
    if (!one.ok) return one;
    answers.push(one.labels);
  }
  return { ok: true, answers };
}

type OneResult = { ok: true; labels: string[] } | { ok: false; error: string };

function parseOne(line: string, question: QuestionInfo, index: number): OneResult {
  const where = `第 ${index + 1} 个问题`;
  const count = question.options.length;
  const allowsCustom = question.custom !== false;

  // "1" or, for multi-select, "1,3" / "1 3" / "1、3"
  const tokens = line.split(/[,，、\s]+/).filter(Boolean);
  const allNumeric = tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));

  if (allNumeric) {
    if (tokens.length > 1 && !question.multiple) {
      return { ok: false, error: `${where}只能选一个。` };
    }
    const picked: string[] = [];
    for (const t of tokens) {
      const n = Number(t);
      if (n < 1 || n > count) {
        return { ok: false, error: `${where}的序号 ${n} 超出范围（1-${count}）。` };
      }
      const label = question.options[n - 1].label;
      if (!picked.includes(label)) picked.push(label);
    }
    return { ok: true, labels: picked };
  }

  // Not a number — a typed answer, if this question takes one
  if (!allowsCustom) {
    return { ok: false, error: `${where}请回复序号（1-${count}）。` };
  }
  return { ok: true, labels: [line] };
}
