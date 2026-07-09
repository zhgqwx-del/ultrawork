import type { ComponentType, ReactNode } from "react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useI18n } from "@/lib/i18n-context"

/** One tab in a settings section's sub-navigation.
 *
 *  `count` is the number of ENTRIES under the tab (configured MCP servers,
 *  bundled skills, knowledge sources) — never a status count. Connection /
 *  readiness state belongs in the section header's badge, where one number
 *  can't be mistaken for the other. Rendered even when 0, so an empty
 *  category announces itself without the user clicking into it. */
export type SectionTab<T extends string> = {
  id: T
  labelKey: string
  icon?: ComponentType<{ className?: string }>
  count?: number
}

/** Shared sub-tab bar for the settings sections (Skills / Connectors /
 *  Knowledge). Wraps the tab LIST only — callers render their own
 *  `<TabsContent>` children, because `forceMount` is a per-panel decision:
 *
 *  - Panels holding in-flight component-local state (the MCP panel's browser
 *    install progress, half-filled add forms) MUST opt in, or a tab switch
 *    destroys that state. See conventions §5.
 *  - Panels whose tabs render OVERLAPPING subsets of one list (Knowledge: an
 *    "All" tab plus per-type tabs) MUST NOT opt in — force-mounting them would
 *    render the same source card twice and run its progress timer twice. */
export function SectionTabs<T extends string>({
  tabs,
  value,
  onValueChange,
  children,
}: {
  tabs: readonly SectionTab<T>[]
  value: T
  onValueChange: (value: T) => void
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <Tabs value={value} onValueChange={(v) => onValueChange(v as T)}>
      <TabsList className="w-full justify-start">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5">
            {tab.icon && <tab.icon className="size-3.5" />}
            {t(tab.labelKey)}
            {tab.count !== undefined && <span className="text-xs opacity-60">{tab.count}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  )
}
