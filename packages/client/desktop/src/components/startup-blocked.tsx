import { useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Logo } from "./ui/logo"
import type { StartupStatus } from "@/lib/startup-gate"
import { APP_BRAND } from "@/lib/brand"

// This screen intentionally has no business/config providers. Even a persisted
// theme setting must not cause a failed ownership check to create credentials.
const COPY = {
  en: { title: "Unable to start", hint: "Close the other instance or correct the reported configuration, then restart the app. Your data has not been reset.", copy: "Copy diagnostics", copied: "Copied", retry: "Check again", exit: "Quit", copyFailed: "Could not copy. Select the diagnostic text below." },
  zh: { title: "无法启动", hint: "请退出另一个实例或修正提示的配置后，重新启动应用。应用不会重置你的数据。", copy: "复制诊断", copied: "已复制", retry: "重新检查", exit: "退出", copyFailed: "复制失败，可选中下方诊断文本复制。" },
  hant: { title: "無法啟動", hint: "請退出另一個執行個體或修正提示的設定後，重新啟動應用程式。應用程式不會重設你的資料。", copy: "複製診斷", copied: "已複製", retry: "重新檢查", exit: "退出", copyFailed: "複製失敗，可選取下方診斷文字複製。" },
}

export function StartupBlocked({ status }: { status: StartupStatus }) {
  const locale = navigator.language?.toLowerCase() ?? "en"
  const copy = !locale.startsWith("zh") ? COPY.en : /hant|tw|hk|mo/.test(locale) ? COPY.hant : COPY.zh
  const [feedback, setFeedback] = useState("")
  const [checking, setChecking] = useState(false)
  const diagnostic = JSON.stringify({
    brandId: APP_BRAND.brandId,
    productName: APP_BRAND.productName,
    identifier: APP_BRAND.identifier,
    reason: status.reason,
    paths: status.paths,
  }, null, 2)

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] p-8 text-[var(--color-fg)]">
      <section className="w-full max-w-2xl space-y-5" role="alert">
        <div className="flex items-center gap-3"><Logo className="size-10" /><h1 className="text-xl font-semibold">{APP_BRAND.productName} · {copy.title}</h1></div>
        <p className="text-sm text-[var(--color-fg-muted)]">{copy.hint}</p>
        <pre className="max-h-80 select-text overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border)] p-4 text-xs">{diagnostic}</pre>
        <div className="flex flex-wrap gap-3 text-sm">
          <button className="rounded-md border border-[var(--color-border)] px-3 py-2" onClick={() => {
            if (!navigator.clipboard?.writeText) { setFeedback(copy.copyFailed); return }
            void navigator.clipboard.writeText(diagnostic).then(() => setFeedback(copy.copied)).catch(() => setFeedback(copy.copyFailed))
          }}>{copy.copy}</button>
          <button disabled={checking} className="rounded-md border border-[var(--color-border)] px-3 py-2 disabled:opacity-50" onClick={() => {
            setChecking(true)
            void invoke("retry_startup").then(() => window.location.reload()).catch((error) => setFeedback(String(error))).finally(() => setChecking(false))
          }}>{copy.retry}</button>
          <button className="rounded-md border border-[var(--color-border)] px-3 py-2" onClick={() => { void invoke("exit_startup_blocked").catch((error) => setFeedback(String(error))) }}>{copy.exit}</button>
        </div>
        {feedback && <p className="text-sm" aria-live="polite">{feedback}</p>}
      </section>
    </main>
  )
}
