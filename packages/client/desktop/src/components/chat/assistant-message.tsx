import { memo } from "react"
import { ReasoningBlock } from "./reasoning-block"
import { ToolCallBlock } from "./tool-call-block"
import { StepIndicator } from "./step-indicator"
import { MarkdownContent, FileBlock, PatchBlock } from "./message-parts"
import type { MessagePart, ToolPart, FilePart, PatchPart } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { useI18n } from "@/lib/i18n-context"

interface AssistantMessageProps {
  parts: MessagePart[]
  isStreaming?: boolean
  onArtifactClick?: (artifact: Artifact) => void
}

/**
 * Legacy per-message renderer: flattens parts into stacked blocks.
 * The main chat view now renders turns via AssistantTurn + ExecutionFlow;
 * this component is kept for backwards compatibility / isolated use.
 */
export const AssistantMessage = memo(function AssistantMessage({ parts, isStreaming = false, onArtifactClick }: AssistantMessageProps) {
  const { t } = useI18n()
  return (
    <div className="py-3">
      <div className="space-y-0">
        {parts.map((part, i) => {
          const key = ('id' in part && part.id) ? part.id : `part-${i}`
          switch (part.type) {
            case "text":
              return <MarkdownContent key={key} text={part.text || ""} />
            case "reasoning":
              return <ReasoningBlock key={key} text={part.text || ""} />
            case "tool":
              return (
                <ToolCallBlock
                  key={key}
                  tool={(part as ToolPart).tool}
                  state={(part as ToolPart).state}
                />
              )
            case "step-finish":
              return (
                <StepIndicator
                  key={key}
                  reason={part.reason}
                  tokens={part.tokens}
                  cost={part.cost}
                />
              )
            case "file":
              return (
                <FileBlock
                  key={key}
                  part={part as FilePart}
                  onArtifactClick={onArtifactClick}
                />
              )
            case "patch":
              return (
                <PatchBlock
                  key={key}
                  part={part as PatchPart}
                  onArtifactClick={onArtifactClick}
                />
              )
            case "step-start":
              return null
            default:
              return null
          }
        })}

        {isStreaming && (
          <div className="flex items-center gap-2 py-2">
            <div className="flex items-center gap-1">
              <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
              <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-primary)] [animation-delay:0.2s]" />
              <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-primary)] [animation-delay:0.4s]" />
            </div>
            <span className="text-xs text-[var(--color-fg-muted)]">{t("message.aiTyping")}</span>
          </div>
        )}
      </div>
    </div>
  )
})
