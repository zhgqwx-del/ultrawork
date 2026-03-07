import { useState, useEffect, useCallback } from "react"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { Terminal, Sparkles } from "lucide-react"
import type { Command, Skill } from "@agent/api-client"

export function SkillsPanel() {
  const api = useApi()
  const { t } = useI18n()
  const [commands, setCommands] = useState<Command[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const [cmds, sks] = await Promise.all([
        api.getCommands(),
        api.getSkills(),
      ])
      setCommands(cmds)
      setSkills(sks)
      setError(false)
    } catch (err) {
      console.error("Failed to fetch skills/commands:", err)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) {
    return <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("common.loading")}</p>
  }

  if (error) {
    return <p className="py-2 text-xs text-red-500">{t("error.fetchSkills")}</p>
  }

  const hasContent = commands.length > 0 || skills.length > 0

  if (!hasContent) {
    return <p className="py-1 text-xs text-[var(--color-fg-muted)]">{t("skills.noItems")}</p>
  }

  return (
    <div className="space-y-1.5">
      {commands.map((cmd) => (
        <div
          key={cmd.name}
          className="flex items-start gap-2 rounded-md bg-[var(--color-accent)] px-2 py-1.5"
        >
          <Terminal className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-[var(--color-fg)]">/{cmd.name}</p>
            <p className="text-[10px] text-[var(--color-fg-muted)]">{cmd.description}</p>
          </div>
        </div>
      ))}

      {skills.map((skill) => (
        <div
          key={skill.name}
          className="flex items-start gap-2 rounded-md bg-[var(--color-accent)] px-2 py-1.5"
        >
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-[var(--color-brand)]" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-[var(--color-fg)]">{skill.name}</p>
            <p className="text-[10px] text-[var(--color-fg-muted)]">{skill.description}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
