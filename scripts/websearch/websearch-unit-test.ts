// BYOK websearch pure-logic tests (ADR-042 / discussions/026): provider resolution
// priority, Tavily/IQS response parsing, unified output formatting.
// Run: bun run --bun scripts/websearch/websearch-unit-test.ts   (vendor patch applied)
import {
  resolveSearchProviders,
  parseTavilyResponse,
  parseIqsResponse,
  formatSearchOutput,
  type WebsearchSettings,
} from "../../vendor/opencode/packages/opencode/src/tool/websearch"

let pass = 0,
  fail = 0
const ok = (name: string, cond: boolean) => (console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}`), cond ? pass++ : fail++)
const eq = (name: string, actual: unknown, expected: unknown) => {
  const c = JSON.stringify(actual) === JSON.stringify(expected)
  if (!c) console.log(`    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`)
  ok(name, c)
}

// --- resolveSearchProviders: priority & gating -------------------------------
const both = { tavily: true, "aliyun-iqs": true }
const none = { tavily: false, "aliyun-iqs": false }

eq("no settings + no keys → empty", resolveSearchProviders(undefined, none), [])
eq("no settings + both keys → tavily first", resolveSearchProviders(undefined, both), ["tavily", "aliyun-iqs"])
eq("iqs key only → iqs", resolveSearchProviders(undefined, { tavily: false, "aliyun-iqs": true }), ["aliyun-iqs"])
eq(
  "explicit iqs moves to front",
  resolveSearchProviders({ provider: "aliyun-iqs" }, both),
  ["aliyun-iqs", "tavily"],
)
eq(
  "explicit provider without key falls back (stale config never bricks search)",
  resolveSearchProviders({ provider: "aliyun-iqs" }, { tavily: true, "aliyun-iqs": false }),
  ["tavily"],
)
eq("enabled:false kills everything", resolveSearchProviders({ enabled: false }, both), [])
eq("exa off by default", resolveSearchProviders({}, both), ["tavily", "aliyun-iqs"])
eq("exa opt-in appends last", resolveSearchProviders({ exa: true }, both), ["tavily", "aliyun-iqs", "exa"])
eq("exa opt-in alone works keyless", resolveSearchProviders({ exa: true }, none), ["exa"])
eq(
  "explicit exa + opt-in → exa first",
  resolveSearchProviders({ exa: true, provider: "exa" }, both),
  ["exa", "tavily", "aliyun-iqs"],
)
eq("explicit exa without opt-in ignored", resolveSearchProviders({ provider: "exa" }, both), ["tavily", "aliyun-iqs"])
eq("enabled:true but nothing available → empty", resolveSearchProviders({ enabled: true }, none), [])
eq(
  "provider:'auto' behaves like unset (clears a previous explicit choice)",
  resolveSearchProviders({ provider: "auto" }, both),
  ["tavily", "aliyun-iqs"],
)

// --- parseTavilyResponse -----------------------------------------------------
const tavily = parseTavilyResponse({
  query: "q",
  answer: "Short answer.",
  results: [
    { title: "A", url: "https://a.com", content: "snippet a", score: 0.91, published_date: "2026-07-01" },
    { title: "B", url: "https://b.com", content: "snippet b", score: 0.5 },
    { title: "no url dropped", content: "x" },
    { url: "https://c.com" },
  ],
})
eq("tavily: items parsed, url-less dropped", tavily.items.length, 3)
eq(
  "tavily: content → snippet (NOT raw_content)",
  tavily.items[0],
  { title: "A", url: "https://a.com", snippet: "snippet a", score: 0.91, publishedTime: "2026-07-01" },
)
eq("tavily: title falls back to url", tavily.items[2].title, "https://c.com")
eq("tavily: answer surfaced", tavily.answer, "Short answer.")
eq("tavily: malformed → empty", parseTavilyResponse({ detail: "err" }).items, [])
eq("tavily: empty answer → undefined", parseTavilyResponse({ answer: "", results: [] }).answer, undefined)

// --- parseIqsResponse --------------------------------------------------------
const iqs = parseIqsResponse({
  pageItems: [
    { title: "甲", link: "https://x.cn", snippet: "摘要", publishedTime: "2026-07-02T10:00:00", rerankScore: 0.88 },
    { title: "乙", link: "https://y.cn" },
    { title: "no link dropped", snippet: "x" },
  ],
  searchInformation: { searchTime: 300 },
})
eq("iqs: items parsed, link-less dropped", iqs.items.length, 2)
eq(
  "iqs: link → url, snippet/rerankScore/publishedTime mapped",
  iqs.items[0],
  { title: "甲", url: "https://x.cn", snippet: "摘要", score: 0.88, publishedTime: "2026-07-02T10:00:00" },
)
eq("iqs: malformed → empty", parseIqsResponse(null).items, [])

// --- formatSearchOutput ------------------------------------------------------
const out = formatSearchOutput("ai news 2026", "tavily", tavily.items, tavily.answer)
ok("format: header names provider", out.startsWith(`Web search results for "ai news 2026" (provider: tavily)`))
ok("format: answer line present", out.includes("Answer: Short answer."))
ok("format: numbered items with URL", out.includes("1. A") && out.includes("URL: https://a.com"))
ok("format: meta line (published/score)", out.includes("(published: 2026-07-01, score: 0.910)"))
const multiline = formatSearchOutput("q", "aliyun-iqs", [
  { title: "T", url: "https://t.cn", snippet: "line1\n  line2\nline3" },
])
ok("format: snippet newlines collapsed", multiline.includes("line1 line2 line3"))
const empty = formatSearchOutput("nothing", "aliyun-iqs", [])
ok("format: empty → actionable no-results message", empty.includes("No search results found") && empty.includes("aliyun-iqs"))
ok(
  "format: answer-only (no items) still renders answer",
  formatSearchOutput("q", "tavily", [], "only answer").includes("Answer: only answer"),
)

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
