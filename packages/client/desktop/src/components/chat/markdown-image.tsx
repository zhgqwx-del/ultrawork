import { createContext, useContext, useEffect, useState } from "react"
import { FileText, ImageOff } from "lucide-react"
import type { Artifact } from "@/components/session/artifact-preview"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import { toWorkspaceRelative, pathBasename } from "@/lib/path-utils"

/**
 * Inline images in an assistant reply (`![alt](src)`).
 *
 * Why this exists: qwen (a text model) "draws" by writing an SVG/PNG into the
 * workspace, then references it from the reply with a markdown image whose `src`
 * is a LOCAL path — absolute (`/Users/…/workspace/octopus.svg`) or a bare
 * filename (`orca_preview.png`). react-markdown's default `img` renders a raw
 * `<img src="/Users/…">`, which the WebView resolves against its own origin
 * (Vite `localhost:1420` / `tauri://`) → 404 → a broken-image glyph. See
 * discussions/049 / ADR-065.
 *
 * Resolution by `src` scheme:
 *  - `data:` / `http(s)://`  → pass straight to a native <img> (base64 + remote
 *    images already load fine; they were never the broken case).
 *  - local path              → fetch via `getFileContent` (workspace-relative;
 *    absolute paths are stripped to relative first — the endpoint only reads
 *    inside the project dir) and render as a `data:` URI, the same channel the
 *    artifact preview uses.
 *  - outside workspace / unresolvable / non-image → a click-to-open fallback
 *    chip instead of a broken glyph.
 */
export interface MarkdownImageCtx {
  /** Workspace root — resolves the model's local image paths. Absent (e.g. the
   *  legal-docs viewer) → local resolution is disabled and alt text is shown. */
  workspaceDir?: string
  /** Opens the artifact preview (click-to-zoom, and the fallback affordance). */
  onArtifactClick?: (artifact: Artifact) => void
}

export const MarkdownImageContext = createContext<MarkdownImageCtx>({})

/**
 * Resolved data URIs keyed by `${dir}|${rel}`. A rendered PNG can be ~600KB of
 * base64; without this, every token during streaming (each of which re-renders
 * the answer markdown) would refetch and re-encode it. Session-scoped growth is
 * acceptable for the number of images one conversation produces.
 */
const dataUriCache = new Map<string, string>()

/** Exposed for tests to assert cache behaviour. */
export function __clearMarkdownImageCache() {
  dataUriCache.clear()
}

type Scheme = "data" | "http" | "local" | "blocked"

function classify(src: string): Scheme {
  if (/^data:image\//i.test(src)) return "data" // only image data URIs pass through
  if (/^https?:\/\//i.test(src)) return "http"
  // A Windows drive path (C:\… / C:/…) is LOCAL, not a scheme — must be checked
  // BEFORE the generic scheme guard, since "C:" otherwise matches `[a-z]:`.
  if (/^[A-Za-z]:[\\/]/.test(src)) return "local"
  if (/^file:/i.test(src)) return "local"
  // Any other explicit scheme (javascript:, vbscript:, data:text/html, …) is
  // refused — mirrors MarkdownLink's posture toward model-supplied content.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return "blocked"
  return "local" // relative or POSIX-absolute path
}

/**
 * A markdown `src` → the local filesystem path it means.
 *
 * Two steps, both mandatory:
 *  1. `file:///Users/x/a.svg` → `/Users/x/a.svg` (drop scheme + optional host).
 *  2. **Decode ONE layer of percent-encoding.** mdast-util-to-hast's image
 *     handler is `{src: normalizeUri(node.url)}` — by the time this component
 *     sees it, `输出/page-001.png` has become `%E8%BE%93%E5%87%BA/page-001.png`.
 *     Feeding that to the file endpoint (which encodes again) asks for a file
 *     whose name literally contains `%E8…`, and prefix-matching it against the
 *     workspace root fails outright when the WORKSPACE name is non-ASCII.
 *     ⇒ every inline image under a Chinese path silently fell back to a chip
 *     (2026-08-15 L4: measured 3 broken, the only working one was pure ASCII).
 *
 * Decoding is the exact inverse: a filename with a literal `%` arrives as `%25`,
 * so one decode restores it. `classify()` runs on the RAW src on purpose — a
 * name containing an encoded colon (`a%3Ab.png`) must not read as a URL scheme.
 */
function toLocalPath(src: string): string {
  const m = src.match(/^file:\/\/(?:localhost)?(\/.*)$/i)
  const raw = m ? m[1] : src
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw // malformed escapes (a bare `%`): use it as written
  }
}

function InlineImg({ src, alt, onClick }: { src: string; alt?: string; onClick?: () => void }) {
  return (
    <img
      src={src}
      alt={alt ?? ""}
      title={alt || undefined}
      loading="lazy"
      onClick={onClick}
      // No border/background frame: it hugs the <img> box (= the SVG's own
      // canvas, which often has internal padding around the drawing), so a frame
      // reads as "bigger than the image". Render the image frameless, like most
      // chat UIs. `h-auto` keeps aspect ratio while capping height/width.
      className={cn(
        "my-2 h-auto max-h-[70vh] max-w-full rounded-md",
        onClick && "cursor-zoom-in",
      )}
    />
  )
}

/**
 * Why an inline image did not render. All three used to look IDENTICAL — the
 * same grey `ImageOff` chip with the same text — which is exactly why telling
 * "the file is outside the workspace" from "this is a PDF, not an image" took a
 * full investigation round (059 §十七/§十九). The chip now says which one it is.
 */
export type FallbackKind = "outside" | "unreadable" | "document" | "blocked"

/** Extensions the artifact preview can do something useful with (pdf/html render). */
const DOCUMENT_RE = /\.(pdf|docx?|xlsx?|pptx?|csv|html?)$/i

function ImageFallback({
  alt,
  label,
  kind,
  reason,
  onClick,
}: {
  alt?: string
  label?: string
  kind: FallbackKind
  reason?: string
  onClick?: () => void
}) {
  const text = alt || label || "image"
  const Icon = kind === "document" ? FileText : ImageOff
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      data-testid="markdown-image-fallback"
      data-fallback-kind={kind}
      // The title carries BOTH, because the reason is what the name cannot say.
      title={reason ? `${label || alt || ""} — ${reason}` : label || alt}
      className={cn(
        "my-1.5 inline-flex max-w-[320px] items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-1.5 text-xs align-middle",
        onClick
          ? "cursor-pointer hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-accent)]"
          : "cursor-default",
      )}
    >
      <Icon className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
      <span className="min-w-0 truncate text-[var(--color-fg)]">{text}</span>
      {reason && <span className="shrink-0 text-[var(--color-fg-muted)]">· {reason}</span>}
    </button>
  )
}

