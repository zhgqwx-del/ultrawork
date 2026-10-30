import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const BRAND_CONTEXT_PROTOCOL = 1
export const SIDECAR_NAMES = ["opencode-server", "channel-gateway", "knowledge-sidecar", "acp-client"] as const
export interface SidecarMetadata {
  schemaVersion: 1
  brandContextProtocol: number
  target: string
  sourceHash: string
  binarySha256: string
}

/** Both default and custom editions use the host's current context protocol. */
export function verifySidecarsForTarget(target: string, root: string): void {
  for (const name of SIDECAR_NAMES) {
    verifySidecarMetadata(path.join(root, "packages/client/desktop/src-tauri/binaries", `${name}-${target}${target.includes("windows") ? ".exe" : ""}`), target)
  }
}
export function writeSidecarMetadata(binary: string, target: string, sourceHash: string): void {
  writeFileSync(`${binary}.metadata.json`, JSON.stringify({
    schemaVersion: 1, brandContextProtocol: BRAND_CONTEXT_PROTOCOL, target, sourceHash,
    binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  }, null, 2) + "\n")
}
export function verifySidecarMetadata(binary: string, target: string, expectedSourceHash?: string): SidecarMetadata {
  let meta: SidecarMetadata
  try { meta = JSON.parse(readFileSync(`${binary}.metadata.json`, "utf8")) } catch { throw new Error(`Missing sidecar metadata: ${binary}. Rebuild sidecars; --skip-sidecar does not bypass validation.`) }
  let sha: string
  try { sha = createHash("sha256").update(readFileSync(binary)).digest("hex") } catch { throw new Error(`Missing sidecar binary: ${binary}. Rebuild sidecars before packaging.`) }
  if (!meta || meta.schemaVersion !== 1 || meta.brandContextProtocol !== BRAND_CONTEXT_PROTOCOL || meta.target !== target ||
      typeof meta.sourceHash !== "string" || !meta.sourceHash || meta.binarySha256 !== sha) {
    throw new Error(`Incompatible or changed sidecar: ${binary}. Rebuild it before packaging this brand.`)
  }
  if (expectedSourceHash !== undefined && meta.sourceHash !== expectedSourceHash) {
    throw new Error(`Stale sidecar source: ${binary}; expected ${expectedSourceHash}. Rebuild sidecars before packaging; --skip-sidecar does not bypass freshness.`)
  }
  return meta
}

/** The builder supplies its own current hash; packaging never duplicates its rules. */
export function verifySidecarFreshness(binary: string, target: string, currentHash: string, hashFile: string): void {
  verifySidecarMetadata(binary, target, currentHash)
  let saved: string
  try { saved = readFileSync(hashFile, "utf8").trim() } catch { throw new Error(`Missing sidecar build hash: ${hashFile}. Rebuild sidecars before packaging.`) }
  if (saved !== currentHash) throw new Error(`Stale sidecar build hash: ${hashFile}. Rebuild sidecars before packaging.`)
}
