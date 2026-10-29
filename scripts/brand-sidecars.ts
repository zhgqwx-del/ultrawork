/** Packaging adapters: Linux installs external binaries into the shared /usr/bin. */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BrandIdentity } from "../packages/core/brand/src/index"
import { PROJECT_ROOT, type PreparedBrandBuild } from "./brand-build"
import { SIDECAR_NAMES, verifySidecarMetadata } from "./sidecar-metadata"

export { SIDECAR_NAMES } from "./sidecar-metadata"

export function packagedSidecarName(identity: BrandIdentity, name: string, target: string): string {
  return target.includes("linux") && !identity.isDefault ? `${identity.namespace}-${name}` : name
}

/** Run after compilation and before Tauri, while the public entry owns the build lease. */
export function materializeBrandSidecars(prepared: PreparedBrandBuild, target: string, root = PROJECT_ROOT): void {
  if (!target.includes("linux") || prepared.brand.identity.isDefault) return
  const owner = JSON.parse(readFileSync(path.join(root, ".brand-build", "build-owner.json"), "utf8")) as { pid: number; token: string }
  if (owner.pid !== process.pid && owner.token !== process.env.ULTRAWORK_BUILD_LOCK_TOKEN) throw new Error("Sidecar staging requires the checkout build lease")
  process.kill(owner.pid, 0)
  const staged = path.join(prepared.stageDir, "sidecars", target)
  mkdirSync(staged, { recursive: true })
  const externalBin = SIDECAR_NAMES.map((name) => {
    const source = path.join(root, "packages/client/desktop/src-tauri/binaries", `${name}-${target}`)
    verifySidecarMetadata(source, target)
    const base = path.join(staged, packagedSidecarName(prepared.brand.identity, name, target))
    const destination = `${base}-${target}`
    copyFileSync(source, destination)
    copyFileSync(`${source}.metadata.json`, `${destination}.metadata.json`)
    // Detect a source replacement during copying as well as a damaged stage file.
    verifySidecarMetadata(destination, target)
    if (process.platform !== "win32") chmodSync(destination, 0o755)
    return base
  })
  prepared.config.bundle = { ...(prepared.config.bundle as Record<string, unknown>), externalBin }
  writeFileSync(prepared.env.ULTRAWORK_BUILD_CONFIG_FILE, JSON.stringify(prepared.config, null, 2) + "\n")
}
