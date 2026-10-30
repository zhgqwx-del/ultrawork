/** Build-only branding. Never imported by renderer or application sidecars. */
import { createHash } from "node:crypto"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Resvg } from "@resvg/resvg-js"
import { validatePng } from "./png-image"
import { writeMacosIcon } from "./macos-icon"
import { JUNK, isGeneratedDir } from "./builtin-skills-exclude"
import { DEFAULT_BRAND, packageSlug, parseBrandIdentity, resolveIdentity, type BrandIdentity } from "../packages/core/brand/src/index"

export const PROJECT_ROOT = path.resolve(import.meta.dir, "..")
export const TAURI_DIR = path.join(PROJECT_ROOT, "packages/client/desktop/src-tauri")
export const BRAND_FLAGS = new Set(["--brand", "--brand-id", "--name", "--icon", "--ui-logo", "--tray-icon"])
export interface BrandArgs { file?: string; brandId?: string; productName?: string; icon?: string; uiLogo?: string; trayIcon?: string }
export interface BrandConfig { schemaVersion: 1; brandId: string; productName: string; icon: string; uiLogo?: string; trayIcon?: string }
export interface ResolvedBrandBuild {
  identity: BrandIdentity
  icon?: string
  uiLogo?: string
  trayIcon?: string
  digest: string
  packageSlug: string
  upgradeCode: string
  assetHashes: Record<string, string>
}
export interface PreparedBrandBuild {
  brand: ResolvedBrandBuild
  stageDir: string
  env: Record<string, string>
  config: Record<string, unknown>
  configArgs: string[]
  targetDir: string
}
const fieldFor: Record<string, keyof BrandArgs> = { "--brand": "file", "--brand-id": "brandId", "--name": "productName", "--icon": "icon", "--ui-logo": "uiLogo", "--tray-icon": "trayIcon" }

export function parseBrandArgs(argv: string[]): { brand: BrandArgs; rest: string[] } {
  const brand: BrandArgs = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!BRAND_FLAGS.has(arg)) { rest.push(arg); continue }
    const key = fieldFor[arg]
    if (brand[key] !== undefined) throw new Error(`Repeated parameter: ${arg}`)
    const value = argv[++i]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
    brand[key] = value
  }
  return { brand, rest }
}

/** Freeze CLI path meanings before an entry point changes the child's cwd. */
export function absoluteBrandArgs(args: BrandArgs, cwd = process.cwd()): BrandArgs {
  const result = { ...args }
  for (const key of ["file", "icon", "uiLogo", "trayIcon"] as const) {
    if (result[key] !== undefined) result[key] = path.resolve(cwd, result[key]!)
  }
  return result
}

export function validateArguments(argv: string[], flags: string[], values: string[] = []): void {
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (![...flags, ...values].includes(flag)) throw new Error(`Unknown parameter: ${flag}`)
    if (seen.has(flag)) throw new Error(`Repeated parameter: ${flag}`)
    seen.add(flag)
    if (values.includes(flag) && (!argv[++i] || argv[i].startsWith("--"))) throw new Error(`Missing value for ${flag}`)
  }
}

function loadConfig(file: string): BrandConfig {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Brand file must be an object")
  const config = value as Record<string, unknown>
  for (const key of Object.keys(config)) if (!["schemaVersion", "brandId", "productName", "icon", "uiLogo", "trayIcon"].includes(key)) throw new Error(`Unknown brand field: ${key}`)
  if (config.schemaVersion !== 1) throw new Error("Brand schemaVersion must be 1")
  resolveIdentity({ schemaVersion: config.schemaVersion, brandId: config.brandId, productName: config.productName })
  for (const key of ["icon", "uiLogo", "trayIcon"]) {
    if ((key === "icon" || config[key] !== undefined) && (typeof config[key] !== "string" || !config[key])) throw new Error(`Invalid brand field: ${key}`)
  }
  return config as unknown as BrandConfig
}

export function imageInfo(file: string): { bytes: Buffer; width: number; height: number } {
  const bytes = readFileSync(file)
  if (bytes.length > 20 * 1024 * 1024) throw new Error(`Brand image exceeds 20 MiB: ${file}`)
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { bytes, ...validatePng(bytes, file) }
  }
  if (path.extname(file).toLowerCase() === ".svg") {
    const svg = new Resvg(bytes, { fitTo: { mode: "width", value: 1024 } })
    return { bytes, width: svg.width, height: svg.height }
  }
  throw new Error(`Expected PNG or SVG image: ${file}`)
}

