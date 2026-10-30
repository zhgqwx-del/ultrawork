/** Read-only packaging gate using the builders' existing source hash rules. */
import { createHash } from "node:crypto"
import path from "node:path"
import { SIDECAR_NAMES, verifySidecarMetadata, verifySidecarsForTarget } from "./sidecar-metadata"

const BUILDERS = ["build-opencode.ts", "build-gateway.ts", "build-knowledge.ts", "build-acp.ts"] as const
const MAC_TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"] as const
const UNIVERSAL = "universal-apple-darwin"
type RunCheck = (script: string, target: string, root: string) => Promise<void>

function binary(root: string, name: string, target: string): string {
  return path.join(root, "packages/client/desktop/src-tauri/binaries", `${name}-${target}${target.includes("windows") ? ".exe" : ""}`)
}

async function runCheck(script: string, target: string, root: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "--bun", path.join(root, "scripts", script), "--target", target, "--check"], {
    cwd: root, env: process.env, stdout: "inherit", stderr: "inherit",
  })
  if (await child.exited !== 0) throw new Error(`Sidecar freshness check failed: ${script} (${target}). Rebuild sidecars before packaging.`)
}

/** Brand-independent provenance for a fat binary built from these exact slices. */
export function universalSidecarSourceHash(name: typeof SIDECAR_NAMES[number], root: string): string {
  const inputs = MAC_TARGETS.map((target) => {
    const meta = verifySidecarMetadata(binary(root, name, target), target)
    return { target, sourceHash: meta.sourceHash, binarySha256: meta.binarySha256 }
  })
  return createHash("sha256").update(JSON.stringify({ schemaVersion: 1, target: UNIVERSAL, inputs })).digest("hex")
}

export async function verifyFreshSidecarsForTarget(target: string, root: string, run: RunCheck = runCheck): Promise<void> {
  const targets = target === UNIVERSAL ? MAC_TARGETS : [target]
  // Preserve clear missing/protocol errors before launching any checks.
  for (const arch of targets) verifySidecarsForTarget(arch, root)
  for (const arch of targets) for (const script of BUILDERS) await run(script, arch, root)
  if (target === UNIVERSAL) {
    for (const name of SIDECAR_NAMES) {
      verifySidecarMetadata(binary(root, name, target), target, universalSidecarSourceHash(name, root))
    }
  }
}
