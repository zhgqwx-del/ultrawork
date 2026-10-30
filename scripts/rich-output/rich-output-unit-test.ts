// Run: bun run --bun scripts/rich-output/rich-output-unit-test.ts
// Exercise the actual vendor hook and compare its identity adapter with the
// host contract. No model account, host data directory or network is needed.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, PluginInput } from "../../vendor/opencode/packages/plugin/src"
import { DEFAULT_BRAND, parseBrandIdentity, resolveIdentity } from "../../packages/core/brand/src"
import { brandProviderPrompt, identityGuidance, productName } from "../../vendor/opencode/packages/opencode/src/plugin/brand-identity"
import {
  RichOutputPlugin,
  BRAND_GUIDANCE,
  VERBOSITY_OVERRIDE,
  baseIsTerse,
} from "../../vendor/opencode/packages/opencode/src/plugin/rich-output"

let passed = 0
function check(name: string, run: () => void) {
  run()
  console.log(`  [PASS] ${name}`)
  passed++
}

const TERSE = "You should minimize output tokens. Answer with fewer than 4 lines. One word answers are best."
const BASE = "You are a helpful coding assistant. Use the available tools to accomplish the user's task."
const ROLE = "You are a Team Leader. Delegate work to the assigned members using orchestrator_delegate."
const KEYS = ["ULTRAWORK_RICH_OUTPUT", "ULTRAWORK_BRAND_CONTEXT", "ULTRAWORK_BRAND_CONTEXT_FILE", "ULTRAWORK_BRAND_MANAGED", "OPENCODE_APP_NAME"]
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
const dir = mkdtempSync(join(tmpdir(), "ultrawork-prompt-test-"))
type Transform = NonNullable<Hooks["experimental.chat.system.transform"]>
const input = { sessionID: "brand-test", model: { api: { id: "fixture" } } } as Parameters<Transform>[0]
const pluginInput = {} as PluginInput

function environment(env: Record<string, string> = {}) {
  for (const key of KEYS) delete process.env[key]
  Object.assign(process.env, env)
}

function context(identity: unknown) {
  return { schemaVersion: 1, identity, instanceId: "brand-test-instance" }
}

function transform(hooks: Hooks) {
  assert.ok(hooks["experimental.chat.system.transform"])
  return hooks["experimental.chat.system.transform"]
}

async function render(hooks: Hooks, base = BASE) {
  const output = { system: [base, ROLE] }
  await transform(hooks)(input, output)
  assert.deepEqual(output.system.slice(0, 2), [base, ROLE])
  return output.system
}

function accepts(run: () => unknown): boolean {
  try { run(); return true } catch { return false }
}