const DNS_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex")
export function wixUpgradeCode(input: string): string {
  const hash = createHash("sha1").update(DNS_NAMESPACE).update(input).digest().subarray(0, 16)
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const s = hash.toString("hex").toUpperCase()
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

export function resolveBrandBuild(args: BrandArgs, cwd = process.cwd(), rootDir = PROJECT_ROOT): ResolvedBrandBuild {
  const requested = Object.keys(args).length > 0
  let identity = DEFAULT_BRAND
  let icon: string | undefined, uiLogo: string | undefined, trayIcon: string | undefined
  if (requested) {
    const file = args.file ? path.resolve(cwd, args.file) : undefined
    const config = file ? loadConfig(file) : undefined
    if (config && args.brandId !== undefined && args.brandId !== config.brandId) throw new Error("Cannot override a brand file's stable brandId")
    const productName = args.productName ?? config?.productName
    const brandId = args.brandId ?? config?.brandId ?? (productName && /^[\x20-\x7e]+$/.test(productName) ? productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : undefined)
    if (!productName || !brandId || !(args.icon ?? config?.icon)) throw new Error("Custom branding requires --name and --icon; specify --brand-id to keep a stable identity. Product names must be printable ASCII in this release.")
    identity = resolveIdentity({ brandId, productName })
    if (/[$@]/.test(identity.productName)) throw new Error("productName cannot contain $ or @: the macOS DMG layout template interpolates these characters. Choose another application name.")
    const resolveAsset = (key: "icon" | "uiLogo" | "trayIcon") => args[key] !== undefined ? path.resolve(cwd, args[key]!) : config?.[key] ? path.resolve(path.dirname(file!), config[key]!) : undefined
    icon = resolveAsset("icon")
    uiLogo = resolveAsset("uiLogo") ?? icon
    trayIcon = resolveAsset("trayIcon")
  }
  const hash = createHash("sha256").update("brand-build-v1\0").update(readFileSync(import.meta.path)).update(JSON.stringify(identity))
  hash.update(readFileSync(new URL("./macos-icon.ts", import.meta.url)))
  const assetHashes: Record<string, string> = {}
  for (const [key, file] of Object.entries({ icon, uiLogo, trayIcon })) {
    if (!file) continue
    const info = imageInfo(file)
    if (key === "icon" && info.width !== info.height) throw new Error("Application icon must be square")
    if (key === "trayIcon" && path.extname(file).toLowerCase() !== ".png") throw new Error("trayIcon must be a transparent PNG")
    assetHashes[key] = createHash("sha256").update(info.bytes).digest("hex")
    hash.update(key).update(info.bytes)
  }
  if (!identity.isDefault && (!/^[\x20-\x7e]+$/.test(identity.productName) || !/^[a-z0-9][a-z0-9-]+$/.test(packageSlug(identity.productName)))) {
    throw new Error("This release requires an ASCII productName that produces a valid Linux package name. Use an ASCII application name (for example MyWork); brandId remains independent.")
  }
  const result: ResolvedBrandBuild = { identity, icon, uiLogo, trayIcon, digest: hash.digest("hex"), packageSlug: packageSlug(identity.productName), upgradeCode: wixUpgradeCode(`${identity.isDefault ? identity.productName : identity.identifier}.exe.app.x64`), assetHashes }
  // The built-in edition is reserved and never reads custom presets or local history.
  if (!identity.isDefault) validateRegisteredIdentities(result, rootDir)
  return result
}

function fingerprint(identity: BrandIdentity): string {
  return JSON.stringify([identity.identifier, identity.productName, identity.mainBinaryName ?? "ultrawork", packageSlug(identity.productName)])
}
function ledgerPath(rootDir: string): string {
  return path.join(rootDir, ".brand-build", "identity-ledger.json")
}
function readLocalIdentities(rootDir: string): BrandIdentity[] {
  const result: BrandIdentity[] = []
  const ledger = ledgerPath(rootDir)
  if (existsSync(ledger)) {
    const data = JSON.parse(readFileSync(ledger, "utf8")) as { schemaVersion?: number; identities?: unknown[] }
    if (data.schemaVersion !== 1 || !Array.isArray(data.identities)) throw new Error(`Invalid local identity ledger: ${ledger}`)
    result.push(...data.identities.map(parseBrandIdentity))
  }
  // Read earlier successful artifact manifests too: a ledger introduced later
  // must not let a previous temporary edition silently change its upgrade identity.
  const artifacts = path.join(rootDir, ".brand-build", "artifacts")
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && /^manifest(?:-.*)?\.json$/.test(entry.name)) {
        const data = JSON.parse(readFileSync(file, "utf8")) as { identity?: unknown }
        result.push(parseBrandIdentity(data.identity))
      }
    }
  }
  if (existsSync(artifacts)) visit(artifacts)
  return result
}

