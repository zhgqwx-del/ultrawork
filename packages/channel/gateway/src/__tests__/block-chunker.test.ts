import { describe, it, expect } from "vitest"
import { BlockChunker } from "../block-chunker.js"

const para = (n: number, char = "a") => char.repeat(n)

describe("BlockChunker", () => {
  it("holds back text shorter than the minimum", () => {
    const c = new BlockChunker({ minChars: 200 })
    expect(c.next("short\n\n")).toBeNull()
    expect(c.rest("short\n\n")).toBe("short")
  })

  it("emits a block once a paragraph break clears the minimum", () => {
    const c = new BlockChunker({ minChars: 200 })
    const text = `${para(250)}\n\ntail`
    expect(c.next(text)).toBe(para(250))
    expect(c.rest(text)).toBe("tail")
  })

  it("never cuts mid-sentence — only at a paragraph break", () => {
    const c = new BlockChunker({ minChars: 100 })
    // Long enough, but a single paragraph: nothing to cut at
    expect(c.next(para(500))).toBeNull()
  })

  it("cuts at the last eligible break, not the first", () => {
    const c = new BlockChunker({ minChars: 100 })
    const text = `${para(150)}\n\n${para(150)}\n\nrest`
    expect(c.next(text)).toBe(`${para(150)}\n\n${para(150)}`)
    expect(c.rest(text)).toBe("rest")
  })

  it("does not split a fenced code block", () => {
    const c = new BlockChunker({ minChars: 50 })
    const open = `${para(60)}\n\n\`\`\`ts\nconst a = 1\n\nconst b = 2\n`
    // The only breaks past the minimum are inside the open fence
    expect(c.next(open)).toBe(para(60))
    expect(c.next(open)).toBeNull()

    // Once the fence closes, the text after it can be cut again
    const closed = `${open}\`\`\`\n\n${para(60)}\n\ntail`
    const block = c.next(closed)
    expect(block).toContain("```ts")
    expect(block).toContain("```")
    expect(c.rest(closed)).toBe("tail")
  })

  it("streams no more blocks than the budget allows", () => {
    const c = new BlockChunker({ minChars: 10, maxChunks: 2 })
    let text = ""
    for (let i = 0; i < 5; i++) {
      text += `${para(20, String(i))}\n\n`
      c.next(text)
    }
    expect(c.sent).toBe(2)

    // Everything past the budget is held for the final flush, not dropped
    expect(c.rest(text)).toContain(para(20, "2"))
    expect(c.rest(text)).toContain(para(20, "4"))
  })

  it("survives opencode rewriting a part it already published", () => {
    // text-end trims the part that was already streamed (processor.ts), which
    // shortens it and shifts every later part left. An absolute offset into the
    // joined text ate the next part's first characters.
    const c = new BlockChunker()
    expect(c.next(`${para(210)}\n\n\n\n`)).toBe(para(210))

    const full = [para(210), "SECOND PART TEXT"].join("\n\n") // p1 now trimEnd'd
    expect(c.rest(full)).toBe("SECOND PART TEXT")
  })

  it("survives a rewrite that lengthens an earlier part", () => {
    const c = new BlockChunker()
    expect(c.next(`${para(210)}\n\nx`)).toBe(para(210))

    // A plugin rewrites p1 longer: the tail must not be re-sent from a stale offset
    const full = `${para(230)}\n\nx`
    expect(c.rest(full)).not.toContain(para(230)) // no duplication of sent text
    expect(c.rest(full).endsWith("x")).toBe(true)
  })

  it("does not lose text across successive emits", () => {
    const c = new BlockChunker({ minChars: 10 })
    const first = `${para(20, "x")}\n\n`
    const full = `${first}${para(20, "y")}\n\nz`

    const a = c.next(first)
    const b = c.next(full)
    const rest = c.rest(full)

    expect(`${a}\n\n${b}\n\n${rest}`).toBe(`${para(20, "x")}\n\n${para(20, "y")}\n\nz`)
  })
})
