import { Loader2, Sparkles } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useI18n } from "@/lib/i18n-context"

interface FreeTrialConsentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** User opted in — seed a free model and proceed. */
  onEnable: () => void
  /** User chose to configure their own provider instead. */
  onUseOwnKey: () => void
  /** Seeding in progress (network round-trip to the gateway). */
  busy?: boolean
}

/**
 * First-run consent card (ADR-057 P3). Shown when the only usable models are free OpenCode Zen
 * models and the user tries to send without having opted in. Nothing is dispatched to the
 * gateway until the user explicitly enables the trial — privacy is opt-in (default off).
 */
export function FreeTrialConsentDialog({
  open,
  onOpenChange,
  onEnable,
  onUseOwnKey,
  busy,
}: FreeTrialConsentDialogProps) {
  const { t } = useI18n()

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-[var(--color-brand)]" />
            {t("freeTrial.title")}
          </DialogTitle>
          <DialogDescription>{t("freeTrial.body")}</DialogDescription>
        </DialogHeader>

        {/* Privacy disclosure — the whole reason this is opt-in. */}
        <p className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
          {t("freeTrial.privacy")}
        </p>

        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            onClick={onEnable}
            disabled={busy}
            className="flex items-center justify-center gap-2 rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? t("freeTrial.enabling") : t("freeTrial.enable")}
          </button>
          <button
            type="button"
            onClick={onUseOwnKey}
            disabled={busy}
            className="rounded-md px-4 py-2 text-sm text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] disabled:opacity-60"
          >
            {t("freeTrial.useOwnKey")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