/** Called only while the public entry point owns its checkout's build lease. */
function registerPreparedIdentity(brand: ResolvedBrandBuild, rootDir: string): void {
  if (brand.identity.isDefault) return
  const ownerFile = path.join(rootDir, ".brand-build", "build-owner.json")
  const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as { pid?: number; token?: string }
  const inherited = process.env.ULTRAWORK_BUILD_LOCK_TOKEN
  if (typeof owner.pid !== "number" || !owner.token || (owner.pid !== process.pid && owner.token !== inherited)) throw new Error("Brand preparation requires the checkout build lease")
  try { process.kill(owner.pid, 0) } catch { throw new Error("Brand preparation requires a live checkout build lease") }
  // Recheck after acquiring the lease, closing the resolve-before-lock race.
  validateRegisteredIdentities(brand, rootDir)
  const identities = new Map(readLocalIdentities(rootDir).map((item) => [item.brandId, item]))
  identities.set(brand.identity.brandId, brand.identity)
  const file = ledgerPath(rootDir)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, identities: [...identities.values()].sort((a, b) => a.brandId.localeCompare(b.brandId)) }, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function validateRegisteredIdentities(brand: ResolvedBrandBuild, rootDir: string): void {
  const all = [DEFAULT_BRAND, ...readLocalIdentities(rootDir)]
  const presets = path.join(rootDir, "branding")
  if (existsSync(presets)) for (const entry of readdirSync(presets, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(presets, entry.name, "brand.json")
    if (existsSync(file)) { const c = loadConfig(file); all.push(resolveIdentity(c)) }
    const lock = path.join(presets, entry.name, "identity.json")
    if (existsSync(lock)) {
      const published = JSON.parse(readFileSync(lock, "utf8")) as { brandId: string; productName: string }
      all.push(resolveIdentity(published))
    }
  }
  const identity = brand.identity
  // Linux installs externalBin beside the main executable in /usr/bin. A new
  // brand's main name must not collide with another brand's prefixed sidecar.
  const linuxBinaries = (item: BrandIdentity) => [item.mainBinaryName ?? "ultrawork", ...["opencode-server", "channel-gateway", "knowledge-sidecar", "acp-client"].map((name) => item.isDefault ? name : `${item.namespace}-${name}`)]
  for (const registered of all) {
    if (registered.brandId === identity.brandId) {
      if (fingerprint(registered) !== fingerprint(identity)) throw new Error(`Published identity is immutable: ${identity.brandId}`)
      continue
    }
    const names = (item: BrandIdentity) => [item.productName, `${item.productName} Dev`].map((name) => name.normalize("NFKC").toLowerCase())
    const slugs = (item: BrandIdentity) => [packageSlug(item.productName), packageSlug(`${item.productName} Dev`)]
    // tauri-plugin-single-instance's macOS socket maps both dots and hyphens to
    // underscores: com.ultrawork.mywork.dev and com.ultrawork.mywork-dev collide.
    const macInstanceKeys = (item: BrandIdentity) => [item.identifier, `${item.identifier}.dev`].map((id) => id.replace(/[.-]/g, "_"))
    if (macInstanceKeys(identity).some((key) => macInstanceKeys(registered).includes(key)) || linuxBinaries(identity).some((name) => linuxBinaries(registered).includes(name)) || names(identity).some((n) => names(registered).includes(n)) || slugs(identity).some((n) => slugs(registered).includes(n))) {
      throw new Error(`Brand installation identity conflicts with ${registered.brandId}`)
    }
  }
}

export function cleanBrandEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !(key === "CARGO_TARGET_DIR" && env.ULTRAWORK_BUILD_TARGET_DIR) && !["ULTRAWORK_BUILD_BRAND_FILE", "ULTRAWORK_BRAND_JSON", "ULTRAWORK_BRAND_UI_LOGO", "ULTRAWORK_BRAND_TRAY_ICON", "ULTRAWORK_BRAND_MACOS_ICON", "ULTRAWORK_BRAND_DIGEST", "ULTRAWORK_BUILTIN_SKILLS_SOURCE", "ULTRAWORK_BUILTIN_SKILLS_OUTPUT", "ULTRAWORK_BUILTIN_SKILLS_VERSION_SEED", "ULTRAWORK_BUILD_CONFIG_FILE", "ULTRAWORK_BUILD_TARGET_DIR"].includes(key))) as Record<string, string>
}