export function MarkdownImage({ src = "", alt }: { src?: string; alt?: string }) {
  const ctx = useContext(MarkdownImageContext)
  const api = useApi()
  const { t } = useI18n()

  const scheme = classify(src)
  const passthrough = scheme === "data" || scheme === "http"
  // Only local paths WITH a workspace context are resolvable; `null` otherwise.
  const rel =
    scheme === "local" && ctx.workspaceDir ? toWorkspaceRelative(toLocalPath(src), ctx.workspaceDir) : null
  const cacheKey = rel ? `${ctx.workspaceDir}|${rel}` : null

  // Hooks run unconditionally (scheme can change across streaming re-renders, so
  // the branches below must never gate a hook). The effect no-ops unless there
  // is a resolvable local path.
  const [resolved, setResolved] = useState<{ uri?: string; error?: boolean }>(() =>
    cacheKey && dataUriCache.has(cacheKey) ? { uri: dataUriCache.get(cacheKey) } : {},
  )

  useEffect(() => {
    if (!cacheKey || !rel) return
    if (dataUriCache.has(cacheKey)) {
      setResolved({ uri: dataUriCache.get(cacheKey) })
      return
    }
    let cancelled = false
    setResolved({})
    api
      .getFileContent(rel)
      .then((r) => {
        if (cancelled) return
        if (r.content && r.mimeType && r.mimeType.startsWith("image/")) {
          const uri = `data:${r.mimeType};base64,${r.content}`
          dataUriCache.set(cacheKey, uri)
          setResolved({ uri })
        } else {
          setResolved({ error: true })
        }
      })
      .catch(() => {
        if (!cancelled) setResolved({ error: true })
      })
    return () => {
      cancelled = true
    }
  }, [cacheKey, rel, api])

  // 1) Remote / base64 → native <img>.
  if (passthrough) return <InlineImg src={src} alt={alt} />

  // 2) Resolvable local path.
  if (rel) {
    const openPreview = ctx.onArtifactClick ? () => ctx.onArtifactClick!({ type: "file", path: rel }) : undefined
    if (resolved.uri) return <InlineImg src={resolved.uri} alt={alt} onClick={openPreview} />
    if (resolved.error) {
      // The file endpoint answers `{content: ""}` for BOTH "not an image" (it
      // only serves text + images; a PDF comes back empty) and "no such file",
      // so the response cannot tell them apart — the extension can. A PDF is a
      // FILE the preview panel renders properly, not a broken image; saying so
      // (and keeping the chip clickable) is the whole difference for the user.
      const doc = DOCUMENT_RE.test(rel)
      return (
        <ImageFallback
          alt={alt}
          label={pathBasename(rel)}
          kind={doc ? "document" : "unreadable"}
          reason={doc ? t("message.imageNotAnImage") : t("message.imageUnreadable")}
          onClick={openPreview}
        />
      )
    }
    // Loading (or a still-incomplete src mid-stream) → light alt placeholder,
    // never a broken glyph. Re-resolves automatically when `cacheKey` changes.
    return <span className="text-sm text-[var(--color-fg-muted)]">{alt || "…"}</span>
  }

  // 3) Non-resolvable. Two different things that used to look the same: a local
  //    path that lands OUTSIDE the workspace (the file endpoint only reads
  //    inside it, so this can never be shown — say that), and a blocked scheme.
  const outside = scheme === "local" && !!ctx.workspaceDir
  return (
    <ImageFallback
      alt={alt}
      label={src}
      kind={outside ? "outside" : "blocked"}
      reason={outside ? t("message.imageOutsideWorkspace") : undefined}
    />
  )
}
