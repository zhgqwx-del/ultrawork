import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { PreparedBrandBuild } from "./brand-build"
import type { LinuxInstallerLayout } from "./linux-install-layout"

export interface ArtifactBuildDetails {
  mode: "release" | "debug" | "unsigned-dev"
  productName: string
  identifier: string
  signing: "ad-hoc" | "developer-id" | "not-configured"
  target?: string
  linuxLayouts?: LinuxInstallerLayout[]
}

export function brandArtifactDirectory(root: string, brandId: string, platform = `${process.platform}-${process.arch}`): string {
  return path.join(root, ".brand-build", "artifacts", brandId, platform)
}

/** Export only files actually emitted by this successful build, never a broad glob. */
export function exportBrandArtifacts(prepared: PreparedBrandBuild, bundleDir: string, startedAt: number, root: string, details?: ArtifactBuildDetails): void {
  const files: string[] = []
  const { productName } = prepared.brand.identity
  const productPrefixes = [productName, `${productName} Dev`, prepared.brand.packageSlug, `${prepared.brand.packageSlug}-dev`]
  const belongsToBrand = (file: string) => {
    const relative = path.relative(bundleDir, file)
    const top = relative.split(path.sep)[0]
    const name = path.basename(file)
    if (!productPrefixes.some((prefix) => name.startsWith(`${prefix}_`) || name.startsWith(`${prefix}-`) || name === `${prefix}.zip`)) return false
    return ["dmg", "msi", "nsis", "deb", "rpm"].includes(top) || (relative === name && name.endsWith(".zip"))
  }
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.endsWith(".app")) walk(file)
      else if (entry.isFile() && /\.(dmg|msi|exe|deb|rpm|zip)$/.test(entry.name) && statSync(file).mtimeMs >= startedAt - 2000 && belongsToBrand(file)) files.push(file)
    }
  }
  walk(bundleDir)
  if (!files.length) throw new Error(`No new installer artifacts under ${bundleDir}`)
  const platform = `${process.platform}-${process.arch}`
  const output = brandArtifactDirectory(root, prepared.brand.identity.brandId, platform)
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  const artifacts = files.sort().map((file) => {
    const name = path.basename(file)
    const bytes = readFileSync(file)
    copyFileSync(file, path.join(output, name))
    return { file: name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }
  })
  writeFileSync(path.join(output, `manifest-${platform}.json`), JSON.stringify({
    schemaVersion: 1,
    identity: prepared.brand.identity,
    build: details ?? { mode: "release", productName, identifier: prepared.brand.identity.identifier, signing: "not-configured" },
    brandDigest: prepared.brand.digest, platform, artifacts,
  }, null, 2) + "\n")
  console.log(`[brand] Artifact manifest and installers: ${output}`)
}
