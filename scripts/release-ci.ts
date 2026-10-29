#!/usr/bin/env bun
/** Shared CI release planning and artifact checks. No toolchain dependencies. */
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { DEFAULT_BRAND, packageSlug, parseBrandIdentity, resolveIdentity } from "../packages/core/brand/src/index"

export type ReleaseBrand = "default" | "mywork"
const platforms = [
  { os: "macos-latest", name: "macos" },
  { os: "windows-latest", name: "windows-x64" },
  { os: "ubuntu-22.04", name: "linux-x64" },
] as const

export function releaseMatrix(eventName: string, selected = "all") {
  if (!["all", "default", "mywork"].includes(selected)) throw new Error("CI accepts only all, default or mywork presets")
  const brands: ReleaseBrand[] = eventName === "workflow_dispatch" && selected !== "all" ? [selected as ReleaseBrand] : ["default", "mywork"]
  return { include: brands.flatMap((brand) => platforms.map((platform) => ({ ...platform, brand }))) }
}

export function releaseBuildArguments(brand: string, extra: string[], ref: string, root: string, eventName = "push"): string[] {
  if (!["default", "mywork"].includes(brand)) throw new Error("CI accepts only default or mywork presets")
  if (extra.some((arg) => ["--brand", "--brand-id", "--name", "--icon", "--ui-logo", "--tray-icon"].includes(arg))) throw new Error("CI branding is controlled only by ULTRAWORK_RELEASE_BRAND")
  if (eventName === "push" && ref.startsWith("refs/tags/v") && extra.some((arg) => ["--unsigned", "--skip-notarize", "--native", "--allow-bad-dmg-layout"].includes(arg))) {
    throw new Error("Version-tag releases require the full signed/notarized release path; verification-only bypass flags are not allowed")
  }
  return [...(brand === "mywork" ? ["--brand", path.join(root, "branding/mywork/brand.json")] : []), ...extra]
}

/** Validate both editions before publishing, including flat GitHub asset names. */
export function verifyReleaseArtifacts(directory: string): string[] {
  const root = path.resolve(directory)
  const files: string[] = []
  const visit = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name)
      if (item.isSymbolicLink()) throw new Error(`Release artifacts cannot be symbolic links: ${file}`)
      if (item.isDirectory()) visit(file)
      else if (item.isFile()) files.push(file)
    }
  }
  visit(root)
  const manifests = files.filter((file) => /^manifest-(?:darwin|win32|linux)-(?:arm64|x64)\.json$/.test(path.basename(file)))
  if (manifests.length !== 6) throw new Error(`Expected six edition/platform manifests, received ${manifests.length}`)
  const identities = [DEFAULT_BRAND, resolveIdentity({ brandId: "mywork", productName: "MyWork" })]
  const seenPlatforms = new Set<string>(), assets = new Set<string>(), assetNames = new Set<string>()
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    if (manifest.schemaVersion !== 1) throw new Error(`Unsupported release manifest: ${file}`)
    const identity = parseBrandIdentity(manifest.identity)
    const expected = identities.find((item) => item.brandId === identity.brandId)
    if (!expected || identity.productName !== expected.productName || identity.identifier !== expected.identifier) throw new Error(`Unexpected release identity: ${file}`)
    const platform = /^(darwin|win32|linux)-(arm64|x64)$/.exec(manifest.platform ?? "")?.[1]
    if (!platform || path.basename(file) !== `manifest-${manifest.platform}.json`) throw new Error(`Invalid release platform: ${file}`)
    const folders = path.relative(root, file).split(path.sep)
    if (folders.length !== 3 || folders[0] !== identity.brandId || folders[1] !== manifest.platform) throw new Error(`Edition/platform directories were not preserved: ${file}`)
    const key = `${identity.brandId}:${platform}`
    if (seenPlatforms.has(key)) throw new Error(`Duplicate release platform: ${key}`)
    seenPlatforms.add(key)
    if (manifest.build?.mode !== "release" || manifest.build.productName !== identity.productName || manifest.build.identifier !== identity.identifier) throw new Error(`Development or mismatched installer cannot be released: ${file}`)
    if (platform === "darwin" && (manifest.build.signing !== "developer-id" || manifest.build.target !== "universal-apple-darwin")) throw new Error(`macOS release must be Developer ID signed and Universal: ${file}`)
    if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error(`Release manifest has no installers: ${file}`)
    const names: string[] = []
    for (const item of manifest.artifacts) {
      if (typeof item.file !== "string" || !item.file || /[\\/\r\n]/.test(item.file) || !/\.(?:dmg|msi|exe|deb|rpm|AppImage)$/.test(item.file)) throw new Error(`Invalid release asset name: ${file}`)
      const prefixes = [identity.productName, packageSlug(identity.productName)]
      if (!prefixes.some((prefix) => item.file.startsWith(`${prefix}_`) || item.file.startsWith(`${prefix}-`))) throw new Error(`Asset does not belong to ${identity.brandId}: ${item.file}`)
      if (assetNames.has(item.file)) throw new Error(`GitHub release asset filename collision: ${item.file}`)
      const asset = path.join(path.dirname(file), item.file)
      const bytes = readFileSync(asset)
      if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new Error(`Release artifact hash/size mismatch: ${asset}`)
      assetNames.add(item.file); assets.add(asset); names.push(item.file)
    }
    const required = platform === "darwin" ? [/\.dmg$/] : platform === "win32" ? [/\.msi$/, /(?<!-offline)-setup\.exe$/, /-offline-setup\.exe$/] : [/\.deb$/, /\.rpm$/]
    for (const pattern of required) if (!names.some((name) => pattern.test(name))) throw new Error(`Missing ${platform} installer ${pattern}: ${file}`)
  }
  for (const identity of identities) for (const platform of ["darwin", "win32", "linux"]) {
    if (!seenPlatforms.has(`${identity.brandId}:${platform}`)) throw new Error(`Missing release platform: ${identity.brandId}/${platform}`)
  }
  for (const file of files) if (!manifests.includes(file) && !assets.has(file)) throw new Error(`Unlisted file in release artifacts: ${file}`)
  return [...assets].sort()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--matrix") {
    console.log(JSON.stringify(releaseMatrix(process.env.GITHUB_EVENT_NAME ?? "push", process.env.ULTRAWORK_RELEASE_BRAND_INPUT ?? "all")))
  } else if (args.length === 2 && args[0] === "--verify-artifacts") {
    console.log(verifyReleaseArtifacts(args[1]!).join("\n"))
  } else {
    const root = path.resolve(import.meta.dir, "..")
    const buildArgs = releaseBuildArguments(process.env.ULTRAWORK_RELEASE_BRAND ?? "default", args, process.env.GITHUB_REF ?? "", root, process.env.GITHUB_EVENT_NAME ?? "push")
    const child = Bun.spawn([process.execPath, "run", "--bun", path.join(root, "scripts/build-release.ts"), ...buildArgs], { cwd: root, env: process.env, stdout: "inherit", stderr: "inherit", stdin: "inherit" })
    process.exitCode = await child.exited
  }
}
