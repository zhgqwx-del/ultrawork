// Rich-output prompt plugin tests (discussions/048): the plugin appends branded
// adaptive-formatting guidance to the assembled system prompt via
// `experimental.chat.system.transform`, PRESERVING each model's base prompt
// (never replacing it), and only neutralises default.txt's terse clauses when
// they are actually present. Verifies: append behavior, base-preservation, the
// terse-detection gate, and the config/env kill switch.
// Run: bun run --bun scripts/rich-output/rich-output-unit-test.ts   (vendor patch applied)
import {
  RichOutputPlugin,
  BRAND_GUIDANCE,
  VERBOSITY_OVERRIDE,
  baseIsTerse,
} from "../../vendor/opencode/packages/opencode/src/plugin/rich-output"

let pass = 0,
  fail = 0
const ok = (name: string, cond: boolean) => (console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}`), cond ? pass++ : fail++)

// Real fragments of the two base prompts we care about.
const DEFAULT_TXT_BASE =
  "You should be concise, direct, and to the point.\nIMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness.\nYou MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail. One word answers are best."
// A non-default base (e.g. anthropic.txt) never contains those terse clauses.
const ANTHROPIC_LIKE_BASE =
  "You are a helpful coding assistant. Use the available tools to accomplish the user's task. Prefer editing existing files over creating new ones."

async function getTransform() {
  const hooks = await RichOutputPlugin({} as any)
  const fn = hooks["experimental.chat.system.transform"]
  if (!fn) throw new Error("plugin did not register experimental.chat.system.transform")
  return fn
}
const fakeInput = { sessionID: "s1", model: { api: { id: "qwen3.7-plus" } } } as any

// --- baseIsTerse: detection is precise ---------------------------------------
ok("baseIsTerse: default.txt signature → true", baseIsTerse([DEFAULT_TXT_BASE]) === true)
ok("baseIsTerse: anthropic-like base → false", baseIsTerse([ANTHROPIC_LIKE_BASE]) === false)
ok("baseIsTerse: empty → false", baseIsTerse([]) === false)

// Ensure a clean enabled state (env must be unset; config default ON).
delete process.env["ULTRAWORK_RICH_OUTPUT"]

// --- enabled + terse base: override + brand appended, base preserved ---------
{
  const transform = await getTransform()
  const output = { system: [DEFAULT_TXT_BASE] }
  await transform(fakeInput, output)
  ok("terse base: original base still present (preserved, not replaced)", output.system[0] === DEFAULT_TXT_BASE)
  ok("terse base: VERBOSITY_OVERRIDE appended", output.system.includes(VERBOSITY_OVERRIDE))
  ok("terse base: BRAND_GUIDANCE appended", output.system.includes(BRAND_GUIDANCE))
  ok("terse base: override comes before brand guidance", output.system.indexOf(VERBOSITY_OVERRIDE) < output.system.indexOf(BRAND_GUIDANCE))
  ok("brand guidance contains UltraWork identity", BRAND_GUIDANCE.includes("You are UltraWork"))
  ok("brand guidance has language_consistency + output_format + task_execution + sensitive", ["<language_consistency>", "<output_format>", "<task_execution>", "<sensitive_information>"].every((t) => BRAND_GUIDANCE.includes(t)))
}

// --- enabled + non-terse base: brand only, NO override, base untouched -------
{
  const transform = await getTransform()
  const output = { system: [ANTHROPIC_LIKE_BASE] }
  await transform(fakeInput, output)
  ok("non-terse base: original base untouched", output.system[0] === ANTHROPIC_LIKE_BASE)
  ok("non-terse base: BRAND_GUIDANCE appended", output.system.includes(BRAND_GUIDANCE))
  ok("non-terse base: NO verbosity override (base has no terse clauses)", !output.system.includes(VERBOSITY_OVERRIDE))
}

// --- kill switch via config: experimental.rich_output === false --------------
{
  const hooks = await RichOutputPlugin({} as any)
  await hooks["config"]!({ experimental: { rich_output: false } } as any)
  const output = { system: [DEFAULT_TXT_BASE] }
  await hooks["experimental.chat.system.transform"]!(fakeInput, output)
  ok("config kill switch: nothing appended when rich_output:false", output.system.length === 1 && output.system[0] === DEFAULT_TXT_BASE)
  // restore default-ON for subsequent tests
  await hooks["config"]!({ experimental: {} } as any)
}

// --- kill switch via env: ULTRAWORK_RICH_OUTPUT=0 overrides config ON --------
{
  process.env["ULTRAWORK_RICH_OUTPUT"] = "0"
  const transform = await getTransform()
  const output = { system: [DEFAULT_TXT_BASE] }
  await transform(fakeInput, output)
  ok("env kill switch (=0): nothing appended even with config ON", output.system.length === 1)
  delete process.env["ULTRAWORK_RICH_OUTPUT"]
}

// --- env force-on: ULTRAWORK_RICH_OUTPUT=1 overrides config OFF --------------
{
  const hooks = await RichOutputPlugin({} as any)
  await hooks["config"]!({ experimental: { rich_output: false } } as any) // config says OFF
  process.env["ULTRAWORK_RICH_OUTPUT"] = "1" // env forces ON
  const output = { system: [ANTHROPIC_LIKE_BASE] }
  await hooks["experimental.chat.system.transform"]!(fakeInput, output)
  ok("env force-on (=1): appends despite config OFF", output.system.includes(BRAND_GUIDANCE))
  delete process.env["ULTRAWORK_RICH_OUTPUT"]
  await hooks["config"]!({ experimental: {} } as any)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
