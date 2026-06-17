#!/usr/bin/env bun
// Tier-1 server: O(1) /global/health + /load?n= that runs a synchronous
// File.scan-style ancestry loop (file/index.ts:378-395) ON THE EVENT LOOP.
// Probe it from a SEPARATE process with probe-timeline.ts to see health stall.
const PORT = Number(process.argv[2] ?? 4790)
function fileScanSync(n: number): number {
  const files: string[] = []
  for (let i = 0; i < n; i++) files.push(`src/d${(i / 200) | 0}/sub/file_${i}.ts`)
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const file of files) {
    let current = file
    while (true) {
      const idx = current.lastIndexOf("/")
      if (idx <= 0) break
      current = current.slice(0, idx)
      if (seen.has(current)) continue
      seen.add(current)
      dirs.push(current + "/")
    }
  }
  return files.length + dirs.length
}
Bun.serve({
  port: PORT,
  fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === "/global/health") return new Response(JSON.stringify({ healthy: true }))
    if (u.pathname === "/load") {
      const n = Number(u.searchParams.get("n") ?? 300000)
      const r = fileScanSync(n) // synchronous: blocks the loop, like a File.scan fiber
      return new Response(String(r))
    }
    return new Response("ok")
  },
})
console.log(`tier1 server on http://127.0.0.1:${PORT}`)
