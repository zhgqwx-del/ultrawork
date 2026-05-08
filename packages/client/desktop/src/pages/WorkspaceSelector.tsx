import { useNavigate } from "react-router-dom"
import { open } from "@tauri-apps/plugin-dialog"
import { FolderOpen, Check, X, FolderPlus } from "lucide-react"
import { useWorkspace } from "@/lib/workspace-context"
import { useI18n } from "@/lib/i18n-context"
import { DragRegion } from "@/components/layout/drag-region"

export function WorkspaceSelectorPage() {
  const navigate = useNavigate()
  const { lastPath, recentPaths, setWorkspace, removeRecent } = useWorkspace()
  const { t } = useI18n()

  const handleContinue = () => {
    if (lastPath) {
      setWorkspace(lastPath)
      navigate("/")
    }
  }

  const handleSelectFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false })
      if (selected && typeof selected === "string") {
        setWorkspace(selected)
        navigate("/")
      }
    } catch (err) {
      console.error("Failed to open folder dialog:", err)
    }
  }

  const handlePickRecent = (path: string) => {
    setWorkspace(path)
    navigate("/")
  }

  // Filter recent list: exclude current path (shown separately in "continue" section)
  const otherRecent = recentPaths.filter((p) => p !== lastPath)

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-[var(--color-bg)] px-4">
      <DragRegion />
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        {/* Header */}
        <div className="space-y-2 text-center">
          <FolderOpen className="mx-auto size-10 text-[var(--color-brand)]" />
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">
            {t("workspace.selectTitle")}
          </h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            {t("workspace.selectSubtitle")}
          </p>
        </div>

        {/* Current workspace — continue button */}
        {lastPath && (
          <div className="w-full rounded-xl border border-[var(--color-brand)] bg-[var(--color-bg-subtle)] p-4">
            <p className="mb-1 text-xs text-[var(--color-fg-muted)]">{t("workspace.current")}</p>
            <p className="mb-3 truncate text-sm font-medium text-[var(--color-fg)]" title={lastPath}>
              {lastPath}
            </p>
            <button
              onClick={handleContinue}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              <Check className="size-4" />
              {t("workspace.continue")}
            </button>
          </div>
        )}

        {/* Recent workspaces */}
        {otherRecent.length > 0 && (
          <div className="w-full">
            <p className="mb-2 text-xs font-medium text-[var(--color-fg-muted)]">
              {t("workspace.recent")}
            </p>
            <div className="space-y-1">
              {otherRecent.map((path) => (
                <div
                  key={path}
                  className="group flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 transition-colors hover:border-[var(--color-brand)] hover:bg-[var(--color-bg-subtle)]"
                >
                  <FolderOpen className="size-4 shrink-0 text-[var(--color-fg-muted)]" />
                  <button
                    onClick={() => handlePickRecent(path)}
                    className="min-w-0 flex-1 truncate text-left text-sm text-[var(--color-fg)]"
                    title={path}
                  >
                    {path}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeRecent(path) }}
                    className="shrink-0 rounded p-0.5 text-[var(--color-fg-muted)] opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                    aria-label={t("workspace.removeRecent")}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Select new folder */}
        <button
          onClick={handleSelectFolder}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-brand)] hover:text-[var(--color-fg)]"
        >
          <FolderPlus className="size-4" />
          {t("workspace.selectNew")}
        </button>
      </div>
    </div>
  )
}