/** Only installed-path instructions are branded; author/source attribution stays intact. */
export function brandSkillMarkdown(relativeFile: string, text: string, identity: BrandIdentity): string {
  if (identity.isDefault) return text
  let result = text.replaceAll("~/.config/ultrawork", `~/.config/${identity.namespace}`)
    .replaceAll("~/.ultrawork", `~/.${identity.namespace}`)
  if (relativeFile.split(path.sep).join("/") === "dingtalk-assistant/SKILL.md") {
    // This router also documents <home>/.ultrawork and a bare .ultrawork path.
    // Scope the substitution to its concrete installed-document prefix.
    result = result.replaceAll(".ultrawork/office-cli/skills/dws", `.${identity.namespace}/office-cli/skills/dws`)
  }
  return result
}

export async function prepareBrandBuild(brand: ResolvedBrandBuild, rootDir = PROJECT_ROOT): Promise<PreparedBrandBuild> {
  const tauriDir = path.join(rootDir, "packages/client/desktop/src-tauri")
  registerPreparedIdentity(brand, rootDir)
  const stageDir = path.join(rootDir, ".brand-build", brand.identity.brandId, "stage", brand.digest)
  mkdirSync(stageDir, { recursive: true })
  const identityFile = path.join(stageDir, "identity.json")
  writeFileSync(identityFile, JSON.stringify(brand.identity, null, 2) + "\n")
  const env = cleanBrandEnvironment()
  env.ULTRAWORK_BUILD_BRAND_FILE = identityFile
  env.ULTRAWORK_BRAND_JSON = JSON.stringify(brand.identity)
  env.ULTRAWORK_BRAND_DIGEST = brand.digest
  const base = JSON.parse(readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"))
  let config: Record<string, unknown> = {}
  const targetDir = brand.identity.isDefault ? (env.CARGO_TARGET_DIR ? path.resolve(process.cwd(), env.CARGO_TARGET_DIR) : path.join(tauriDir, "target")) : path.join(rootDir, ".brand-build", brand.identity.brandId, "target")
  if (env.CARGO_TARGET_DIR) env.CARGO_TARGET_DIR = targetDir
  if (!brand.identity.isDefault) {
    const inputsDir = path.join(stageDir, "inputs")
    mkdirSync(inputsDir, { recursive: true })
    const snapshot = (key: "icon" | "uiLogo" | "trayIcon", file: string): string => {
      const bytes = readFileSync(file)
      if (createHash("sha256").update(bytes).digest("hex") !== brand.assetHashes[key]) throw new Error(`Brand image changed during build preparation: ${file}. Retry the build.`)
      const output = path.join(inputsDir, `${key}${path.extname(file).toLowerCase()}`)
      writeFileSync(output, bytes)
      return output
    }
    const iconInput = snapshot("icon", brand.icon!)
    const uiLogoInput = snapshot("uiLogo", brand.uiLogo!)
    const iconsDir = path.join(stageDir, "icons")
    const child = Bun.spawn([process.execPath, "run", "--bun", "tauri", "icon", iconInput, "--output", iconsDir], { cwd: path.join(rootDir, "packages/client/desktop"), stdout: "inherit", stderr: "inherit", env })
    if (await child.exited !== 0) throw new Error("Tauri icon generation failed")
    const macosIcon = path.join(iconsDir, "icon-macos.icns")
    await writeMacosIcon(iconInput, macosIcon, rootDir, env)
    env.ULTRAWORK_BRAND_MACOS_ICON = macosIcon
    env.CARGO_TARGET_DIR = targetDir
    env.ULTRAWORK_BRAND_UI_LOGO = uiLogoInput
    if (brand.trayIcon) {
      if (path.extname(brand.trayIcon).toLowerCase() !== ".png") throw new Error("trayIcon must be a transparent PNG")
      env.ULTRAWORK_BRAND_TRAY_ICON = snapshot("trayIcon", brand.trayIcon)
    } else {
      // An opaque app icon has an opaque alpha silhouette. Use a monochrome
      // asset with the product initial rather than a solid template square.
      const glyph = brand.identity.productName[0].replace(/[<>&"']/g, "") || "M"
      const tray = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><text x="22" y="35" text-anchor="middle" font-family="Arial,sans-serif" font-size="38" font-weight="bold">${glyph}</text></svg>`).render().asPng()
      const file = path.join(stageDir, "tray-template.png")
      writeFileSync(file, tray)
      env.ULTRAWORK_BRAND_TRAY_ICON = file
    }
    const skillSeed = createHash("sha256").update("brand-skills-v2").update(readFileSync(import.meta.path)).update(brand.identity.namespace).digest("hex")
    const skillHash = createHash("sha256").update(skillSeed)
    const hashSkills = (dir: string, rel = "") => { for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === ".builtin-version" || JUNK.has(item.name)) continue
      const name = rel ? `${rel}/${item.name}` : item.name
      const file = path.join(dir, item.name)
      if (item.isSymbolicLink()) throw new Error(`Unexpected skill symlink: ${file}`)
      if (item.isDirectory()) { if (!isGeneratedDir(name)) hashSkills(file, name) }
      else skillHash.update(name).update("\0").update(readFileSync(file)).update("\0")
    } }
    hashSkills(path.join(rootDir, "skills/builtin"))
    const sourceHash = skillHash.digest("hex")
    const skillStage = path.join(rootDir, ".brand-build", brand.identity.brandId, "skills", sourceHash)
    const skillsSource = path.join(skillStage, "source")
    // A directory alone may be left by an interrupted copy or Markdown pass.
    // Keep completion outside source so it cannot become part of the skill ZIP.
    const readyFile = path.join(skillStage, ".source-ready.json")
    const readyText = JSON.stringify({ schemaVersion: 1, sourceHash }) + "\n"
    const ready = (() => {
      try {
        return lstatSync(skillsSource).isDirectory() && lstatSync(readyFile).isFile() &&
          readFileSync(readyFile, "utf8") === readyText
      } catch { return false }
    })()
    if (!ready) {
      mkdirSync(skillStage, { recursive: true })
      // The checkout lease excludes other builders. Remove an unfinished tree
      // before rename, which also works on Windows where the target must be absent.
      rmSync(readyFile, { recursive: true, force: true })
      rmSync(skillsSource, { recursive: true, force: true })
      const temporary = mkdtempSync(path.join(skillStage, ".source-staging-"))
      try {
        const stagingSource = path.join(temporary, "source")
        cpSync(path.join(rootDir, "skills/builtin"), stagingSource, { recursive: true })
        const visit = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, item.name)
          if (item.isDirectory()) visit(file)
          else if (item.isFile() && /\.md$/.test(item.name)) writeFileSync(file, brandSkillMarkdown(path.relative(stagingSource, file), readFileSync(file, "utf8"), brand.identity))
        } }
        visit(stagingSource)
        renameSync(stagingSource, skillsSource)
        const stagingReady = path.join(temporary, "ready.json")
        writeFileSync(stagingReady, readyText)
        renameSync(stagingReady, readyFile)
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    const skillsOutput = path.join(skillStage, "bundle")
    mkdirSync(skillsOutput, { recursive: true })
    env.ULTRAWORK_BUILTIN_SKILLS_SOURCE = skillsSource
    env.ULTRAWORK_BUILTIN_SKILLS_OUTPUT = skillsOutput
    env.ULTRAWORK_BUILTIN_SKILLS_VERSION_SEED = skillSeed
    config = {
      productName: brand.identity.productName,
      identifier: brand.identity.identifier,
      mainBinaryName: brand.identity.mainBinaryName,
      app: { windows: base.app.windows.map((window: Record<string, unknown>) => ({ ...window, title: brand.identity.productName })) },
      bundle: {
        icon: ["32x32.png", "128x128.png", "128x128@2x.png", "icon-macos.icns", "icon.ico"].map((name) => path.join(iconsDir, name)),
        windows: { wix: { upgradeCode: brand.upgradeCode } },
        resources: { ...Object.fromEntries(Object.keys(base.bundle.resources).map((key) => [key, null])), [skillsOutput]: "skills/builtin" },
      },
    }
  }
  const configFile = path.join(stageDir, "tauri-brand.json")
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n")
  env.ULTRAWORK_BUILD_CONFIG_FILE = configFile
  env.ULTRAWORK_BUILD_TARGET_DIR = targetDir
  return { brand, stageDir, env, config, configArgs: brand.identity.isDefault ? [] : ["--config", configFile], targetDir }
}

export function currentTarget(): string {
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (process.platform === "win32") return "x86_64-pc-windows-msvc"
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
}
