#!/usr/bin/env bun
// Build-time generator: third-party open-source NOTICES + license manifest.
//
// Produces the data the About → 第三方开源软件 view renders, plus a plain-text
// NOTICES.txt compliance artifact. Aggregates four sources (see discussions/047):
//
//   1. npm 依赖树       — root bun store (node_modules/.bun), full LICENSE text
//   2. opencode 内嵌树   — vendor/opencode/bun.lock (compiled into the sidecar
//                          binary we redistribute; the biggest attribution gap)
//   3. Rust crates      — `cargo metadata` (SPDX + repo link; permissive tree)
//   4. 捆绑/vendored     — opencode itself (MODIFIED via patch), vendored pptxgenjs
//
// Outputs (committed, consumed by the renderer via dynamic import so nothing lands
// in the startup bundle):
//   packages/client/desktop/src/generated/licenses.json       — metadata only (small)
//   packages/client/desktop/src/generated/license-texts.json  — full texts, lazy-loaded
//   packages/client/desktop/src/generated/legal.json          — EULA + privacy md (from docs/legal)
//   NOTICES.txt                                                — full concatenated compliance artifact
//
//   Regenerate:  bun run --bun scripts/gen-notices.ts
//   (Run before packaging; a dependency change without regenerating drifts the
//    manifest — Phase-1 follow-up wires this into check-docs like gen-zh-hant.)
//
// Plain bun script (not a Workflow) — Date/fs are available here.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs"
import path from "path"

const ROOT = path.resolve(new URL("..", import.meta.url).pathname)
const OUT_DIR = path.join(ROOT, "packages/client/desktop/src/generated")

type Component = {
  id: number
  name: string
  version: string
  license: string
  modified: boolean
  source: "npm" | "opencode" | "cargo" | "vendored"
  url: string
}
// name@version(source) → full license text (only where we actually have it)
const texts = new Map<string, string>()
const components: Component[] = []
const seen = new Set<string>()

const key = (name: string, version: string, source: string) => `${source}:${name}@${version}`

function add(c: Omit<Component, "id">, licenseText?: string) {
  const k = key(c.name, c.version, c.source)
  if (seen.has(k)) return
  seen.add(k)
  components.push({ ...c, id: 0 })
  if (licenseText && licenseText.trim()) texts.set(k, licenseText.trim())
}

/** First matching LICENSE-ish file in a package dir. */
function readLicenseText(dir: string): string | undefined {
  let ents: string[]
  try {
    ents = readdirSync(dir)
  } catch {
    return
  }
  const hit = ents.find((f) => /^(LICEN[CS]E|COPYING|NOTICE)(\.|$)/i.test(f))
  if (!hit) return
  try {
    return readFileSync(path.join(dir, hit), "utf8")
  } catch {
    return
  }
}

function normalizeLicense(p: any): string {
  let l =
    p.license ||
    (p.licenses &&
      (Array.isArray(p.licenses)
        ? p.licenses.map((x: any) => x.type || x).join(" / ")
        : p.licenses.type || p.licenses)) ||
    "UNKNOWN"
  if (typeof l === "object") l = JSON.stringify(l)
  return String(l)
}

// ── Source 1: npm 依赖树 (root bun store) ────────────────────────────────────
function scanNpm() {
  const store = path.join(ROOT, "node_modules/.bun")
  if (!existsSync(store)) {
    console.warn("⚠️  node_modules/.bun 不存在，跳过 npm 扫描（先 bun install）")
    return
  }
  const readPkg = (dir: string) => {
    const pj = path.join(dir, "package.json")
    if (!existsSync(pj)) return
    try {
      const p = JSON.parse(readFileSync(pj, "utf8"))
      if (!p.name || !p.version || p.private) return
      add(
        {
          name: p.name,
          version: p.version,
          license: normalizeLicense(p),
          modified: false,
          source: "npm",
          url: `https://www.npmjs.com/package/${p.name}`,
        },
        readLicenseText(dir),
      )
    } catch {
      /* skip unreadable */
    }
  }
  for (const d of readdirSync(store)) {
    const inner = path.join(store, d, "node_modules")
    if (!existsSync(inner)) continue
    for (const e of readdirSync(inner, { withFileTypes: true })) {
      if (e.name === ".bin") continue
      const full = path.join(inner, e.name)
      if (e.name[0] === "@") {
        for (const s of readdirSync(full)) readPkg(path.join(full, s))
      } else {
        readPkg(full)
      }
    }
  }
}