try {
  environment()
  for (const identity of [DEFAULT_BRAND, resolveIdentity({ brandId: "mywork", productName: "MyWork" })]) {
    for (const family of ["default", "anthropic", "gpt", "gemini", "beast", "kimi", "codex", "trinity"]) {
      const stock = readFileSync(new URL(`../../vendor/opencode/packages/opencode/src/session/prompt/${family}.txt`, import.meta.url), "utf8")
      const branded = brandProviderPrompt(stock, identity.productName)
      const stockNewline = stock.indexOf("\n")
      const brandedNewline = branded.indexOf("\n")
      check(`${identity.productName}/${family}: stock identity adapted, remaining provider policy unchanged`, () => {
        assert.ok(branded.startsWith(`You are the intelligent assistant of ${JSON.stringify(identity.productName)}, a desktop application.`))
        assert.ok(!branded.split("\n")[0]!.match(/opencode|interactive CLI/i))
        const continuation = branded.slice(brandedNewline)
        if (["anthropic", "codex"].includes(family)) {
          assert.match(continuation, /^\n\r?\nYou help users with software engineering tasks\. Use the instructions below/)
          assert.equal(continuation.replace("You help users with software engineering tasks.", "You are an interactive CLI tool that helps users with software engineering tasks."), stock.slice(stockNewline))
        } else assert.equal(continuation, stock.slice(stockNewline))
        // These continuations are behavioral policy within the first line.
        if (family === "beast") assert.ok(branded.includes("please keep going until the user’s query is completely resolved"))
        if (family === "gpt") assert.ok(branded.includes("You and the user share the same workspace and collaborate to achieve the user's goals."))
        if (["default", "trinity", "gemini"].includes(family)) assert.ok(branded.includes(stock.slice(stock.indexOf(". ") + 2, stockNewline)))
      })
      // Exercise both checkout forms on every host. The original source can
      // already be CRLF on Windows; canonicalize before constructing variants.
      for (const eol of ["\n", "\r\n"]) {
        check(`${identity.productName}/${family}: preserves ${eol === "\n" ? "LF" : "CRLF"} outside known identity sentences`, () => {
          const variant = stock.replace(/\r\n/g, "\n").replace(/\n/g, eol)
          const result = brandProviderPrompt(variant, identity.productName)
          const rest = result.slice(result.indexOf("\n"))
          const restored = ["anthropic", "codex"].includes(family)
            ? rest.replace("You help users with software engineering tasks.", "You are an interactive CLI tool that helps users with software engineering tasks.")
            : rest
          assert.equal(restored, variant.slice(variant.indexOf("\n")))
          assert.ok(result.includes(JSON.stringify(identity.productName)))
        })
      }
    }
    check(`${identity.productName}: arbitrary prompts and upstream source links are never replaced`, () => {
      for (const custom of [BASE, ROLE, "User quote: You are opencode, an agent - preserve this.", "You are OpenCode, a custom agent with an assigned role."]) {
        assert.equal(brandProviderPrompt(custom, identity.productName), custom)
      }
      const stock = readFileSync(new URL("../../vendor/opencode/packages/opencode/src/session/prompt/anthropic.txt", import.meta.url), "utf8")
      assert.ok(brandProviderPrompt(stock, identity.productName).includes("https://github.com/anomalyco/opencode"))
      const quote = "\nUser quotation: You are an interactive CLI tool that helps users with software engineering tasks."
      assert.ok(brandProviderPrompt(stock + quote, identity.productName).endsWith(quote))
    })
  }
  check("provider prompt adaptation uses validated runtime identity and remains active with richness disabled", () => {
    environment({ ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context(resolveIdentity({ brandId: "mywork", productName: "MyWork" }))), ULTRAWORK_RICH_OUTPUT: "0" })
    assert.ok(brandProviderPrompt("You are OpenCode, the best coding agent on the planet.").includes('"MyWork"'))
    environment({ ULTRAWORK_BRAND_MANAGED: "1" })
    assert.throws(() => brandProviderPrompt("You are OpenCode, the best coding agent on the planet."), /context is missing/)
    environment()
  })
  for (const name of ["研发 Work", "R&D's Work", "Dollar $& Work"]) {
    check(`provider identity quotes literal product data: ${name}`, () => {
      const original = "You are OpenCode, the best coding agent on the planet.\nPreserve $& and 'quoted' policies."
      assert.equal(brandProviderPrompt(original, name), `You are the intelligent assistant of ${JSON.stringify(name)}, a desktop application.\nPreserve $& and 'quoted' policies.`)
    })
  }
  check("terse detection preserves per-model base selection", () => {
    assert.equal(baseIsTerse([TERSE]), true)
    assert.equal(baseIsTerse([BASE]), false)
    assert.equal(baseIsTerse([]), false)
  })

  for (const identity of [DEFAULT_BRAND, resolveIdentity({ brandId: "mywork", productName: "MyWork" }), resolveIdentity({ brandId: "team-work", productName: "团队 Work" })]) {
    environment({ ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context(identity)), OPENCODE_APP_NAME: identity.namespace })
    const hooks = await RichOutputPlugin(pluginInput)
    const system = await render(hooks, TERSE)
    check(`${identity.productName}: current identity appended and original base/Team role preserved`, () => {
      assert.equal(system.at(-1), identityGuidance(identity.productName))
      assert.ok(system.at(-1)?.includes(JSON.stringify(identity.productName)))
      assert.ok(system.at(-1)?.includes('For ordinary introductions and questions such as "Who are you?"'))
      assert.ok(system.at(-1)?.includes("upstream engine, not the name of this desktop application or its assistant"))
      assert.ok(system.includes(BRAND_GUIDANCE))
      assert.ok(system.includes(VERBOSITY_OVERRIDE))
      assert.ok(system.indexOf(VERBOSITY_OVERRIDE) < system.indexOf(BRAND_GUIDANCE))
      assert.equal(system.filter((value) => value.includes("<identity>")).length, 1)
      assert.ok(system.at(-1)?.includes("does not add requirements to the user's task"))
      if (!identity.isDefault) assert.ok(!system.at(-1)?.includes('"Ultrawork"'))
    })
    const regular = await render(hooks)
    check(`${identity.productName}: non-terse base does not gain verbosity override`, () => {
      assert.ok(!regular.includes(VERBOSITY_OVERRIDE))
      assert.ok(regular.includes(BRAND_GUIDANCE))
    })
    await hooks.config?.({ experimental: { rich_output: false } } as Parameters<NonNullable<Hooks["config"]>>[0])
    const disabled = await render(hooks, TERSE)
    check(`${identity.productName}: config kill switch disables richness, retains identity`, () => {
      assert.deepEqual(disabled, [TERSE, ROLE, identityGuidance(identity.productName)])
    })
    for (const value of ["0", "false"]) {
      process.env.ULTRAWORK_RICH_OUTPUT = value
      const output = await render(await RichOutputPlugin(pluginInput), TERSE)
      check(`${identity.productName}: env ${value} retains identity`, () => {
        assert.deepEqual(output, [TERSE, ROLE, identityGuidance(identity.productName)])
      })
    }
    process.env.ULTRAWORK_RICH_OUTPUT = "1"
    const forced = await render(hooks)
    check(`${identity.productName}: force-on overrides config`, () => assert.ok(forced.includes(BRAND_GUIDANCE)))
    delete process.env.ULTRAWORK_RICH_OUTPUT
    const independent = await render(await RichOutputPlugin(pluginInput))
    check(`${identity.productName}: separate plugin instances have independent config`, () => assert.ok(independent.includes(BRAND_GUIDANCE)))
  }

  environment()
  const standalone = await render(await RichOutputPlugin(pluginInput))
  check("standalone defaults to canonical Ultrawork without reading a context file", () => {
    assert.equal(productName({}, () => { throw new Error("Unexpected IO") }), "Ultrawork")
    assert.equal(standalone.at(-1), identityGuidance("Ultrawork"))
    assert.equal(productName({ OPENCODE_APP_NAME: "mywork" }), "Ultrawork")
    assert.ok(!BRAND_GUIDANCE.includes("<identity>"))
    for (const tag of ["language_consistency", "output_format", "task_execution", "sensitive_information"]) {
      assert.ok(BRAND_GUIDANCE.includes(`<${tag}>`))
    }
  })

  const brand = resolveIdentity({ brandId: "mywork", productName: "MyWork" })
  const file = join(dir, "context.json")
  const json = JSON.stringify(context(brand))
  writeFileSync(file, json)
  check("file-only and matching file/env contexts use the selected product name", () => {
    assert.equal(productName({ ULTRAWORK_BRAND_CONTEXT_FILE: file }), "MyWork")
    assert.equal(productName({ ULTRAWORK_BRAND_CONTEXT_FILE: file, ULTRAWORK_BRAND_CONTEXT: json }), "MyWork")
  })

  for (const [name, env] of [
    ["managed context missing", { ULTRAWORK_BRAND_MANAGED: "1" }],
    ["malformed JSON", { ULTRAWORK_BRAND_CONTEXT: "{" }],
    ["schema mismatch", { ULTRAWORK_BRAND_CONTEXT: JSON.stringify({ ...context(brand), schemaVersion: 2 }) }],
    ["invalid identity name", { ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context({ ...brand, productName: "wrong\nname" })) }],
    ["conflicting identity namespace", { ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context({ ...brand, namespace: "ultrawork" })) }],
    ["invalid actual identifier", { ULTRAWORK_BRAND_CONTEXT: JSON.stringify({ ...context(brand), actualIdentifier: DEFAULT_BRAND.identifier }) }],
    ["invalid owner PID", { ULTRAWORK_BRAND_CONTEXT: JSON.stringify({ ...context(brand), ownerPid: 0 }) }],
    ["missing instance", { ULTRAWORK_BRAND_CONTEXT: JSON.stringify({ ...context(brand), instanceId: "" }) }],
    ["newline instance", { ULTRAWORK_BRAND_CONTEXT: JSON.stringify({ ...context(brand), instanceId: "brand-test-instance\n" }) }],
    ["CRLF instance", { ULTRAWORK_BRAND_CONTEXT: JSON.stringify({ ...context(brand), instanceId: "brand-test-instance\r\n" }) }],
    ["wrong namespace environment", { ULTRAWORK_BRAND_CONTEXT: json, OPENCODE_APP_NAME: "ultrawork" }],
    ["relative file", { ULTRAWORK_BRAND_CONTEXT_FILE: "context.json" }],
    ["missing file", { ULTRAWORK_BRAND_CONTEXT_FILE: join(dir, "missing.json") }],
    ["conflicting file identity", { ULTRAWORK_BRAND_CONTEXT_FILE: file, ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context(DEFAULT_BRAND)) }],
    ["conflicting file instance", { ULTRAWORK_BRAND_CONTEXT_FILE: file, ULTRAWORK_BRAND_CONTEXT: JSON.stringify({ ...context(brand), instanceId: "other-instance" }) }],
  ] as [string, Record<string, string>][]) {
    for (const value of ["0", "1"]) {
      environment({ ...env, ULTRAWORK_RICH_OUTPUT: value })
      const hooks = await RichOutputPlugin(pluginInput)
      await assert.rejects(() => render(hooks))
      check(`${name}: transform blocks request with richness ${value}`, () => {})
    }
  }

  environment({ ULTRAWORK_BRAND_CONTEXT: json })
  const quoted = "A user's quoted product is UltraWork; keep ~/.ultrawork and ULTRAWORK_* technical identifiers unchanged."
  const preserved = await render(await RichOutputPlugin(pluginInput), quoted)
  check("identity append never rewrites quoted brands, technical identifiers or paths", () => assert.equal(preserved[0], quoted))

  const identities: unknown[] = [DEFAULT_BRAND, brand]
  for (const key of Object.keys(brand)) {
    identities.push({ ...brand, [key]: undefined }, { ...brand, [key]: "wrong" })
  }
  for (const name of ["MyWork", "My Work", "团队 Work", "O'Brien", "Ultrawork", "Ｕｌｔｒａｗｏｒｋ", "Ultrawork Dev", " ", "x\ny", "a/b", "CON", "bad.", "a".repeat(81)]) {
    identities.push({ ...brand, productName: name })
  }
  for (const id of ["desktop", "opencode", "codex", "claude", "gemini", "qoder", "hermes", "con", "x", "bad_thing", "my-work", "mywork\n", "mywork\r\n", "a".repeat(33)]) {
    identities.push({ ...brand, brandId: id, namespace: id, identifier: `com.ultrawork.${id}`, mainBinaryName: id })
  }
  for (let index = 0; index < identities.length; index++) {
    const identity = identities[index]
    check(`identity contract parity ${index + 1}`, () => {
      assert.equal(
        accepts(() => productName({ ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context(identity)) })),
        accepts(() => parseBrandIdentity(identity)),
      )
    })
  }
  console.log(`\n${passed} passed, 0 failed`)
} finally {
  environment()
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
}
