#!/usr/bin/env bun
import path from "node:path"
import { acquireBuildLock } from "./build-lock"
import { currentTarget, parseBrandArgs, prepareBrandBuild, PROJECT_ROOT, resolveBrandBuild, validateArguments } from "./brand-build"
import { verifyFreshSidecarsForTarget } from "./sidecar-freshness"
import { exportBrandArtifacts } from "./brand-artifacts"
import { materializeBrandSidecars } from "./brand-sidecars"
import { inspectLinuxInstallers } from "./linux-install-layout"

const startedAt = Date.now()
const mode = process.argv[2]
if (mode !== "dev" && mode !== "build") throw new Error("Expected tauri-brand.ts dev|build")
const parsed = parseBrandArgs(process.argv.slice(3))
validateArguments(parsed.rest, ["--debug", "--verbose", "--ci", "--no-bundle", "--no-watch", "--exit-on-panic"], ["--target", "--bundles", "--features"])
const brand = resolveBrandBuild(parsed.brand)
const lease = acquireBuildLock(PROJECT_ROOT)
process.on("exit", () => lease.release())
try {
  const at = parsed.rest.indexOf("--target")
  const target = at >= 0 ? parsed.rest[at + 1] : currentTarget()
  await verifyFreshSidecarsForTarget(target, PROJECT_ROOT)
  const prepared = await prepareBrandBuild(brand)
  prepared.env.ULTRAWORK_BUILD_LOCK_TOKEN = lease.token
  materializeBrandSidecars(prepared, target)
  console.log(`[brand] ${brand.identity.productName} (${brand.identity.brandId}), ${brand.identity.identifier}, ${brand.digest.slice(0, 12)}`)
  const child = Bun.spawn([process.execPath, "run", "--bun", "tauri", mode, ...parsed.rest, ...prepared.configArgs], {
    cwd: path.join(PROJECT_ROOT, "packages/client/desktop"), env: prepared.env, stdout: "inherit", stderr: "inherit", stdin: "inherit",
  })
  const forward = () => child.kill()
  process.on("SIGINT", forward)
  process.on("SIGTERM", forward)
  const result = await child.exited
  process.removeListener("SIGINT", forward)
  process.removeListener("SIGTERM", forward)
  const bundlesAt = parsed.rest.indexOf("--bundles")
  const appOnly = bundlesAt >= 0 && parsed.rest[bundlesAt + 1] === "app"
  // A deliberate app-only build has no installer to export; keep the valid
  // Tauri CLI workflow useful for native smoke tests. release still requires installers.
  if (result === 0 && mode === "build" && !parsed.rest.includes("--no-bundle") && !appOnly) {
    const at = parsed.rest.indexOf("--target")
    const target = at >= 0 ? parsed.rest[at + 1] : undefined
    const bundleDir = path.join(prepared.targetDir, ...(target ? [target] : []), parsed.rest.includes("--debug") ? "debug" : "release", "bundle")
    const effectiveTarget = target ?? currentTarget()
    const linuxLayouts = await inspectLinuxInstallers(brand.identity, effectiveTarget, bundleDir, startedAt)
    exportBrandArtifacts(prepared, bundleDir, startedAt, PROJECT_ROOT, { mode: parsed.rest.includes("--debug") ? "debug" : "release", productName: brand.identity.productName, identifier: brand.identity.identifier, signing: "not-configured", target: effectiveTarget, ...(linuxLayouts.length ? { linuxLayouts } : {}) })
  }
  process.exitCode = result
} finally {
  lease.release()
}
