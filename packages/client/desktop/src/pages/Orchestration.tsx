// Pipeline surface (ADR-031 D-7 / 018 A-3): code-driven recipes only.
// Team collaboration moved into the main chat flow (Home segmented entry +
// sidebar 混排 + Session page) — agent-driven orchestration no longer has a
// separate page.

import { useNavigate } from "react-router-dom"
import { TopBar } from "@/components/layout/top-bar"
import { useI18n } from "@/lib/i18n-context"
import { PipelineTab } from "@/components/orchestration/pipeline-tab"

export function OrchestrationPage() {
  const navigate = useNavigate()
  const { t } = useI18n()

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <TopBar title={t("orchestration.title")} onClose={() => navigate("/")} />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <PipelineTab />
      </div>
    </div>
  )
}
