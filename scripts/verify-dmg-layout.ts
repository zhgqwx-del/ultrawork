#!/usr/bin/env bun
// Verify the macOS DMG install window puts the .app LEFT of the Applications
// folder — the drag-to-the-right convention every mac user expects.
//
// Why this needs checking at all: the icon coordinates live in a `.DS_Store`
// that `bundle_dmg` only writes by driving Finder through an AppleScript. When
// `CI=true`, tauri-bundler passes `--skip-jenkins`, that AppleScript never
// runs, and the DMG ships without `.DS_Store`. Finder then arranges by name,
// so `Applications` (A) lands left of `Ultrawork.app` (U) — backwards. See
// `TAURI_BUNDLER_DMG_IGNORE_CI` in build-release.ts.
//
// Usage: bun run --bun scripts/verify-dmg-layout.ts <path-to.dmg>
//        bun run --bun scripts/verify-dmg-layout.ts --self-test
import { $ } from "bun"
import os from "os"
import path from "path"
import fs from "fs/promises"

const FOLDER_ICON = "Applications"
const rootDir = path.resolve(import.meta.dir, "..")

// `--self-test` runs before the darwin guard so it works on every CI runner.
// The real check only fires when a DMG exists, i.e. at release time — so
// without this, both the parser and the env opt-out it guards are unverified
// until the day someone cuts a tag.
if (process.argv.includes("--self-test")) {
  await selfTest()
  process.exit(0)
}

if (process.platform !== "darwin") {
  console.log("⏭️  Not macOS — skipping DMG layout check")
  process.exit(0)
}

const dmgPath = process.argv[2]
if (!dmgPath) {
  console.error("❌ usage: verify-dmg-layout.ts <path-to.dmg> [app-bundle-name]")
  process.exit(1)
}

// Track the icon by whatever the bundle is actually called, so a productName
// change surfaces as a rename here rather than a silently-skipped assertion.
// The caller may override the name: `--unsigned` builds ship as "<product> Dev"
// via `tauri build --config`, which never touches tauri.conf.json — reading the
// file alone would look for a bundle that is not in that DMG and report the icon
// as missing, i.e. fail the layout of a perfectly good disk image.
const tauriConf = await Bun.file(
  path.join(rootDir, "packages/client/desktop/src-tauri/tauri.conf.json"),
).json()
const APP_ICON = process.argv[3] ? `${process.argv[3]}.app` : `${tauriConf.productName}.app`

/**
 * Pull an icon's (x, y) out of a `.DS_Store`.
 *
 * Records are laid out as [nameLen u32][name UTF-16BE][structId][type][data].
 * Rather than walk the buddy-allocator B-tree, locate the UTF-16BE name and
 * confirm it is framed by its length prefix and a trailing `Iloc`+`blob`
 * header — that pairing is specific enough to be unambiguous here.
 */
function readIconPosition(store: Uint8Array, name: string): { x: number; y: number } | null {
  const dv = new DataView(store.buffer, store.byteOffset, store.byteLength)
  const nameBytes = new Uint8Array(name.length * 2)
  for (let i = 0; i < name.length; i++) {
    nameBytes[i * 2] = name.charCodeAt(i) >> 8
    nameBytes[i * 2 + 1] = name.charCodeAt(i) & 0xff
  }
  const header = [..."Ilocblob"].map((c) => c.charCodeAt(0))

  for (let p = 4; p + nameBytes.length + 8 + 12 <= store.length; p++) {
    if (!nameBytes.every((b, j) => store[p + j] === b)) continue
    if (dv.getUint32(p - 4) !== name.length) continue
    const h = p + nameBytes.length
    if (!header.every((b, j) => store[h + j] === b)) continue
    return { x: dv.getUint32(h + 12), y: dv.getUint32(h + 16) }
  }
  return null
}

/**
 * Exercise the parser against synthesized records, and assert the env opt-out
 * that produces a positioned `.DS_Store` in the first place is still wired up.
 * Neither needs a DMG, so this runs as a merge gate on all three platforms.
 */
