import { classifyZenError, zenRetryAt } from "./free-model"
import { formatDateTime } from "./format-time"

export function modelErrorMessage(
  error: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
  language?: string,
  at = Date.now(),
  providerID?: string,
): string | undefined {
  if (!error) return undefined
  const kind = classifyZenError(error)
  if (kind === "quota" && (!providerID || providerID === "opencode")) {
    const time = formatDateTime(zenRetryAt(error, at), language)
    return t("freeTrial.quotaExceeded") + (time ? `\n${t("freeTrial.retryAt", { time })}` : "")
  }
  if (kind === "unavailable") return t("freeTrial.modelUnavailable")
  if (typeof error === "string") return error
  if (typeof error !== "object") return undefined
  const value = error as { name?: string; message?: string; data?: { message?: string } }
  return value.data?.message ?? value.message ?? value.name
}
