import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

/** One external tool probed on the host PATH (mirrors Rust DepStatus). */
export interface DepStatus {
  name: string
  available: boolean
  path?: string | null
}

export type DepMap = Record<string, DepStatus>

/**
 * SSOT mapping built-in skill name -> external tools it shells out to.
 * Keyed by the SKILL.md frontmatter `name`. The `x-requires` frontmatter in each
 * SKILL.md mirrors this for human readers; this map drives the readiness badges.
 * Python libraries (python-docx/openpyxl/python-pptx) can't be probed via PATH —
 * doc-edit only checks for `python3`; its scripts error gracefully on missing libs.
 */
export const BUILTIN_DEP_MAP: Record<string, string[]> = {
  "skill-creator": ["python3"],
  "skill-installer": ["python3", "git"],
  // Rewritten as an ultrawork skill (discussions/059 S2) and then moved off
  // PyMuPDF (S3.5): PyMuPDF is AGPL-3.0-or-commercial and this tree ships inside a
  // product, so the skill now stands on four permissive libraries and needs all
  // four — pypdfium2 (Apache-2.0) rasterizes, pypdf (BSD-3) is the object model,
  // pdfplumber (MIT) reads tables and text geometry, reportlab (BSD) writes.
  // `pdftoppm` is deliberately absent — nothing in the skill shells out to it, and
  // a required tool nobody calls is a badge that says "not ready" for no reason.
  // All four are import probes, not PATH probes (see the python module list in
  // src-tauri check_skill_dependencies).
  pdf: ["python3", "pypdfium2", "pypdf", "pdfplumber", "reportlab"],
  // Written for ultrawork (discussions/059 S3). openpyxl reads; lxml does the
  // surgical sheet-XML edit that keeps charts/pivot caches/custom parts alive, and
  // openpyxl does NOT pull lxml in, so it is a real requirement rather than a
  // transitive one. soffice is the FIRST skill to declare it — it was already being
  // PATH-probed by SKILL_DEP_BINS with nothing asking for it. It is required, not
  // optional: formula recalculation has no pure-Python substitute, and converting to
  // PDF is the only way an .xlsx becomes visible in the artifact panel (059 §7).
  xlsx: ["python3", "openpyxl", "lxml", "soffice"],
  // Written for ultrawork (discussions/059 S4). Note what is NOT here:
  // **python-docx**. Every reference implementation of a docx skill is built on it,
  // and this one is not — it reads and writes WordprocessingML through lxml
  // directly. Two measured reasons (059 §六·补五): python-docx's bundled template
  // ships a `<w:zoom>` that fails ECMA-376 validation, so every document it produces
  // carries that defect; and its model has no place at all for tracked revisions,
  // comments or a phrase that spans runs, which is most of what this skill does.
  // soffice is required for the same reason it is for xlsx: a .docx cannot be
  // previewed inside ultrawork, so converting to PDF is the only way an artifact
  // becomes visible (059 §7).
  docx: ["python3", "lxml", "soffice"],
  "markdown-exporter": ["markdown-exporter", "pandoc"],
  "doc-edit": ["python3"],
  // HTML-first deck generator (discussions/043). python3.10+ (not plain
  // python3): the source_to_md converters copied from ppt-master use module/
  // signature-level `X | None` unions without `from __future__ import
  // annotations` — same 3.9-TypeError trap that forced ppt-master's probe.
  // python-pptx: the image-type .pptx export (export_deck.py --pptx).
  // chrome-or-edge is the headless export engine — probed by install location
  // (Rust detect_export_browser), not PATH.
  // pillow: the core export path itself imports PIL (export_deck.py), so it is
  // required — it was missing from this list entirely until 059 S3.5 went looking.
  // node: OPTIONAL (see OPTIONAL_DEPS) — only the editable-pptx export
  // (--pptx-editable, P2b) needs it; HTML/PDF/image-pptx work without it.
  //
  // Everything after `node` is a SOURCE READER and therefore optional: each one
  // is imported only when the user feeds deckcraft that kind of source document,
  // and a deck built from a topic or from Markdown touches none of them. Marking
  // them required would put the whole skill in "not ready" because someone who
  // only ever makes decks from Markdown has no nbconvert. They are declared
  // anyway — before this the PDF reader was a hard dependency that the UI never
  // mentioned (059 §4·补 item 2), which is the failure mode being fixed:
  //   PDF   -> pdfplumber, pypdf, pypdfium2   (source_to_md/pdfsource.py)
  //   DOCX / EPUB / .ipynb -> mammoth, ebooklib, nbconvert, markdownify,
  //                           beautifulsoup4, requests
  //   XLSX  -> openpyxl
  //   URL   -> curl_cffi, requests, beautifulsoup4
  //   PPTX  -> python-pptx, already required above
  deckcraft: [
    "python3.10+", "python-pptx", "pillow", "chrome-or-edge", "node",
    "pdfplumber", "pypdf", "pypdfium2",
    "mammoth", "ebooklib", "nbconvert", "markdownify", "beautifulsoup4", "requests",
    "openpyxl", "curl_cffi",
  ],
  // Official Feishu/Lark CLI (installed via 设置 → 连接器 → 办公 CLI, or any
  // user install on PATH). The badge only reflects binary presence; auth state
  // lives in the connector card (use-cli-connectors).
  "feishu-assistant": ["lark-cli"],
  // Official DingTalk CLI — same connector-managed model as lark-cli.
  "dingtalk-assistant": ["dws"],
  // Official WeCom CLI — same connector-managed model.
  "wecom-assistant": ["wecom-cli"],
}

