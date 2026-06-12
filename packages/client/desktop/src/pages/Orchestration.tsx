// Orchestration surface (ADR-031 D-7 / 017): one route, two tabs — the two
// faces of D-1's hybrid principle. "Team 协作" (agent-driven: a Leader session
// where delegation is the default behavior) and "流水线" (code-driven Pipeline
// / Fan-out recipes). Single-session chat stays untouched elsewhere.

import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { GitFork, Users } from "lucide-react"
import { TopBar } from "@/components/layout/top-bar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useI18n } from "@/lib/i18n-context"
import { PipelineTab } from "@/components/orchestration/pipeline-tab"
import { TeamTab } from "@/components/orchestration/team-tab"

export function OrchestrationPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [tab, setTab] = useState("team")

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <TopBar title={t("orchestration.title")} onClose={() => navigate("/")} />
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 justify-center border-b border-[var(--color-border)] px-6 py-2">
          <TabsList>
            <TabsTrigger value="team" className="gap-1.5">
              <Users className="size-3.5" />
              {t("team.tab")}
            </TabsTrigger>
            <TabsTrigger value="pipeline" className="gap-1.5">
              <GitFork className="size-3.5" />
              {t("orchestration.tab")}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="team" className="mt-0 flex min-h-0 flex-1 flex-col">
          <TeamTab />
        </TabsContent>
        <TabsContent value="pipeline" className="mt-0 min-h-0 flex-1 overflow-y-auto p-6">
          <PipelineTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
