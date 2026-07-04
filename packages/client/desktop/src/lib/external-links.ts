/**
 * Externally-owned console/docs URLs surfaced in the UI (ADR-042). Centralized
 * so a dead link is fixed in one place. Open via tauri-plugin-opener `openUrl`
 * (system browser), never a bare `<a href>` (webview would navigate in place).
 */
export const EXTERNAL_LINKS = {
  /** Tavily console — sign-up grants a recurring 1,000 searches/month free tier. */
  tavilyConsole: "https://app.tavily.com",
  /** Aliyun IQS console API-key page — key ≠ DashScope key; new keys take ~5 min to activate. */
  aliyunIqsKeys: "https://iqs.console.aliyun.com/api-keys",
  /** Aliyun DashScope (百炼) API-key page — used by model-native `enable_search`. */
  dashscopeKeys: "https://bailian.console.aliyun.com/?tab=model#/api-key",
} as const
