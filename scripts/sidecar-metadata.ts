import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const BRAND_CONTEXT_PROTOCOL = 1
export const SIDECAR_NAMES = ["opencode-server", "channel-gateway", "knowledge-sidecar", "acp-client"] as const

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
export function verifySidecarMetadata(binary: string, target: string): void {
  let meta: { schemaVersion: number; brandContextProtocol: number; target: string; binarySha256: string; sourceHash: string }
  try { meta = JSON.parse(readFileSync(`${binary}.metadata.json`, "utf8")) } catch { throw new Error(`Missing sidecar metadata: ${binary}. Rebuild sidecars; --skip-sidecar does not bypass validation.`) }
  if (meta.schemaVersion !== 1 || meta.brandContextProtocol !== BRAND_CONTEXT_PROTOCOL || meta.target !== target || !meta.sourceHash ||
      meta.binarySha256 !== createHash("sha256").update(readFileSync(binary)).digest("hex")) throw new Error(`Incompatible or changed sidecar: ${binary}. Rebuild it before packaging this brand.`)
}