// ── Source 2: opencode 内嵌树 (vendor/opencode/bun.lock) ─────────────────────
// The opencode-server binary is a compiled bun bundle we redistribute; its
// transitive deps are embedded but not in our root store. bun.lock (JSONC text
// lockfile) enumerates them. We reuse license text from the root store on
// name-overlap; the rest get an SPDX from the lockfile entry + an npm link.
function scanOpencodeEmbedded() {
  const lock = path.join(ROOT, "vendor/opencode/bun.lock")
  if (!existsSync(lock)) {
    console.warn("⚠️  vendor/opencode/bun.lock 不存在，跳过 opencode 内嵌树")
    return 0
  }
  let obj: any
  try {
    // bun.lock is JSONC — trailing commas only (no // comments; a naive
    // comment strip would eat the `//` inside https:// URLs and break parsing).
    const raw = readFileSync(lock, "utf8").replace(/,(\s*[}\]])/g, "$1")
    obj = JSON.parse(raw)
  } catch (e) {
    console.warn("⚠️  解析 vendor/opencode/bun.lock 失败，跳过：", (e as Error).message)
    return 0
  }
  const pkgs = obj.packages || {}
  // Build a name→(license,text) index from what npm scan already gathered.
  const byName = new Map<string, { license: string; text?: string }>()
  for (const c of components) {
    if (c.source !== "npm") continue
    byName.set(c.name, { license: c.license, text: texts.get(key(c.name, c.version, "npm")) })
  }
  let count = 0
  for (const k of Object.keys(pkgs)) {
    const entry = pkgs[k]
    // entry[0] = "name@version"; some keys are workspace/path aliases.
    const spec = Array.isArray(entry) ? entry[0] : entry
    if (typeof spec !== "string") continue
    const at = spec.lastIndexOf("@")
    if (at <= 0) continue
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    if (!version || /workspace:|link:|file:/.test(version)) continue
    // Prefer an SPDX embedded in the lock entry (bun stores it in some formats).
    const overlap = byName.get(name)
    add(
      {
        name,
        version,
        license: overlap?.license || "见 npm",
        modified: false,
        source: "opencode",
        url: `https://www.npmjs.com/package/${name}`,
      },
      overlap?.text,
    )
    count++
  }
  return count
}

// ── Source 3: Rust crates (cargo metadata) ───────────────────────────────────
function scanCargo() {
  const manifest = path.join(ROOT, "packages/client/desktop/src-tauri/Cargo.toml")
  if (!existsSync(manifest)) return
  let meta: any
  try {
    const proc = Bun.spawnSync(
      ["cargo", "metadata", "--format-version", "1", "--manifest-path", manifest],
      { cwd: ROOT },
    )
    if (proc.exitCode !== 0) {
      console.warn("⚠️  cargo metadata 失败，跳过 Rust 层（本机需 cargo）")
      return
    }
    meta = JSON.parse(proc.stdout.toString())
  } catch (e) {
    console.warn("⚠️  cargo metadata 异常，跳过 Rust 层：", (e as Error).message)
    return
  }
  for (const p of meta.packages || []) {
    // Skip our own workspace crate(s).
    if ((p.source ?? null) === null) continue
    add({
      name: p.name,
      version: p.version,
      license: p.license || "(license_file)",
      modified: false,
      source: "cargo",
      url: p.repository || `https://crates.io/crates/${p.name}`,
    })
  }
}

// ── Source 4: 捆绑 / vendored ────────────────────────────────────────────────
function addBundled() {
  // opencode itself — MIT, MODIFIED via patches/vendor-opencode-config-fix.patch.
  const ocLicense = path.join(ROOT, "vendor/opencode/LICENSE")
  add(
    {
      name: "opencode",
      version: readOpencodeVersion(),
      license: "MIT",
      modified: true, // patched — see patches/vendor-opencode-config-fix.patch
      source: "vendored",
      url: "https://github.com/sst/opencode",
    },
    existsSync(ocLicense) ? readFileSync(ocLicense, "utf8") : undefined,
  )
  // Vendored pptxgenjs (deckcraft editable-pptx export). MIT; the esbuild bundle
  // stripped its header, so we attach the canonical MIT notice here.
  add(
    {
      name: "pptxgenjs",
      version: readVendoredPptxVersion(),
      license: "MIT",
      modified: false,
      source: "vendored",
      url: "https://github.com/gitbrent/PptxGenJS",
    },
    "PptxGenJS\nCopyright (c) 2015-present Brent Ely\nReleased under the MIT License.\nhttps://github.com/gitbrent/PptxGenJS/blob/master/LICENSE",
  )
}

function readOpencodeVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, "vendor/opencode/package.json"), "utf8")).version || "unknown"
  } catch {
    return "unknown"
  }
}

