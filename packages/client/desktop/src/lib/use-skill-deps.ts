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
  pdf: ["python3", "pdftoppm"],
  "markdown-exporter": ["markdown-exporter", "pandoc"],
  "doc-edit": ["python3"],
  // python3.10+ (version-probed: skill uses `X | None` unions at module level) and
  // python-pptx (pip library, import-probed — needed by the PPTX export step
  // svg_to_pptx.py). Neither is PATH-probeable; both come from Rust probe_python_ok.
  // Other pip deps are per-feature and error gracefully in-skill (error_helper.py).
  "ppt-master": ["python3.10+", "python-pptx"],
  // Official Feishu/Lark CLI (installed via 设置 → 连接器 → 办公 CLI, or any
  // user install on PATH). The badge only reflects binary presence; auth state
  // lives in the connector card (use-cli-connectors).
  "feishu-assistant": ["lark-cli"],
}

/** Tools that are not required but recommended; absence shouldn't mark "not ready". */
export const OPTIONAL_DEPS = new Set<string>([])

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
