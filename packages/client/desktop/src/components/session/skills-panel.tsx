import { useNavigate } from "react-router-dom"
import { useI18n } from "@/lib/i18n-context"
import { useSkills } from "@/lib/use-skills"
import { Terminal, Globe, Sparkles, Settings2 } from "lucide-react"
import type { SkillSource, SkillGroup } from "@/lib/use-skills"

const GROUP_ICONS: Record<SkillSource, typeof Terminal> = {
  command: Terminal,
  mcp: Globe,
  skill: Sparkles,
}

const GROUP_LABEL_KEYS: Record<SkillSource, string> = {
  command: "skills.group.command",
  mcp: "skills.group.mcp",
  skill: "skills.group.skill",
}

interface SkillsPanelProps {
  onSkillClick?: (name: string) => void
}

export function SkillsPanel({ onSkillClick }: SkillsPanelProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { groups, loading, error, totalCount } = useSkills()

  if (loading) {
    return <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("common.loading")}</p>
  }

  if (error) {
    return <p className="py-2 text-xs text-red-500">{t("error.fetchSkills")}</p>
  }

  if (totalCount === 0) {
    return <p className="py-1 text-xs text-[var(--color-fg-muted)]">{t("skills.noItems")}</p>
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <SkillGroupSection
          key={group.key}
          group={group}
          onSkillClick={onSkillClick}
        />
      ))}

      {/* Manage skills link */}
      <button
        onClick={() => navigate("/settings", { state: { section: "skills" } })}
        className="flex w-full items-center gap-1.5 py-1 text-[10px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
      >
        <Settings2 className="size-3" />
        {t("skills.manage")}
      </button>
    </div>
  )
}

function SkillGroupSection({
  group,
  onSkillClick,
}: {
  group: SkillGroup
  onSkillClick?: (name: string) => void
}) {
  const { t } = useI18n()
  const Icon = GROUP_ICONS[group.key]

  return (
    <div className="space-y-1">
      {/* Group header */}
      <div className="flex items-center gap-1.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
        <Icon className="size-3" />
        <span>{t(GROUP_LABEL_KEYS[group.key])}</span>
        <span className="opacity-60">({group.items.length})</span>
      </div>

      {/* Skill cards */}
      {group.items.map((item) => (
        <button
          key={item.name}
          onClick={() => onSkillClick?.(item.name)}
          className="flex w-full items-start gap-2 rounded-md bg-[var(--color-accent)] px-2 py-1.5 text-left transition-colors hover:brightness-95"
        >
          <Icon className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-[var(--color-fg)]">/{item.name}</p>
            <p className="line-clamp-2 text-[10px] text-[var(--color-fg-muted)]">{item.description}</p>
          </div>
        </button>
      ))}
    </div>
  )
}
