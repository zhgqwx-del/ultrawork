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
})
