import { describe, it, expect } from "vitest"
import type { QuestionInfo } from "@agent/api-client"
import { renderQuestions, parseAnswer, QUESTION_SKIP_COMMAND } from "../question-prompt.js"

const pick: QuestionInfo = {
  question: "用 A 方案还是 B 方案？",
  header: "方案选择",
  options: [
    { label: "A 方案", description: "第一种做法" },
    { label: "B 方案", description: "第二种做法" },
  ],
}

describe("renderQuestions", () => {
  it("renders a single question as a numbered list", () => {
    const out = renderQuestions([pick])
    expect(out).toContain("❓ 方案选择")
    expect(out).toContain("用 A 方案还是 B 方案？")
    expect(out).toContain("1. A 方案 — 第一种做法")
    expect(out).toContain("2. B 方案 — 第二种做法")
    expect(out).toContain(QUESTION_SKIP_COMMAND)
  })

  it("numbers each question when there are several", () => {
    const out = renderQuestions([pick, { ...pick, header: "第二问" }])
    expect(out).toContain("Q1. 方案选择")
    expect(out).toContain("Q2. 第二问")
    expect(out).toContain("逐行回答")
  })

  it("mentions multi-select only when a question allows it", () => {
    expect(renderQuestions([pick])).not.toContain("可多选")
    expect(renderQuestions([{ ...pick, multiple: true }])).toContain("可多选")
  })
})

describe("parseAnswer", () => {
  it("maps a number to the option label", () => {
    expect(parseAnswer("2", [pick])).toEqual({ ok: true, answers: [["B 方案"]] })
  })

  it("takes free text as a custom answer", () => {
    expect(parseAnswer("都不要，换个思路", [pick])).toEqual({
      ok: true,
      answers: [["都不要，换个思路"]],
    })
  })

  it("treats an out-of-range number as a typed answer, not a bad index", () => {
    // The model cannot forbid custom answers (QuestionTool omits the field), so
    // "80" to a budget question is the answer — rejecting it as a bad option
    // index would dead-loop the user: re-ask, they retype 80, re-ask…
    expect(parseAnswer("80", [pick])).toEqual({ ok: true, answers: [["80"]] })
  })

  it("still demands an index when the question forbids a custom answer", () => {
    const r = parseAnswer("80", [{ ...pick, custom: false }])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain("请回复序号")
  })

  it("rejects free text when the question forbids a custom answer", () => {
    const r = parseAnswer("随便", [{ ...pick, custom: false }])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain("请回复序号")
  })

  it("accepts several numbers only for a multi-select question", () => {
    expect(parseAnswer("1,2", [{ ...pick, multiple: true }])).toEqual({
      ok: true,
      answers: [["A 方案", "B 方案"]],
    })

    const single = parseAnswer("1,2", [pick])
    expect(single.ok).toBe(false)
    expect(single.ok === false && single.error).toContain("只能选一个")
  })

  it("de-duplicates repeated picks", () => {
    expect(parseAnswer("1 1", [{ ...pick, multiple: true }])).toEqual({
      ok: true,
      answers: [["A 方案"]],
    })
  })

  it("parses one line per question when several are asked", () => {
    const r = parseAnswer("1\n自定义答案", [pick, { ...pick, header: "第二问" }])
    expect(r).toEqual({ ok: true, answers: [["A 方案"], ["自定义答案"]] })
  })

  it("rejects a line count that does not match the questions", () => {
    const r = parseAnswer("1", [pick, pick])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain("需要 2 个回答")
  })

  it("rejects an empty reply", () => {
    expect(parseAnswer("   ", [pick]).ok).toBe(false)
  })
})
