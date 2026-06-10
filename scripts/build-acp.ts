#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"
import { computeSourceHash, needsRebuild, saveHash } from "./build-hash"

const rootDir = path.resolve(import.meta.dir, "..")
const acpDir = path.join(rootDir, "packages/agent/acp-client")
const tauriDir = path.join(rootDir, "packages/client/desktop/src-tauri")
const tauriBinDir = path.join(tauriDir, "binaries")

const ACP_PORT = 4099

// Map Tauri target triple → bun --target value
const BUN_TARGET_MAP: Record<string, { bunTarget: string; exe: boolean }> = {
  "aarch64-apple-darwin":      { bunTarget: "bun-darwin-arm64",  exe: false },
  "x86_64-apple-darwin":       { bunTarget: "bun-darwin-x64",    exe: false },
  "x86_64-pc-windows-msvc":    { bunTarget: "bun-windows-x64",   exe: true  },
  "x86_64-unknown-linux-gnu":  { bunTarget: "bun-linux-x64",     exe: false },
  "aarch64-unknown-linux-gnu": { bunTarget: "bun-linux-arm64",   exe: false },
}

const getCurrentTauriTarget = () => {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  } else if (process.platform === "win32") {
    return "x86_64-pc-windows-msvc"
  } else {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  }
}

const targetFlag = (() => {
  const idx = process.argv.indexOf("--target")
  return idx !== -1 ? process.argv[idx + 1] : undefined
})()

const tauriTarget = targetFlag || getCurrentTauriTarget()
const targetInfo = BUN_TARGET_MAP[tauriTarget]
if (!targetInfo) {
  console.error(`❌ Unknown target: ${tauriTarget}`)
  console.error(`   Supported: ${Object.keys(BUN_TARGET_MAP).join(", ")}`)
  process.exit(1)
}

const suffix = targetInfo.exe ? ".exe" : ""
const force = process.argv.includes("--force")

await $`mkdir -p ${tauriBinDir}`

const outFile = path.join(tauriBinDir, `acp-client-${tauriTarget}${suffix}`)
const hashFile = path.join(tauriBinDir, `.acp-client-${tauriTarget}.hash`)

const currentHash = await computeSourceHash(
  acpDir,
  ["src/**/*.ts"],
  [
    path.join(acpDir, "package.json"),
    path.join(rootDir, "bun.lock"),
  ],
)

if (!force && !await needsRebuild(hashFile, currentHash, outFile)) {
  const size = Bun.file(outFile).size / 1024 / 1024
  console.log(`ACP Client up-to-date, skipping build (${size.toFixed(1)} MB)`)
  process.exit(0)
}

console.log(`Building ACP Client for target: ${tauriTarget}`)

await $`cd ${acpDir} && bun build --compile --target=${targetInfo.bunTarget} src/index.ts --outfile ${outFile}`

// Apple Silicon requires a valid ad-hoc signature to run bun-compiled macOS binaries.
const isMacOSTarget = tauriTarget.endsWith("-apple-darwin")
if (process.platform === "darwin" && isMacOSTarget) {
  const resign = await $`codesign --remove-signature ${outFile} 2>/dev/null; codesign -s - ${outFile}`.nothrow()
  if (resign.exitCode !== 0) {
    console.error(`Failed to ad-hoc sign binary (exit ${resign.exitCode})`)
    console.error(`Apple Silicon requires a valid signature to run the binary`)
    process.exit(1)
  }
  console.log(`Ad-hoc signed: ${outFile}`)
}

await saveHash(hashFile, currentHash)

// Stale-process guard: Tauri's start_sidecar reuses any healthy process on
// :4099 (prepare_port). The sources just changed, so a process left over from
// a previous run (or a manual `bun run dev`) would serve OLD code — kill it so
// the next app start spawns the freshly built binary. Skip-build runs don't
// get here: an unchanged binary makes reuse harmless.
if (tauriTarget === getCurrentTauriTarget() && process.platform !== "win32") {
  const stale = await $`lsof -ti tcp:${ACP_PORT}`.nothrow().text()
  const pids = stale.trim().split("\n").filter(Boolean)
  if (pids.length > 0) {
    await $`kill ${pids}`.nothrow()
    console.log(`Killed stale ACP Client on :${ACP_PORT} (pid ${pids.join(", ")}) — rebuilt code takes over on next start`)
  }
}

const size = Bun.file(outFile).size / 1024 / 1024
console.log(`ACP Client ready: acp-client-${tauriTarget}${suffix} (${size.toFixed(1)} MB)`)
