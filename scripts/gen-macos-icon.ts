#!/usr/bin/env bun
/** Regenerate the default macOS-only ICNS without changing shared artwork. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { equivalentIcnsRepresentations, writeMacosIcon } from "./macos-icon"

export const MACOS_ICON_PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const DEFAULT_MACOS_ICON_FILE = path.join("packages", "client", "desktop", "src-tauri", "icons", "icon-macos.icns")
export async function generateDefaultMacosIcon(check = false, root = MACOS_ICON_PROJECT_ROOT) {
  const input = path.join(root, "design", "logo", "icon-1024.png")
  const output = path.join(root, DEFAULT_MACOS_ICON_FILE)
  if (!check) return writeMacosIcon(input, output, root)
  const temporary = mkdtempSync(path.join(tmpdir(), "ultrawork-macos-icon-check-"))
  try {
    const generated = path.join(temporary, "icon-macos.icns")
    const metrics = await writeMacosIcon(input, generated, root)
    const actual = readFileSync(generated), expected = readFileSync(output)
    // Keep native macOS byte-for-byte reproducible. Cross-host quantization
    // may round one RGB component by one level; alpha and every other pixel
    // remain exact, with one shared budget for the complete archive.
    const equal = process.platform === "darwin" ? actual.equals(expected) : equivalentIcnsRepresentations(actual, expected, { allowSingleRgbRounding: true })
    if (!equal) throw new Error("Default macOS icon is stale; run bun run --bun scripts/gen-macos-icon.ts")
    return metrics
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some((arg) => arg !== "--check")) throw new Error("Usage: bun run --bun scripts/gen-macos-icon.ts [--check]")
  const metrics = await generateDefaultMacosIcon(args.includes("--check"))
  console.log(`${args.includes("--check") ? "Checked" : "Generated"} ${DEFAULT_MACOS_ICON_FILE}: ${JSON.stringify(metrics)}`)
}
