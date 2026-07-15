#!/usr/bin/env bun
/**
 * Diagnostic for the free OpenCode Zen "trial" default model (ADR-057 / discussions/040).
 *
 * Turns the one-off empirical probes behind ADR-057 into a re-runnable check. Run it after any
 * `vendor/opencode` bump (the free set drifts, models get deprecated) to confirm the trial still
 * works before shipping. NOT wired into CI — it needs the built sidecar and live network to the
 * Zen gateway; it's an on-demand check, like `scripts/verify-windows-runtime.ps1`.
 *
 *   bun run --bun scripts/verify-free-zen.ts
 *
 * It verifies, in order:
 *   A. Fresh install (empty config) → the sidecar's GET /provider lists `opencode` free models.
 *   B. The live Zen gateway still serves the preference-list models anonymously (apiKey "public")
 *      with tool-calling — the exact property orderedFreeCandidates()/P1 relies on.
 *   C. The first preference model (what P3 seeds) actually works anonymously.
 *
 * Exit code 0 = all good; non-zero = a property the trial depends on has regressed.
 */

import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Keep in sync with FREE_MODEL_PREFERENCE in
// packages/client/desktop/src/lib/free-model.ts (single source of truth for the app).
const FREE_MODEL_PREFERENCE = [
  "big-pickle",
  "deepseek-v4-flash-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
  "hy3-free",
]

const ZEN_BASE = "https://opencode.ai/zen/v1"
const APP_NAME = "ultrawork"

function sidecarBinary(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
  return join(
    import.meta.dir,
    "..",
    "packages/client/desktop/src-tauri/binaries",
    `opencode-server-${arch}-apple-darwin`,
  )
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** A minimal anonymous chat completion with a tool, mirroring what an agent turn needs. */
async function probeAnonymous(model: string): Promise<{ ok: boolean; toolcall: boolean; note: string }> {
  try {
    const res = await fetch(`${ZEN_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer public", "Content-Type": "application/json" },
      body: JSON.stringify({
        // Generous cap: some free models emit a reasoning preamble before the tool call, and a
        // too-small budget truncates the response before `tool_calls` appears (false negative).
        model,
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "get weather",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        }],
      }),
      signal: AbortSignal.timeout(40000),
    })
    const body = await res.text()
    if (!res.ok) {
      const m = body.match(/"message":"([^"]*)"/)
      return { ok: false, toolcall: false, note: `HTTP ${res.status} ${m?.[1] ?? ""}`.trim() }
    }
    const toolcall = /"tool_calls"|"finish_reason":"tool_calls"|get_weather/.test(body)
    return { ok: true, toolcall, note: "cost 0" }
  } catch (e) {
    return { ok: false, toolcall: false, note: String(e instanceof Error ? e.message : e) }
  }
}

let failures = 0
const fail = (msg: string) => { console.error(`  ✗ ${msg}`); failures++ }
const pass = (msg: string) => console.log(`  ✓ ${msg}`)

// ── A. Fresh-install sidecar lists opencode free models ──────────────────────
console.log("A. Fresh-install /provider lists opencode free models")
const bin = sidecarBinary()
const port = 47000 + Math.floor((Date.now() % 1000))
const freshHome = mkdtempSync(join(tmpdir(), "uw-verify-zen-"))
const child = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
  env: { ...process.env, HOME: freshHome, XDG_CONFIG_HOME: join(freshHome, ".config"), OPENCODE_APP_NAME: APP_NAME },
  stdio: "ignore",
})

let connectedFree: string[] = []
try {
  if (!(await waitForHealth(port, 30000))) {
    fail("sidecar did not become healthy in 30s")
  } else {
    const res = await fetch(`http://127.0.0.1:${port}/provider`, { signal: AbortSignal.timeout(10000) })
    const data = (await res.json()) as { all?: Array<{ id: string; models?: Record<string, { cost?: { input?: number } }> }>; connected?: string[] }
    const opencodeConnected = (data.connected ?? []).includes("opencode")
    if (!opencodeConnected) fail("`opencode` is not in the connected provider set")
    else pass("`opencode` provider auto-connected without a key")
    const oc = (data.all ?? []).find((p) => p.id === "opencode")
    connectedFree = Object.entries(oc?.models ?? {}).filter(([, m]) => m.cost?.input === 0).map(([id]) => id)
    if (connectedFree.length === 0) fail("no free (cost.input===0) opencode models listed")
    else pass(`${connectedFree.length} free opencode models listed: ${connectedFree.join(", ")}`)
  }
} finally {
  child.kill("SIGKILL")
}

// ── B. Live gateway still serves the preference list anonymously with tools ──
console.log("\nB. Live Zen gateway anonymous availability (preference list)")
const results: Record<string, { ok: boolean; toolcall: boolean; note: string }> = {}
for (const model of FREE_MODEL_PREFERENCE) {
  const r = await probeAnonymous(model)
  results[model] = r
  const label = r.ok && r.toolcall ? "✓" : r.ok ? "~" : "✗"
  console.log(`  ${label} ${model.padEnd(26)} ${r.ok ? "usable" : "unusable"}${r.toolcall ? " + tools" : ""}  ${r.note}`)
}
const anyUsable = FREE_MODEL_PREFERENCE.some((m) => results[m]?.ok && results[m]?.toolcall)
if (!anyUsable) fail("no preference-list model is anonymously usable with tools — the trial is broken")
else pass("at least one preference-list model is anonymously usable with tools")

// ── C. The first-seeded model works ──────────────────────────────────────────
console.log("\nC. First-preference model (what P3 seeds first)")
const first = FREE_MODEL_PREFERENCE[0]
if (results[first]?.ok && results[first]?.toolcall) {
  pass(`${first} works anonymously with tools`)
} else {
  // Not fatal on its own (fallback covers it), but worth flagging loudly.
  console.warn(`  ! ${first} is NOT usable — P3 will fall back on first send. Consider reordering FREE_MODEL_PREFERENCE.`)
}

// Cross-check: is the app's preference list still represented in the sidecar's free set?
if (connectedFree.length > 0) {
  const missing = FREE_MODEL_PREFERENCE.filter((m) => !connectedFree.includes(m))
  if (missing.length === FREE_MODEL_PREFERENCE.length) {
    fail("NONE of the preference list appears in the sidecar's connected free set — list is stale")
  } else if (missing.length > 0) {
    console.warn(`  ! preference models not in current free set (drifted/deprecated?): ${missing.join(", ")}`)
  }
}

console.log(failures === 0 ? "\n✅ Free Zen trial verification passed." : `\n❌ ${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
