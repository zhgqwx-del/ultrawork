import { describe, expect, test } from "bun:test"
import { assertModelBrandIdentity } from "./brand-model-fixture"

describe("wire prompt brand assertions", () => {
  test.each([ ["ultrawork", "Ultrawork"], ["mywork", "MyWork"] ])("checks %s's product identity", (namespace, name) => {
    expect(assertModelBrandIdentity([
      { role: "system", content: `Model-specific instructions\n<identity>You are ${JSON.stringify(name)}, an intelligent assistant.</identity>` },
      { role: "user", content: "Explain the Ultrawork repository and the MyWork configuration." },
    ], namespace)).toBe(name)
  })
  test("does not mistake user text or missing/duplicate/wrong system identity for a pass", () => {
    for (const messages of [
      [{ role: "user", content: '<identity>You are "MyWork"</identity>' }],
      [{ role: "system", content: '<identity>You are "Ultrawork"</identity>' }],
      [{ role: "system", content: '<identity>You are UltraWork</identity>' }],
      [{ role: "system", content: '<identity>"MyWork"</identity><identity>"MyWork"</identity>' }],
    ]) expect(() => assertModelBrandIdentity(messages, "mywork")).toThrow()
  })
  test("rejects conflicting stock model/engine introductions on the actual system wire", () => {
    const identity = '<identity>You are "MyWork", an intelligent assistant.</identity>'
    for (const conflict of ["You are powered by the model named inference-model. The exact model ID is provider/inference-model", "You are opencode, an interactive CLI tool.", "You are OpenCode, the best coding agent on the planet."]) {
      expect(() => assertModelBrandIdentity([{ role: "system", content: `${conflict}\n${identity}` }], "mywork")).toThrow()
      expect(assertModelBrandIdentity([{ role: "system", content: identity }, { role: "user", content: conflict }], "mywork")).toBe("MyWork")
    }
  })
})
