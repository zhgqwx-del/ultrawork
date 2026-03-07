import { useI18n } from "@/lib/i18n-context"

interface StepFinishProps {
  reason?: string
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache?: { read: number; write: number }
  }
  cost?: number
}

function formatTokens(n?: number): string {
  if (n == null) return "0"
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function StepIndicator({ reason, tokens, cost }: StepFinishProps) {
  const { t } = useI18n()
  const hasStats = tokens || cost != null

  if (!hasStats) return null

  return (
    <div className="my-2 flex items-center gap-3 text-[10px] text-[var(--color-fg-muted)]">
      <div className="h-px flex-1 bg-[var(--color-border)]" />
      <div className="flex items-center gap-2">
        {tokens?.input != null && <span>{t("message.tokensInput")}: {formatTokens(tokens.input)}</span>}
        {tokens?.output != null && <span>{t("message.tokensOutput")}: {formatTokens(tokens.output)}</span>}
        {tokens?.reasoning != null && tokens.reasoning > 0 && <span>{t("message.tokensReasoning")}: {formatTokens(tokens.reasoning)}</span>}
        {tokens?.cache && (tokens.cache.read > 0 || tokens.cache.write > 0) && (
          <span>Cache: {formatTokens(tokens.cache.read)}r/{formatTokens(tokens.cache.write)}w</span>
        )}
        {cost != null && <span>${cost.toFixed(4)}</span>}
        {reason && reason !== "stop" && <span>({reason})</span>}
      </div>
      <div className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  )
}
