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
  // Rewritten as an ultrawork skill (discussions/059 S2): PyMuPDF everywhere, no
  // Poppler. `pdftoppm` is deliberately gone — nothing in the skill shells out to
  // it any more, and a required tool nobody calls is a badge that says "not ready"
  // for no reason. pymupdf is an import probe, not a PATH probe (see the python
  // module list in src-tauri check_skill_dependencies).
  pdf: ["python3", "pymupdf"],
  "markdown-exporter": ["markdown-exporter", "pandoc"],
  "doc-edit": ["python3"],
  // HTML-first deck generator (discussions/043). python3.10+ (not plain
  // python3): the source_to_md converters copied from ppt-master use module/
  // signature-level `X | None` unions without `from __future__ import
  // annotations` — same 3.9-TypeError trap that forced ppt-master's probe.
  // python-pptx: the image-type .pptx export (export_deck.py --pptx).
  // chrome-or-edge is the headless export engine — probed by install location
  // (Rust detect_export_browser), not PATH.
  // node: OPTIONAL (see OPTIONAL_DEPS) — only the editable-pptx export
  // (--pptx-editable, P2b) needs it; HTML/PDF/image-pptx work without it.
  deckcraft: ["python3.10+", "python-pptx", "chrome-or-edge", "node"],
  // Official Feishu/Lark CLI (installed via 设置 → 连接器 → 办公 CLI, or any
  // user install on PATH). The badge only reflects binary presence; auth state
  // lives in the connector card (use-cli-connectors).
  "feishu-assistant": ["lark-cli"],
  // Official DingTalk CLI — same connector-managed model as lark-cli.
  "dingtalk-assistant": ["dws"],
  // Official WeCom CLI — same connector-managed model.
  "wecom-assistant": ["wecom-cli"],
}

/** Tools that are not required but recommended; absence shouldn't mark "not ready". */
export const OPTIONAL_DEPS = new Set<string>([
  // deckcraft's editable-pptx export (P2b) needs Node; the skill's core
  // deliverables (HTML/PDF/image-pptx) don't, so a missing Node must not gate it.
  "node",
])

/** Required tools for a skill that are currently missing (empty = ready). */
export function missingDeps(skillName: string, deps: DepMap): string[] {
  const required = BUILTIN_DEP_MAP[skillName] ?? []
  return required.filter((d) => !OPTIONAL_DEPS.has(d) && !deps[d]?.available)
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
