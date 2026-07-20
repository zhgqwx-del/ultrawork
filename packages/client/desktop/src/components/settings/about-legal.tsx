import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, ExternalLink, Loader2, Search, ChevronDown, ChevronRight, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MarkdownContent } from "@/components/chat/message-parts"
import { useI18n } from "@/lib/i18n-context"
import { openExternal } from "@/lib/external-url"
import { cn } from "@/lib/utils"

// Shapes mirror scripts/gen-notices.ts output. Data is dynamic-imported so none
// of it lands in the startup bundle (the generated JSON is large: ~3.7k rows).
type OssComponent = {
  id: number
  name: string
  version: string
  license: string
  modified: boolean
  source: "npm" | "opencode" | "cargo" | "vendored"
  url: string
}
type LicensesFile = {
  generatedAt: string
  counts: { npm: number; opencode: number; cargo: number; vendored: number; total: number; withText: number }
  components: OssComponent[]
}

const PAGE = 50

/** A back header shared by every About sub-view (独立整页体验). */
function SubViewHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { t } = useI18n()
  return (
    <div className="mb-4 flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
      >
        <ArrowLeft className="size-4" />
        {t("about.back")}
      </button>
      <h2 className="text-lg font-semibold text-[var(--color-fg)]">{title}</h2>
    </div>
  )
}