// pip-installable libraries the office skills import. The command is the same on
// every platform, so they live here once instead of being copied into all three
// branches below and drifting apart.
//
// These were missing entirely until 059 S3.5 audited the badge: the pdf skill's
// four permissive libraries, xlsx's two and deckcraft's Pillow all fell through to
// `DEP_HINTS[m] ?? m` and rendered as a bare name. "缺少: pypdfium2, pypdf,
// pdfplumber, reportlab" tells a user nothing actionable, and the guide button
// handed the same bare names to the assistant.
export const PIP_HINTS: Record<string, string> = {
  "python-pptx": "pip install python-pptx",
  // pdf skill (all four required — 059 §六·补三)
  pypdfium2: "pip install pypdfium2",
  pypdf: "pip install pypdf",
  pdfplumber: "pip install pdfplumber",
  reportlab: "pip install reportlab",
  // xlsx skill
  openpyxl: "pip install openpyxl",
  lxml: "pip install lxml",
  // deckcraft: Pillow is on the core export path; the rest are per-format source
  // readers and only surface when that format is actually needed.
  pillow: "pip install pillow",
  mammoth: "pip install mammoth",
  ebooklib: "pip install ebooklib",
  nbconvert: "pip install nbconvert",
  markdownify: "pip install markdownify",
  beautifulsoup4: "pip install beautifulsoup4",
  requests: "pip install requests",
  curl_cffi: "pip install curl_cffi",
}

/**
 * Tools that are not required but recommended; absence shouldn't mark "not ready".
 *
 * Entries are either a bare dependency name (optional for every skill) or
 * `"<skill>:<dep>"` (optional for that skill only). The scoped form is not
 * decoration: `pdfplumber`, `pypdf` and `pypdfium2` are what the whole `pdf`
 * skill stands on and it is genuinely not ready without them, while for
 * deckcraft they only unlock reading a PDF *source*. The same name has to mean
 * different things in the two places, so a flat name-keyed set would have
 * silently reported the pdf skill as ready with no PDF library at all.
 */
export const OPTIONAL_DEPS = new Set<string>([
  // deckcraft's editable-pptx export (P2b) needs Node; the skill's core
  // deliverables (HTML/PDF/image-pptx) don't, so a missing Node must not gate it.
  "node",
  // deckcraft's source readers — one group per input format it can ingest.
  // Declaring them makes the badge say WHICH format is unavailable; keeping them
  // optional keeps a deck-from-Markdown user out of a "not ready" state they
  // cannot act on and did not cause.
  "deckcraft:pdfplumber", "deckcraft:pypdf", "deckcraft:pypdfium2",
  "deckcraft:mammoth", "deckcraft:ebooklib", "deckcraft:nbconvert",
  "deckcraft:markdownify", "deckcraft:beautifulsoup4", "deckcraft:requests",
  "deckcraft:openpyxl", "deckcraft:curl_cffi",
])

/** Whether `dep` is tolerated as missing — globally, or just for this skill. */
export function isOptionalDep(skillName: string, dep: string): boolean {
  return OPTIONAL_DEPS.has(dep) || OPTIONAL_DEPS.has(`${skillName}:${dep}`)
}

/** Required tools for a skill that are currently missing (empty = ready). */
export function missingDeps(skillName: string, deps: DepMap): string[] {
  const required = BUILTIN_DEP_MAP[skillName] ?? []
  return required.filter((d) => !isOptionalDep(skillName, d) && !deps[d]?.available)
}

/**
 * Probe host dependencies via the `check_skill_dependencies` Tauri command.
 * Returns an empty map outside Tauri (e.g. browser GUI walkthroughs) so callers
 * don't crash; note an empty map renders every required tool as "missing"
 * (pessimistic, matches pre-Tauri-failure behavior) — the guide prompt asks the
 * AI to re-detect the environment first, so the handoff still degrades safely.
 */
export function useSkillDeps(): { deps: DepMap; loading: boolean } {
  const [deps, setDeps] = useState<DepMap>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    invoke<DepStatus[]>("check_skill_dependencies")
      .then((arr) => {
        if (!alive) return
        setDeps(Object.fromEntries(arr.map((d) => [d.name, d])))
      })
      .catch((err) => {
        console.warn("check_skill_dependencies unavailable:", err)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  return { deps, loading }
}