function readVendoredPptxVersion(): string {
  // Best-effort: read from the vendor build metadata if present, else pin label.
  const meta = path.join(ROOT, "skills/builtin/deckcraft/scripts/html2pptx/vendor/pptxgen.version.txt")
  try {
    if (existsSync(meta)) return readFileSync(meta, "utf8").trim()
  } catch {
    /* ignore */
  }
  return "vendored"
}

// ── Legal docs (docs/legal → generated JSON for dynamic import) ───────────────
function readLegal(): { eula: string; privacy: string } {
  const read = (f: string) => {
    const p = path.join(ROOT, "docs/legal", f)
    if (!existsSync(p)) return ""
    // Strip internal HTML comments (e.g. the "草稿·商用前须经法务审阅" header) —
    // react-markdown renders them as visible literal text otherwise.
    return readFileSync(p, "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/^\n+/, "")
  }
  return { eula: read("user-service-agreement.md"), privacy: read("privacy-policy.md") }
}

// ── Emit ─────────────────────────────────────────────────────────────────────
function emit() {
  mkdirSync(OUT_DIR, { recursive: true })

  // Stable ordering: source group, then name — deterministic diffs across runs.
  const order: Record<Component["source"], number> = { vendored: 0, npm: 1, opencode: 2, cargo: 3 }
  components.sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  components.forEach((c, i) => (c.id = i + 1))

  const counts = {
    npm: components.filter((c) => c.source === "npm").length,
    opencode: components.filter((c) => c.source === "opencode").length,
    cargo: components.filter((c) => c.source === "cargo").length,
    vendored: components.filter((c) => c.source === "vendored").length,
    total: components.length,
    withText: texts.size,
  }

  writeFileSync(
    path.join(OUT_DIR, "licenses.json"),
    JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), counts, components }, null, 0) + "\n",
  )

  // Full texts keyed by component id (renderer resolves id → text on expand).
  const textById: Record<number, string> = {}
  for (const c of components) {
    const t = texts.get(key(c.name, c.version, c.source))
    if (t) textById[c.id] = t
  }
  writeFileSync(path.join(OUT_DIR, "license-texts.json"), JSON.stringify(textById, null, 0) + "\n")

  writeFileSync(path.join(OUT_DIR, "legal.json"), JSON.stringify(readLegal(), null, 0) + "\n")

  // NOTICES.txt — full compliance artifact (plain text, not bundled into renderer).
  const lines: string[] = [
    "第三方开源软件声明 / THIRD-PARTY OPEN SOURCE SOFTWARE NOTICES",
    `生成时间: ${new Date().toISOString().slice(0, 10)}`,
    `组件数: ${counts.total} (npm ${counts.npm} / opencode 内嵌 ${counts.opencode} / cargo ${counts.cargo} / 捆绑 ${counts.vendored})`,
    "本产品包含以下第三方开源软件，各自受其许可协议约束。",
    "=".repeat(78),
    "",
  ]
  for (const c of components) {
    lines.push(`#${c.id} ${c.name}@${c.version}  [${c.license}]${c.modified ? "  (已修改/MODIFIED)" : ""}`)
    lines.push(`  来源: ${c.source}  ${c.url}`)
    const t = texts.get(key(c.name, c.version, c.source))
    if (t) {
      lines.push("")
      lines.push(t.split("\n").map((l) => "  " + l).join("\n"))
    }
    lines.push("")
    lines.push("-".repeat(78))
    lines.push("")
  }
  writeFileSync(path.join(ROOT, "NOTICES.txt"), lines.join("\n"))

  console.log("gen-notices: 生成完成")
  console.log(`  组件总数: ${counts.total}`)
  console.log(`    npm=${counts.npm}  opencode内嵌=${counts.opencode}  cargo=${counts.cargo}  vendored=${counts.vendored}`)
  console.log(`  含许可全文: ${counts.withText}`)
  console.log(`  → ${path.relative(ROOT, OUT_DIR)}/{licenses,license-texts,legal}.json`)
  console.log(`  → NOTICES.txt`)
  // Loud coverage note — never let a gap read as "fully covered".
  const noText = counts.total - counts.withText
  if (noText > 0) {
    console.log(
      `  ⚠️  ${noText} 个组件无本地许可全文（多为 opencode 内嵌/cargo 层，仅 SPDX+链接）。` +
        `完整全文需专项补齐（opencode 需在 build-opencode 时 populate node_modules；cargo 需读 registry src）。`,
    )
  }
}

scanNpm()
const ocCount = scanOpencodeEmbedded()
scanCargo()
addBundled()
console.log(`(opencode 内嵌树解析出 ${ocCount} 个包)`)
emit()
