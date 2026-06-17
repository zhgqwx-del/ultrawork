#!/usr/bin/env bun
// Generic separate-process prober. Streams /global/health probes; mid-stream fires
// ONE trigger request (the load), and records the health latency timeline so the
// spike aligns with the trigger. Mirrors the fork's rule: a probe >500ms == FAIL.
//
// Usage: bun probe-timeline.ts <healthURL> <triggerURL> <label>
const healthURL = process.argv[2]
const triggerURL = process.argv[3]
const label = process.argv[4] ?? "run"
const PROBE_INTERVAL = 15
const TOTAL_MS = Number(process.env.TOTAL_MS ?? 4000)
const FIRE_AT = Number(process.env.FIRE_AT ?? 500)
const FIRE_REPEAT = Number(process.env.FIRE_REPEAT ?? 1) // simulate snapshot add Nx/turn
const FIRE_GAP = Number(process.env.FIRE_GAP ?? 250)
const FAIL = 500

type S = { t: number; ms: number; timeout: boolean }
const samples: S[] = []
async function probe(t0: number) {
  const s = performance.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FAIL)
  try {
    await (await fetch(healthURL, { signal: ac.signal })).text()
    clearTimeout(timer)
    samples.push({ t: Math.round(performance.now() - t0), ms: performance.now() - s, timeout: false })
  } catch {
    clearTimeout(timer)
    samples.push({ t: Math.round(performance.now() - t0), ms: performance.now() - s, timeout: true })
  }
}
let triggerMs = -1
async function fire() {
  const s = performance.now()
  try { await (await fetch(triggerURL)).text() } catch {}
  const d = performance.now() - s
  if (triggerMs < 0) triggerMs = d
}

const t0 = performance.now()
let fireCount = 0
let nextFire = FIRE_AT
const ps: Promise<void>[] = []
while (performance.now() - t0 < TOTAL_MS) {
  if (fireCount < FIRE_REPEAT && performance.now() - t0 >= nextFire) {
    fireCount++; nextFire += FIRE_GAP; fire()
  }
  ps.push(probe(t0))
  await new Promise((r) => setTimeout(r, PROBE_INTERVAL))
}
await Promise.all(ps)
samples.sort((a, b) => a.t - b.t)
const lat = samples.map((s) => s.ms).sort((a, b) => a - b)
const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]
const over = samples.filter((s) => s.ms > FAIL || s.timeout)
console.log(`\n===== [${label}] =====`)
console.log(`trigger latency=${triggerMs.toFixed(0)}ms  samples=${samples.length}`)
console.log(`health ms: p50=${pct(50).toFixed(1)} p90=${pct(90).toFixed(1)} p99=${pct(99).toFixed(1)} max=${Math.max(...lat).toFixed(1)}`)
console.log(`>${FAIL}ms (fork=FAIL): ${over.length}/${samples.length}`)
console.log(`timeline (t=ms | health ms):`)
for (const s of samples) {
  if (s.t < FIRE_AT - 100 || s.t > FIRE_AT + 2500) continue
  const bar = "#".repeat(Math.min(70, Math.round(s.ms / 10)))
  console.log(`  ${String(s.t).padStart(5)} | ${s.ms.toFixed(0).padStart(5)} ${bar}${s.timeout ? " TIMEOUT" : s.ms > FAIL ? " FAIL" : ""}`)
}
