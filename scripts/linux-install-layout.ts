/** Inspect actual Linux installer payloads; never install them or invoke their programs. */
import { spawnSync } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import type { BrandIdentity } from "../packages/core/brand/src/index"
import { packagedSidecarName, SIDECAR_NAMES } from "./brand-sidecars"

export interface LinuxInstallerLayout { file: string; installedFiles: string[] }

export function assertLinuxInstallLayout(identity: BrandIdentity, target: string, files: string[]): void {
  const paths = new Set(files.map((file) => "/" + file.replace(/^\.?\/+/, "")))
  const main = identity.mainBinaryName ?? "ultrawork"
  for (const name of [main, ...SIDECAR_NAMES.map((name) => packagedSidecarName(identity, name, target))]) {
    if (!paths.has(`/usr/bin/${name}`)) throw new Error(`Linux installer is missing /usr/bin/${name}`)
  }
  if (!identity.isDefault) {
    for (const name of ["ultrawork", ...SIDECAR_NAMES]) {
      if (paths.has(`/usr/bin/${name}`)) throw new Error(`Linux installer would overwrite another brand: /usr/bin/${name}`)
    }
    if ([...paths].some((file) => file.startsWith("/usr/lib/Ultrawork/"))) throw new Error("Linux installer contains default-brand resources")
  }
  const skills = `/usr/lib/${identity.productName}/skills/builtin/skills-builtin.zip`
  if (!paths.has(skills)) throw new Error(`Linux installer is missing its own resources: ${skills}`)
}

export function inspectLinuxInstallers(identity: BrandIdentity, target: string, bundleDir: string, startedAt: number): LinuxInstallerLayout[] {
  if (!target.includes("linux")) return []
  if (process.platform !== "linux") throw new Error("Inspect Linux packages on a Linux runner with dpkg-deb and rpm installed")
  const packages: string[] = []
  const visit = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) visit(file)
    else if (/\.(deb|rpm)$/.test(file) && statSync(file).mtimeMs >= startedAt - 2000) packages.push(file)
  } }
  visit(bundleDir)
  if (!packages.length) throw new Error("No newly built Linux installers to inspect")
  const layouts = packages.sort().map((file) => {
    const deb = file.endsWith(".deb")
    const result = spawnSync(deb ? "dpkg-deb" : "rpm", deb ? ["--contents", file] : ["-qp", "--queryformat", "[%{FILEMODES:perms} %{FILENAMES}\\n]", file], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error(`Cannot inspect ${file}; install dpkg-deb and rpm: ${result.error?.message ?? result.stderr}`)
    const installedFiles = result.stdout.split(/\r?\n/).flatMap((line) => {
      if (!line || line.startsWith("d")) return []
      const start = deb ? line.indexOf(" ./") : line.indexOf(" /")
      return start < 0 ? [] : ["/" + line.slice(start + 1).replace(/^\.?\/+/, "")]
    })
    assertLinuxInstallLayout(identity, target, installedFiles)
    return { file: path.basename(file), installedFiles }
  })
  console.log(`[brand] Actual Linux installer file layouts verified: ${layouts.map((layout) => layout.file).join(", ")}`)
  return layouts
}
