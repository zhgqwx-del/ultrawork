import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

/** Mirror of the Rust `BuiltinSkillsStatus` (refresh_builtin_skills command). */
export interface BuiltinSkillsStatus {
  /** Frontmatter names of skills shipped in the app bundle. */
  bundled: string[]
  /** Bundled names currently overridden by a user install (builtin copy pruned). */
  shadowed: string[]
  /** True when this reconcile mutated disk (install/prune/restore) — the owner
   *  must follow with a soft refresh so opencode's cached scan matches disk. */
  changed: boolean
}

const EMPTY: BuiltinSkillsStatus = { bundled: [], shadowed: [], changed: false }

function isStatus(v: unknown): v is BuiltinSkillsStatus {
  const s = v as BuiltinSkillsStatus | null
  return !!s && Array.isArray(s.bundled) && Array.isArray(s.shadowed)
}

/**
 * Filesystem truth about builtin-vs-user skill shadowing (gotchas §10): a
 * user-installed skill with the same frontmatter name permanently overrides
 * its builtin twin (the builtin disk copy is pruned so opencode's single glob
 * scan never sees two same-name SKILL.md files — the race source). Outside
 * Tauri (browser walkthroughs) both lists stay empty: the builtin tab simply
 * shows no shadow cards.
 *
 * Coordination contract: a reconcile that reports `changed` has ALREADY
 * mutated disk but opencode's skill cache is still stale — the consuming
 * section must follow with useSkills.refresh() (soft refresh + refetch),
 * otherwise the UI shows both copies / a live skill whose files are gone.
 * The status set into state and the one RETURNED are the same object by
 * design: the owner's handled-ref dedup relies on that identity — don't
 * clone/normalize on either side.
 */
export function useBuiltinShadow() {
  const [status, setStatus] = useState<BuiltinSkillsStatus>(EMPTY)
  const [loading, setLoading] = useState(true)

  const reconcile = useCallback(async (): Promise<BuiltinSkillsStatus> => {
    try {
      const s = await invoke<BuiltinSkillsStatus | null>("refresh_builtin_skills")
      if (isStatus(s)) {
        setStatus(s)
        return s
      }
    } catch (err) {
      console.warn("refresh_builtin_skills unavailable:", err)
    } finally {
      setLoading(false)
    }
    return EMPTY
  }, [])

  useEffect(() => {
    reconcile()
  }, [reconcile])

  /** Delete the user override of a builtin skill and restore the bundled copy.
   *  Throws on failure — including a malformed result (treating it as success
   *  would toast "restored" over a stale shadow card); the caller shows the
   *  error toast and resyncs from filesystem truth. */
  const removeOverride = useCallback(async (name: string): Promise<BuiltinSkillsStatus> => {
    const s = await invoke<BuiltinSkillsStatus>("remove_user_skill_override", { name })
    if (!isStatus(s)) {
      throw new Error("malformed remove_user_skill_override result")
    }
    setStatus(s)
    return s
  }, [])

  return { status, loading, reconcile, removeOverride }
}