export function OssLicensesView({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [data, setData] = useState<LicensesFile | null>(null)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState("")
  const [source, setSource] = useState<"all" | OssComponent["source"]>("all")
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [texts, setTexts] = useState<Record<number, string> | null>(null)

  useEffect(() => {
    let alive = true
    import("@/generated/licenses.json")
      .then((m) => alive && setData(m.default as LicensesFile))
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    const bySource = source === "all" ? data.components : data.components.filter((c) => c.source === source)
    if (!q) return bySource
    return bySource.filter(
      (c) => c.name.toLowerCase().includes(q) || c.license.toLowerCase().includes(q) || c.source.includes(q),
    )
  }, [data, query, source])

  // License texts are ~2.6MB — only fetch them the first time a row is expanded.
  const toggleExpand = (id: number) => {
    setExpanded((cur) => (cur === id ? null : id))
    if (!texts) {
      import("@/generated/license-texts.json")
        .then((m) => setTexts(m.default as Record<number, string>))
        .catch(() => setTexts({}))
    }
  }

  const sourceLabel = (s: OssComponent["source"]) => t(`about.oss.source.${s}`)

  if (error) {
    return (
      <div>
        <SubViewHeader title={t("about.legal.thirdParty")} onBack={onBack} />
        <p className="text-sm text-[var(--color-fg-muted)]">{t("about.oss.loadError")}</p>
      </div>
    )
  }
  if (!data) {
    return (
      <div>
        <SubViewHeader title={t("about.legal.thirdParty")} onBack={onBack} />
        <div className="flex items-center gap-2 py-12 text-sm text-[var(--color-fg-muted)]">
          <Loader2 className="size-4 animate-spin" />
          {t("about.oss.loading")}
        </div>
      </div>
    )
  }

  // Classic pagination: bounded DOM (~PAGE rows) and bounded page height —
  // preferred over infinite "load more" for a 3.7k-row compliance list.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE))
  const safePage = Math.min(page, pageCount - 1)
  const from = filtered.length === 0 ? 0 : safePage * PAGE + 1
  const to = Math.min((safePage + 1) * PAGE, filtered.length)
  const shown = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE)
  const goTo = (p: number) => {
    setPage(Math.max(0, Math.min(pageCount - 1, p)))
    setExpanded(null)
  }

  return (
    <div>
      <SubViewHeader title={t("about.legal.thirdParty")} onBack={onBack} />

      <p className="mb-3 text-sm text-[var(--color-fg-muted)]">
        {t("about.oss.desc")
          .replace("{total}", String(data.counts.total))
          .replace("{npm}", String(data.counts.npm))
          .replace("{opencode}", String(data.counts.opencode))
          .replace("{cargo}", String(data.counts.cargo))}
      </p>

      {/* Source filter chips — narrow the (long) list by origin. NOTICES.txt
          always keeps the full set; this only scopes the on-screen table. */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {([
          { key: "all", label: t("about.oss.filterAll"), count: data.counts.total },
          { key: "npm", label: t("about.oss.source.npm"), count: data.counts.npm },
          { key: "opencode", label: t("about.oss.source.opencode"), count: data.counts.opencode },
          { key: "cargo", label: t("about.oss.source.cargo"), count: data.counts.cargo },
          { key: "vendored", label: t("about.oss.source.vendored"), count: data.counts.vendored },
        ] as const).map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => {
              setSource(f.key)
              setPage(0)
              setExpanded(null)
            }}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              source === f.key
                ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)]",
            )}
          >
            {f.label} <span className="opacity-60">{f.count}</span>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-muted)]" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
              setExpanded(null)
            }}
            placeholder={t("about.oss.searchPlaceholder")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-2 pl-8 pr-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
        </div>
        <span className="shrink-0 text-xs text-[var(--color-fg-muted)]">
          {t("about.oss.count").replace("{from}", String(from)).replace("{to}", String(to)).replace("{total}", String(filtered.length))}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
        {/* header row */}
        <div className="grid grid-cols-[3rem_1fr_9rem_5rem_2.5rem] gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]">
          <span>{t("about.oss.colIndex")}</span>
          <span>{t("about.oss.colName")}</span>
          <span>{t("about.oss.colLicense")}</span>
          <span>{t("about.oss.colModified")}</span>
          <span className="text-right">{t("about.oss.colLink")}</span>
        </div>
        {shown.map((c) => {
          const isOpen = expanded === c.id
          return (
            <div key={c.id} className="border-b border-[var(--color-border)] last:border-b-0">
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggleExpand(c.id)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleExpand(c.id))}
                className="grid cursor-pointer grid-cols-[3rem_1fr_9rem_5rem_2.5rem] items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-accent)]"
              >
                <span className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
                  {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  {c.id}
                </span>
                <span className="min-w-0">
                  <span className="break-all font-medium text-[var(--color-fg)]">{c.name}</span>
                  <span className="ml-1 text-xs text-[var(--color-fg-muted)]">{c.version}</span>
                  <span className="ml-2 rounded bg-[var(--color-accent)] px-1 py-px text-[10px] text-[var(--color-fg-muted)]">
                    {sourceLabel(c.source)}
                  </span>
                </span>
                <span className="truncate text-xs text-[var(--color-fg)]" title={c.license}>
                  {c.license}
                </span>
                <span className="text-xs">
                  {c.modified ? (
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">
                      {t("about.oss.modifiedYes")}
                    </span>
                  ) : (
                    <span className="text-[var(--color-fg-muted)]">{t("about.oss.modifiedNo")}</span>
                  )}
                </span>
                <button
                  type="button"
                  title={c.url}
                  onClick={(e) => {
                    e.stopPropagation()
                    openExternal(c.url)
                  }}
                  className="justify-self-end rounded p-1 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
                >
                  <ExternalLink className="size-3.5" />
                </button>
              </div>
              {isOpen && (
                <div className="bg-[var(--color-bg-subtle)] px-3 py-3">
                  {!texts ? (
                    <div className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
                      <Loader2 className="size-3 animate-spin" />
                      {t("about.oss.loading")}
                    </div>
                  ) : texts[c.id] ? (
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                      {texts[c.id]}
                    </pre>
                  ) : (
                    <p className="text-xs text-[var(--color-fg-muted)]">
                      {t("about.oss.noText")}{" "}
                      <button type="button" onClick={() => openExternal(c.url)} className="text-[var(--color-primary)] hover:underline">
                        {c.url}
                      </button>
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {shown.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-[var(--color-fg-muted)]">{t("about.oss.noResults")}</div>
        )}
      </div>

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={safePage === 0} onClick={() => goTo(safePage - 1)}>
            {t("about.oss.prev")}
          </Button>
          <span className="text-xs text-[var(--color-fg-muted)]">
            {t("about.oss.page").replace("{page}", String(safePage + 1)).replace("{total}", String(pageCount))}
          </span>
          <Button variant="outline" size="sm" disabled={safePage >= pageCount - 1} onClick={() => goTo(safePage + 1)}>
            {t("about.oss.next")}
          </Button>
        </div>
      )}
    </div>
  )
}

export function LegalDocView({ doc, onBack }: { doc: "eula" | "privacy"; onBack: () => void }) {
  const { t } = useI18n()
  const [md, setMd] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    import("@/generated/legal.json")
      .then((m) => {
        if (!alive) return
        const data = m.default as { eula: string; privacy: string }
        setMd(data[doc] || "")
      })
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [doc])

  const title = doc === "eula" ? t("about.legal.terms") : t("about.legal.privacy")
  // Self-cleaning draft banner: the generated docs still carry 【】 placeholders
  // until a real entity fills them; show the notice only while any remain.
  const isDraft = !!md && md.includes("【")

  return (
    <div>
      <SubViewHeader title={title} onBack={onBack} />
      {error ? (
        <p className="text-sm text-[var(--color-fg-muted)]">{t("about.oss.loadError")}</p>
      ) : md === null ? (
        <div className="flex items-center gap-2 py-12 text-sm text-[var(--color-fg-muted)]">
          <Loader2 className="size-4 animate-spin" />
          {t("about.oss.loading")}
        </div>
      ) : (
        <>
          {isDraft && (
            <div className="mb-4 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <FileText className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("about.legal.draftNotice")}</span>
            </div>
          )}
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
            <MarkdownContent text={md} />
          </div>
        </>
      )}
    </div>
  )
}

/** Small helper: a labelled entry button used on the About root. */
export function LegalEntryButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof FileText
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-fg)] transition-colors hover:bg-[var(--color-accent)]"
    >
      <Icon className="size-3.5" />
      {label}
      <ChevronRight className="size-3 text-[var(--color-fg-muted)]" />
    </button>
  )
}