async function selfTest() {
  const failures: string[] = []
  let ran = 0
  const check = (name: string, ok: boolean) => {
    ran++
    if (!ok) failures.push(name)
  }

  // One `.DS_Store` Iloc record: [nameLen u32][name UTF-16BE]["Iloc"]["blob"][len u32][x u32][y u32][8 bytes]
  const record = (name: string, x: number, y: number) => {
    const bytes = new Uint8Array(4 + name.length * 2 + 8 + 4 + 16)
    const dv = new DataView(bytes.buffer)
    dv.setUint32(0, name.length)
    for (let i = 0; i < name.length; i++) dv.setUint16(4 + i * 2, name.charCodeAt(i))
    const h = 4 + name.length * 2
    bytes.set([..."Ilocblob"].map((c) => c.charCodeAt(0)), h)
    dv.setUint32(h + 8, 16)
    dv.setUint32(h + 12, x)
    dv.setUint32(h + 16, y)
    return bytes
  }
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) (out.set(p, at), (at += p.length))
    return out
  }

  const store = concat(record("Ultrawork.app", 180, 170), record(FOLDER_ICON, 480, 170))
  const app = readIconPosition(store, "Ultrawork.app")
  const folder = readIconPosition(store, FOLDER_ICON)
  check("reads app position", app?.x === 180 && app?.y === 170)
  check("reads Applications position", folder?.x === 480 && folder?.y === 170)
  check("app is left of Applications", !!app && !!folder && app.x < folder.x)
  check("absent icon yields null", readIconPosition(store, "Nope.app") === null)

  // A truncated store must return null, never read past the end.
  const truncated = store.slice(0, store.length - 10)
  let threw = false
  try {
    readIconPosition(truncated, FOLDER_ICON)
  } catch {
    threw = true
  }
  check("truncated store does not throw", !threw)

  // Names are UTF-16BE, so non-ASCII product names must round-trip.
  const cjk = record("超级工作.app", 180, 170)
  check("non-ASCII name parses", readIconPosition(cjk, "超级工作.app")?.x === 180)

  // A reversed layout must be detectable — the whole point of the check.
  const bad = concat(record("Ultrawork.app", 480, 170), record(FOLDER_ICON, 180, 170))
  const badApp = readIconPosition(bad, "Ultrawork.app")
  const badFolder = readIconPosition(bad, FOLDER_ICON)
  check("reversed layout is caught", !!badApp && !!badFolder && badApp.x >= badFolder.x)

  // Guard the fix itself: CI sets CI=true, which makes tauri-bundler skip the
  // AppleScript that writes .DS_Store. Delete this opt-out and every DMG ships
  // name-sorted — with nothing else in CI to notice.
  //
  // Comments are stripped first: they discuss the env var by name, so a plain
  // substring match stays green even after the code is deleted (caught by
  // deleting it). Matching `…: … "true"` also pins the default to on, not
  // merely the identifier's presence.
  const releaseScript = (await Bun.file(path.join(rootDir, "scripts/build-release.ts")).text())
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
  check(
    "build-release.ts still defaults TAURI_BUNDLER_DMG_IGNORE_CI to true",
    /TAURI_BUNDLER_DMG_IGNORE_CI:[^\n]*"true"/.test(releaseScript),
  )
  check("build-release.ts still runs the layout check", releaseScript.includes("verify-dmg-layout.ts"))

  if (failures.length > 0) {
    console.error(`❌ verify-dmg-layout self-test failed:\n   - ${failures.join("\n   - ")}`)
    process.exit(1)
  }
  console.log(`✅ verify-dmg-layout self-test passed (${ran} assertions)`)
}

const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "ultrawork-dmg-"))
let mounted = false
// Collected rather than thrown: `process.exit()` inside the `try` would skip
// the `finally`, leaving the DMG mounted and the temp dir behind — precisely
// on the failure path that most needs to clean up after itself.
const problems: string[] = []

try {
  await $`hdiutil attach -readonly -nobrowse -mountpoint ${mountPoint} ${dmgPath}`.quiet()
  mounted = true

  const store = Bun.file(path.join(mountPoint, ".DS_Store"))
  if (!(await store.exists())) {
    problems.push(
      "DMG has no .DS_Store — Finder will arrange icons by name,",
      `   putting ${FOLDER_ICON} left of ${APP_ICON}.`,
      "   The bundle_dmg AppleScript was skipped (--skip-jenkins on CI?).",
    )
  } else {
    const bytes = new Uint8Array(await store.arrayBuffer())
    const app = readIconPosition(bytes, APP_ICON)
    const folder = readIconPosition(bytes, FOLDER_ICON)
    if (!app || !folder) {
      problems.push(
        `.DS_Store lacks icon positions (${APP_ICON}: ${!!app}, ${FOLDER_ICON}: ${!!folder})`,
      )
    } else if (app.x >= folder.x) {
      problems.push(
        `DMG icons are reversed: ${APP_ICON} x=${app.x} is not left of ${FOLDER_ICON} x=${folder.x}`,
      )
    } else {
      console.log(`   DMG layout ✓ (${APP_ICON} x=${app.x} → ${FOLDER_ICON} x=${folder.x})`)
    }
  }
} finally {
  if (mounted) {
    let detached = await $`hdiutil detach ${mountPoint}`.quiet().nothrow()
    if (detached.exitCode !== 0) {
      detached = await $`hdiutil detach -force ${mountPoint}`.quiet().nothrow()
    }
    // Say so rather than leak in silence: a stuck volume will make the next
    // build's mkdtemp+attach look inexplicably broken.
    if (detached.exitCode !== 0) {
      console.warn(`⚠️  Could not detach ${mountPoint} — volume left mounted.`)
    }
  }
  // Non-recursive on purpose: if the detach above failed, the mount point is
  // still a live volume and a recursive delete would walk into it.
  await fs.rmdir(mountPoint).catch(() => {})
}

if (problems.length > 0) {
  console.error(`❌ ${problems.join("\n")}`)
  process.exit(1)
}
