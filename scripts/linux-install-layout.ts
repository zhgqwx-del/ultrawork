/** Inspect actual Linux installer payloads; never install them or invoke their programs. */
import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import type { BrandIdentity } from "../packages/core/brand/src/index"
import { packagedSidecarName, SIDECAR_NAMES } from "./brand-sidecars"

export interface LinuxInstallerLayout { file: string; installedFiles: string[] }

function installedPath(file: string): string | undefined {
  const relative = file.replace(/^(?:\.\/|\/)+/, "")
  if (!relative || relative === ".") return undefined
  if (relative.includes("\0") || relative.split("/").some((part) => part === ".." || part === ".")) throw new Error(`Invalid installer entry: ${JSON.stringify(file)}`)
  return "/" + relative
}

/** tar -t emits names only; no owner/date/size columns or symlink targets. */
export function parseDebianFileList(listing: string): string[] {
  return listing.split(/\r?\n/).flatMap((line) => {
    if (!line) return []
    const file = installedPath(line)
    return file && !line.endsWith("/") ? [file] : []
  })
}

/** RPM's queryformat emits a permission mode and the complete pathname. */
export function parseRpmFileList(listing: string): string[] {
  return listing.split(/\r?\n/).flatMap((line) => {
    if (!line) return []
    const match = /^([bcdhlps-][rwxstST-]{9}) (\/.+)$/.exec(line)
    if (!match) throw new Error(`Invalid RPM file-list row: ${JSON.stringify(line.slice(0, 240))}`)
    const file = installedPath(match[2]!)
    return file && !match[1]!.startsWith("d") ? [file] : []
  })
}

interface CapturedOutput { text: string; truncated: boolean }
async function capture(stream: ReadableStream<Uint8Array>, limit: number): Promise<CapturedOutput> {
  const chunks: Uint8Array[] = []
  let kept = 0, total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (kept < limit) {
      const part = chunk.subarray(0, limit - kept)
      chunks.push(part); kept += part.length
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: total > limit }
}

function boundedListing(listing: string, limit = 6000): string {
  if (!listing) return "(empty)"
  if (listing.length <= limit) return listing
  const half = Math.floor(limit / 2)
  return `${listing.slice(0, half)}\n... ${listing.length - limit} characters omitted ...\n${listing.slice(-half)}`
}

/** Stream the potentially large Debian data archive directly into tar. Only
 * the bounded pathname list and diagnostics are ever collected in memory. */
async function readPackageFileList(file: string): Promise<string> {
  const deb = file.endsWith(".deb")
  const children: Pick<Bun.Subprocess, "exitCode" | "kill" | "exited">[] = []
  const readers: Promise<CapturedOutput>[] = []
  const env = { ...process.env, LC_ALL: "C", TAR_OPTIONS: "" }
  const stopChildren = () => {
    for (const child of children) if (child.exitCode === null) {
      try { child.kill("SIGKILL") } catch { /* already exited; still reap below */ }
    }
  }
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    stopChildren()
  }, 120_000)
  try {
    let stdout: ReadableStream<Uint8Array>
    if (deb) {
      const archive = Bun.spawn(["dpkg-deb", "--fsys-tarfile", file], { env, stdout: "pipe", stderr: "pipe" })
      children.push(archive)
      readers.push(capture(archive.stderr, 16 * 1024))
      const list = Bun.spawn(["tar", "--list", "--file", "-", "--quoting-style=literal"], { env, stdin: archive.stdout, stdout: "pipe", stderr: "pipe" })
      children.push(list)
      readers.push(capture(list.stderr, 16 * 1024))
      stdout = list.stdout
    } else {
      const list = Bun.spawn(["rpm", "-qp", "--queryformat", "[%{FILEMODES:perms} %{FILENAMES}\\n]", file], { env, stdout: "pipe", stderr: "pipe" })
      children.push(list)
      readers.push(capture(list.stderr, 16 * 1024))
      stdout = list.stdout
    }
    const output = capture(stdout, 16 * 1024 * 1024)
    readers.push(output)
    const [codes, captured] = await Promise.all([Promise.all(children.map((child) => child.exited)), Promise.all(readers)])
    const listing = captured.at(-1)!
    const diagnostics = captured.slice(0, -1).map((item) => item.text + (item.truncated ? "\n(stderr truncated)" : "")).filter(Boolean).join("\n")
    if (timedOut || codes.some((code) => code !== 0) || listing.truncated) {
      throw new Error(`${deb ? "dpkg-deb → tar" : "rpm"} exit codes: ${codes.join(", ")}${timedOut ? "; timed out" : ""}${listing.truncated ? "; file list exceeds 16 MiB" : ""}\n${diagnostics}\nListing:\n${boundedListing(listing.text)}`)
    }
    return listing.text
  } catch (error) {
    throw new Error(`Cannot inspect Linux installer ${file}; dpkg-deb, GNU tar and rpm must be available. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    clearTimeout(timeout)
    // These are only the subprocesses started by this inspection. Reap both
    // sides even if spawning/reading one side failed, so no pipe stays open.
    stopChildren()
    await Promise.allSettled([...children.map((child) => child.exited), ...readers])
  }
}

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

export async function inspectLinuxInstallers(identity: BrandIdentity, target: string, bundleDir: string, startedAt: number): Promise<LinuxInstallerLayout[]> {
  if (!target.includes("linux")) return []
  if (process.platform !== "linux") throw new Error("Inspect Linux packages on a Linux runner with dpkg-deb, GNU tar and rpm installed")
  const packages: string[] = []
  const visit = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) visit(file)
    else if (/\.(deb|rpm)$/.test(file) && statSync(file).mtimeMs >= startedAt - 2000) packages.push(file)
  } }
  visit(bundleDir)
  if (!packages.length) throw new Error("No newly built Linux installers to inspect")
  const layouts: LinuxInstallerLayout[] = []
  for (const file of packages.sort()) {
    const listing = await readPackageFileList(file)
    let installedFiles: string[]
    try {
      installedFiles = file.endsWith(".deb") ? parseDebianFileList(listing) : parseRpmFileList(listing)
      assertLinuxInstallLayout(identity, target, installedFiles)
    } catch (error) {
      throw new Error(`Linux installer layout failed for ${file}: ${error instanceof Error ? error.message : String(error)}\nListing:\n${boundedListing(listing)}`, { cause: error })
    }
    layouts.push({ file: path.basename(file), installedFiles })
  }
  console.log(`[brand] Actual Linux installer file layouts verified: ${layouts.map((layout) => layout.file).join(", ")}`)
  return layouts
}
