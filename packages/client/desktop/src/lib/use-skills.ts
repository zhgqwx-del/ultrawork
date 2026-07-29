import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { toast } from "sonner"
import { invoke } from "@tauri-apps/api/core"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import type { Command, Skill } from "@agent/api-client"
import { GROUP_ORDER, isHiddenBuiltinCommand, type SkillSource } from "@/lib/command-menu"

export type { SkillSource }

export interface SkillItem {
  name: string
  description: string
  source: SkillSource
  location?: string
  hints?: string[]
  /** True when the skill is shipped with ultrawork (lives under skills/builtin/). */
  builtin: boolean
}

/** A skill is built-in when its SKILL.md lives under the bundled builtin dir.
 *  Tolerates Windows backslash separators in the reported location. */
export function isBuiltinLocation(location?: string): boolean {
  return !!location && /[\\/]skills[\\/]builtin[\\/]/.test(location)
}

export interface SkillGroup {
  key: SkillSource
  items: SkillItem[]
}

export interface SkillsConfig {
  paths: string[]
  urls: string[]
}

export function useSkills() {
  const api = useApi()
  const { t } = useI18n()
  const [commands, setCommands] = useState<Command[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [skillsConfig, setSkillsConfig] = useState<SkillsConfig>({ paths: [], urls: [] })
  const skillsConfigRef = useRef(skillsConfig)
  skillsConfigRef.current = skillsConfig
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const [cmds, sks, config] = await Promise.all([
        api.getCommands(),
        api.getSkills(),
        api.getConfig(),
      ])
      setCommands(cmds)
      setSkills(sks)
      // Extract skills config from server config
      const sc = (config as Record<string, unknown>).skills as { paths?: string[]; urls?: string[] } | undefined
      setSkillsConfig({
        paths: sc?.paths || [],
        urls: sc?.urls || [],
      })
      setError(false)
    } catch (err) {
      console.error("Failed to fetch skills:", err)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { fetchData() }, [fetchData])

  // Explicit refresh (e.g. after installing a skill). opencode caches the skill
  // list in an instance state and has NO skill-dir watcher, so a freshly installed
  // skill under ~/.config/ultrawork/skills/ is invisible until the cache is
  // refreshed. Soft-refresh first (cheap, non-disruptive — does NOT abort in-flight
  // turns, ADR-039) so the re-read reflects on-disk truth. Mount uses fetchData
  // directly since caches are fresh at startup.
  const refresh = useCallback(async () => {
    // Reconcile builtin-vs-user shadowing BEFORE the rescan: a skill installed
    // by skill-installer mid-session may share its name with a builtin twin,
    // and opencode's single glob scan races on duplicates (gotchas §10). The
    // Rust reconcile prunes the builtin copy so the scan only sees one file.
    // Best-effort: browser walkthroughs have no Tauri bridge.
    await invoke("refresh_builtin_skills").catch(() => {})
    await api.refreshGlobalConfig().catch(() => {})
    await fetchData()
  }, [api, fetchData])

  // Merge commands + skills into SkillItems, dedup by name
  const allItems = useMemo(() => {
    const seen = new Set<string>()
    const items: SkillItem[] = []

    // Build a name→location map from /skill so we can enrich Command-sourced skills
    const skillLocationMap = new Map<string, string>()
    for (const sk of skills) {
      if (sk.location) skillLocationMap.set(sk.name, sk.location)
    }

    // Commands first — they have template/hints, take priority over /skill dupes
    // Filter out developer-oriented built-in commands (init, review) for end users
    for (const cmd of commands) {
      if (seen.has(cmd.name)) continue
      if (isHiddenBuiltinCommand(cmd.name, cmd.source)) continue
      seen.add(cmd.name)
      const location = skillLocationMap.get(cmd.name)
      items.push({
        name: cmd.name,
        description: cmd.description,
        source: (cmd.source as SkillSource) || "command",
        hints: cmd.hints,
        location,
        builtin: isBuiltinLocation(location),
      })
    }

    // Skills from /skill endpoint
    for (const sk of skills) {
      if (seen.has(sk.name)) continue
      seen.add(sk.name)
      items.push({
        name: sk.name,
        description: sk.description,
        source: "skill",
        location: sk.location,
        builtin: isBuiltinLocation(sk.location),
      })
    }

    return items
  }, [commands, skills])

  // Group by source, ordered: command → mcp → skill, skip empty groups
  const groups = useMemo(() => {
    const map = new Map<SkillSource, SkillItem[]>()
    for (const item of allItems) {
      const list = map.get(item.source) || []
      list.push(item)
      map.set(item.source, list)
    }
    return GROUP_ORDER
      .filter((key) => map.has(key))
      .map((key) => ({ key, items: map.get(key)! }))
  }, [allItems])

  const totalCount = allItems.length

  const updateSkillsConfig = useCallback(async (updates: Partial<SkillsConfig>) => {
    const prev = skillsConfigRef.current
    const newConfig = { ...prev, ...updates }
    // Optimistic update so consecutive calls see latest state
    setSkillsConfig(newConfig)
    skillsConfigRef.current = newConfig
    try {
      await api.patchConfig({ skills: newConfig } as Record<string, unknown>)
      toast.success(t("skills.configSaved"))
    } catch (err) {
      console.error("Failed to save skills config:", err)
      toast.error(t("skills.configError"))
      // Revert on failure
      setSkillsConfig(prev)
    }
  }, [api, t])

  return {
    groups,
    allItems,
    loading,
    error,
    totalCount,
    skillsConfig,
    refresh,
    updateSkillsConfig,
  }
}
